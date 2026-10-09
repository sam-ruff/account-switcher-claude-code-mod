import { expect, test } from 'claude-code/testing'
import {
  type Account,
  accountKey,
  bindsSwitchKey,
  type CredentialStore,
  hasHatBinding,
  hasOldBinding,
  hasSwitchBinding,
  matchAccount,
  resolvePaths,
  SWITCH_ACTION,
  SWITCH_KEY,
  withoutSwitchBinding,
  withSwitchBinding,
} from '../hooks/accounts.ts'
import { joiner } from '../hooks/platform.ts'
import { ALICE, BOB, creds, FakeIo, PATHS, storeFor } from './fake-io.ts'

const HOME_CREDS = `${PATHS.configDir}/.credentials.json`
const PENDING_CREDS = `${PATHS.accountsDir}/.pending/.credentials.json`

async function ready(io = FakeIo.twoAccounts(), credentials?: CredentialStore) {
  const s = storeFor(io, credentials)
  await s.learnHome()
  return { io, s }
}

test('resolvePaths follows Claude Code config locations', async () => {
  const paths = resolvePaths('/h', undefined, false)
  expect([paths.configDir, paths.globalConfig, paths.accountsDir]).toEqual(['/h/.claude', '/h/.claude.json', '/h/.claude/accounts'])
  expect(resolvePaths('/h', '/c', false).globalConfig).toBe('/c/.claude.json')
  expect(resolvePaths('/h', undefined, true).globalConfig).toBe('/h/.claude/.config.json')
})

test('resolvePaths uses backslashes on Windows', async () => {
  const paths = resolvePaths('C:\\Users\\sam', undefined, false, joiner('windows'))
  expect([paths.configDir, paths.globalConfig, paths.accountsDir]).toEqual([
    'C:\\Users\\sam\\.claude',
    'C:\\Users\\sam\\.claude.json',
    'C:\\Users\\sam\\.claude\\accounts',
  ])
})

test('hats are saved per account, the home one included', async () => {
  const { s } = await ready()
  const [home, work] = await s.list()

  await s.setHat(home, 'crown')
  await s.setHat(work, 'sunglasses')
  await s.rename((await s.list())[1], 'Day job')

  expect((await s.list()).map(a => [a.label, a.hat])).toEqual([
    [undefined, 'crown'],
    ['Day job', 'sunglasses'],
  ])
})

test('logins go through the injected credential store, as the macOS Keychain does', async () => {
  const keychain = new Map<string, Record<string, unknown>>()
  const store: CredentialStore = {
    read: async dir => keychain.get(dir) ?? null,
    write: async (dir, value) => {
      keychain.set(dir, value)
    },
    remove: async dir => {
      keychain.delete(dir)
    },
  }
  const io = new FakeIo()
  io.files.set(PATHS.globalConfig, JSON.stringify({ oauthAccount: BOB }))
  keychain.set(PATHS.configDir, JSON.parse(creds('rt-b')))
  const { s } = await ready(io, store)
  keychain.set(`${PATHS.accountsDir}/.pending`, JSON.parse(creds('rt-a')))

  const added = await s.adoptPending(ALICE)

  expect(added?.dir).toBe(`${PATHS.accountsDir}/a_org-a`)
  expect((keychain.get(added?.dir ?? '')?.claudeAiOauth as { refreshToken: string }).refreshToken).toBe('rt-a')
  expect(keychain.has(`${PATHS.accountsDir}/.pending`)).toBe(false)
  expect([...io.files.keys()].some(p => p.endsWith('.credentials.json'))).toBe(false)

  await s.forget(added as Account)
  expect(keychain.has(`${PATHS.accountsDir}/a_org-a`)).toBe(false)
})

test('list puts the home account first, then saved accounts', async () => {
  const { s } = await ready()

  const list = await s.list()

  expect(list.map(a => [a.label ?? a.oauthAccount.emailAddress, a.isHome, a.dir, a.plan])).toEqual([
    ['bob@x.com', true, PATHS.configDir, 'pro'],
    ['Work', false, `${PATHS.accountsDir}/a_org-a`, 'max'],
  ])
})

test('learnHome records the home account once, so later config changes do not move it', async () => {
  const { io, s } = await ready()
  await s.pointConfigAt(ALICE)
  await s.learnHome()

  expect((await s.list())[0].oauthAccount.emailAddress).toBe('bob@x.com')
  expect((io.json(PATHS.globalConfig).oauthAccount as { emailAddress: string }).emailAddress).toBe('alice@x.com')
})

test('learnHome does nothing when ~/.claude has no subscription login', async () => {
  const io = FakeIo.twoAccounts()
  io.files.delete(HOME_CREDS)
  const { s } = await ready(io)

  expect((await s.list()).map(a => a.isHome)).toEqual([false])
})

test('forSession finds the account by storage directory', async () => {
  const { s } = await ready()

  expect((await s.forSession(undefined))?.isHome).toBe(true)
  expect((await s.forSession(`${PATHS.accountsDir}/a_org-a`))?.label).toBe('Work')
  expect(await s.forSession('/elsewhere')).toBeUndefined()
})

test('a new login becomes its own account and leaves the home login alone', async () => {
  const { io, s } = await ready()
  const carol = { accountUuid: 'c', emailAddress: 'carol@x.com', organizationUuid: 'org-c' }
  io.files.set(PENDING_CREDS, creds('rt-c'))

  const added = await s.adoptPending(carol)

  expect(added?.dir).toBe(`${PATHS.accountsDir}/c_org-c`)
  expect(added?.isHome).toBe(false)
  expect((io.json(HOME_CREDS).claudeAiOauth as { refreshToken: string }).refreshToken).toBe('rt-b')
  expect(io.json(`${PATHS.accountsDir}/c_org-c/.credentials.json`).mcpOAuth).toEqual({ s: 1 })
  expect(io.files.has(PENDING_CREDS)).toBe(false)
})

test('logging in again to a saved account refreshes it and keeps its label', async () => {
  const { io, s } = await ready()
  io.files.set(PENDING_CREDS, creds('rt-a2'))

  const added = await s.adoptPending(ALICE)

  expect(added?.label).toBe('Work')
  expect((io.json(`${PATHS.accountsDir}/a_org-a/.credentials.json`).claudeAiOauth as { refreshToken: string }).refreshToken).toBe('rt-a2')
})

test('logging in again to the home account replaces the home login and keeps shared entries', async () => {
  const { io, s } = await ready()
  io.files.set(PENDING_CREDS, creds('rt-b2'))

  const added = await s.adoptPending(BOB)

  expect(added?.isHome).toBe(true)
  const home = io.json(HOME_CREDS)
  expect((home.claudeAiOauth as { refreshToken: string }).refreshToken).toBe('rt-b2')
  expect(home.mcpOAuth).toEqual({ s: 1 })
})

test('the first login on a machine becomes the home account', async () => {
  const io = new FakeIo()
  io.files.set(PATHS.globalConfig, JSON.stringify({ oauthAccount: BOB }))
  const { s } = await ready(io)
  io.files.set(PENDING_CREDS, creds('rt-b'))

  const added = await s.adoptPending(BOB)

  expect(added?.isHome).toBe(true)
  expect(io.files.has(HOME_CREDS)).toBe(true)
})

test('an unfinished login is discarded', async () => {
  const { io, s } = await ready()
  io.files.set(PENDING_CREDS, '{}')

  expect(await s.adoptPending(ALICE)).toBeUndefined()
  expect(io.files.has(PENDING_CREDS)).toBe(false)
  expect((await s.list()).length).toBe(2)
})

test('shareFromHome copies MCP logins into an account without overwriting its own', async () => {
  const { io, s } = await ready()
  const work = (await s.list())[1]

  await s.shareFromHome(work)
  await s.shareFromHome(work)

  const result = io.json(`${work.dir}/.credentials.json`)
  expect(result.mcpOAuth).toEqual({ s: 1 })
  expect((result.claudeAiOauth as { refreshToken: string }).refreshToken).toBe('rt-a')
  expect(io.dirs.size).toBe(0)
})

test('pointConfigAt swaps the account, clears per-account caches, and keeps the rest', async () => {
  const { io, s } = await ready()
  const config = io.json(PATHS.globalConfig)
  io.files.set(PATHS.globalConfig, JSON.stringify({ ...config, modelAccessCache: { x: 1 } }))

  expect(await s.pointConfigAt(ALICE)).toBe(true)
  expect(await s.pointConfigAt(ALICE)).toBe(false)
  expect(await s.pointConfigAt(ALICE, true)).toBe(true)

  const next = io.json(PATHS.globalConfig)
  expect((next.oauthAccount as { emailAddress: string }).emailAddress).toBe('alice@x.com')
  expect(next.modelAccessCache).toBeUndefined()
  expect(next.numStartups).toBe(3)
})

test('pointConfigAt keeps caches when the account does not change', async () => {
  const { io, s } = await ready()
  const config = io.json(PATHS.globalConfig)
  io.files.set(PATHS.globalConfig, JSON.stringify({ ...config, modelAccessCache: { x: 1 } }))

  await s.pointConfigAt(BOB, true)

  expect(io.json(PATHS.globalConfig).modelAccessCache).toEqual({ x: 1 })
})

test('pointConfigAt waits for a lock another process releases', async () => {
  const { io, s } = await ready()
  const lock = `${PATHS.globalConfig}.lock`
  io.dirs.set(lock, io.clock)
  const sleep = io.sleep
  io.sleep = async ms => {
    await sleep(ms)
    io.dirs.delete(lock)
  }

  await s.pointConfigAt(ALICE)

  expect(io.slept).toBe(100)
  expect(io.dirs.size).toBe(0)
})

test('pointConfigAt breaks a stale lock left by a crashed process', async () => {
  const { io, s } = await ready()
  io.dirs.set(`${PATHS.globalConfig}.lock`, io.clock - 60_000)

  await s.pointConfigAt(ALICE)

  expect(io.slept).toBe(0)
  expect(io.dirs.size).toBe(0)
})

test('pointConfigAt gives up on a live lock instead of breaking it', async () => {
  const { io, s } = await ready()
  io.dirs.set(`${PATHS.globalConfig}.lock`, io.clock)
  io.sleep = async ms => {
    io.slept += ms
  }

  let message = ''
  try {
    await s.pointConfigAt(ALICE)
  } catch (error) {
    message = (error as Error).message
  }

  expect(message).toMatch(/timed out waiting/)
  expect(io.dirs.size).toBe(1)
})

test('rename labels saved and home accounts, and an empty label clears it', async () => {
  const { s } = await ready()
  const [home, work] = await s.list()

  await s.rename(home, 'Personal')
  await s.rename(work, '  Day job ')
  expect((await s.list()).map(a => a.label)).toEqual(['Personal', 'Day job'])

  await s.rename((await s.list())[1], '')
  expect((await s.list())[1].label).toBeUndefined()
})

test('forget removes a saved account, and only the record of the home one', async () => {
  const { io, s } = await ready()
  const [home, work] = await s.list()

  await s.forget(work)
  expect(io.files.has(`${work.dir}/.credentials.json`)).toBe(false)

  await s.forget(home)
  expect(io.files.has(HOME_CREDS)).toBe(true)
  expect(await s.list()).toEqual([])
})

test('accounts whose login expired are marked', async () => {
  const io = FakeIo.twoAccounts()
  io.files.set(`${PATHS.accountsDir}/a_org-a/.credentials.json`, creds('rt-a', { refreshTokenExpiresAt: 1 }))
  const { s } = await ready(io)

  expect((await s.list()).map(a => a.needsLogin)).toEqual([false, true])
})

test('a corrupt saved entry does not hide the others', async () => {
  const io = FakeIo.twoAccounts()
  io.files.set(`${PATHS.accountsDir}/broken/account.json`, '{nope')
  const { s } = await ready(io)

  expect((await s.list()).length).toBe(2)
})

test('accountKey is filesystem safe', async () => {
  expect(accountKey({ accountUuid: 'a/../b', organizationUuid: 'o o' })).toBe('a----b_o-o')
  expect(accountKey({ accountUuid: 'a' })).toBe('a_personal')
})

test('matchAccount by number, exact name, prefix, home, and ambiguity', async () => {
  const make = (email: string, label?: string, isHome = false): Account => ({
    key: email,
    ...(label ? { label } : {}),
    oauthAccount: { accountUuid: email, emailAddress: email },
    dir: `/d/${email}`,
    isHome,
    needsLogin: false,
  })
  const accounts = [make('sam@home.com', undefined, true), make('sam@work.com', 'Work'), make('bob@x.com')]

  expect(matchAccount(accounts, '2')).toEqual({ kind: 'found', account: accounts[1] })
  expect(matchAccount(accounts, 'work')).toEqual({ kind: 'found', account: accounts[1] })
  expect(matchAccount(accounts, 'home')).toEqual({ kind: 'found', account: accounts[0] })
  expect(matchAccount(accounts, 'BOB')).toEqual({ kind: 'found', account: accounts[2] })
  expect(matchAccount(accounts, 'sam').kind).toBe('ambiguous')
  expect(matchAccount(accounts, 'carol').kind).toBe('none')
  expect(matchAccount(accounts, '9').kind).toBe('none')
})

test('the shortcut binding is added beside existing bindings and removed cleanly', async () => {
  const before = { $schema: 'x', bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } }] }

  const added = withSwitchBinding(before)
  expect(bindsSwitchKey(added)).toBe(true)
  expect(hasSwitchBinding(added)).toBe(true)
  expect(hasHatBinding(added)).toBe(true)
  expect(added.bindings).toEqual([
    { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } },
    { context: 'Global', bindings: { [SWITCH_KEY]: SWITCH_ACTION } },
    { context: 'Pane', bindings: { right: 'pane:pageDown', left: 'pane:pageUp' } },
  ])

  expect(withoutSwitchBinding(added)).toEqual(before)
  expect(bindsSwitchKey(before)).toBe(false)
})

test('the hat keys leave a Right or Left the user bound in panes alone', async () => {
  const mine = { bindings: [{ context: 'Pane', bindings: { right: 'pane:grow' } }] }

  const added = withSwitchBinding(mine)

  expect(added.bindings).toEqual([
    { context: 'Pane', bindings: { right: 'pane:grow', left: 'pane:pageUp' } },
    { context: 'Global', bindings: { [SWITCH_KEY]: SWITCH_ACTION } },
  ])
  expect(hasHatBinding(added)).toBe(false)
  expect(withoutSwitchBinding(added)).toEqual(mine)
})

test('the binding version 0.2 installed is replaced and undo gets its key back', async () => {
  const old = {
    bindings: [
      { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'ctrl+shift+-': null, 'ctrl+_': null, 'ctrl+x ctrl+u': 'chat:undo' } },
      { context: 'Global', bindings: { 'ctrl+shift+-': SWITCH_ACTION, 'ctrl+_': SWITCH_ACTION } },
    ],
  }

  expect(hasOldBinding(old)).toBe(true)
  expect(withSwitchBinding(old).bindings).toEqual([
    { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } },
    { context: 'Global', bindings: { [SWITCH_KEY]: SWITCH_ACTION } },
    { context: 'Pane', bindings: { right: 'pane:pageDown', left: 'pane:pageUp' } },
  ])
})
