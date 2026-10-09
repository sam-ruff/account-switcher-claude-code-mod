import { expect, test } from 'claude-code/testing'
import { CLAWD_ROWS, clawdRows, cycleHat, HATS, hatById } from '../hooks/clawd.ts'
import { detectStore, KeychainCredentials, serviceFor } from '../hooks/keychain.ts'
import { commandsFor, detectPlatform, homeDir, joiner } from '../hooks/platform.ts'

test('the platform is Windows only when APPDATA and USERPROFILE are both set', async () => {
  expect(detectPlatform({ appData: 'C:\\Users\\sam\\AppData\\Roaming', userProfile: 'C:\\Users\\sam' })).toBe('windows')
  expect(detectPlatform({})).toBe('posix')
  expect(detectPlatform({ userProfile: '/home/sam' })).toBe('posix')
})

test('the home directory is USERPROFILE on Windows and HOME elsewhere', async () => {
  expect(homeDir('windows', { home: '/c/Users/sam', userProfile: 'C:\\Users\\sam' })).toBe('C:\\Users\\sam')
  expect(homeDir('posix', { home: '/home/sam', userProfile: 'ignored' })).toBe('/home/sam')
})

test('paths join with each platform separator and no doubled separators', async () => {
  expect(joiner('windows')('C:\\Users\\sam\\', '.claude', 'accounts')).toBe('C:\\Users\\sam\\.claude\\accounts')
  expect(joiner('posix')('/home/sam/', '.claude')).toBe('/home/sam/.claude')
})

test('file paths reach commands as arguments, never inside a script', async () => {
  const tricky = 'C:\\Users\\o\'brien $(rm) ; x'
  for (const platform of ['windows', 'posix'] as const) {
    const c = commandsFor(platform)
    for (const argv of [c.writeSecret(tricky), c.removeTree(tricky), c.mkdir(tricky), c.rmdir(tricky), c.read(tricky)]) {
      expect(argv[argv.length - 1]).toBe(tricky)
      expect(argv.slice(0, -1).join(' ')).not.toContain(tricky)
    }
  }
})

test('Keychain item names match the ones Claude Code uses', async () => {
  expect(await serviceFor('/Users/sam/.claude', '/Users/sam/.claude')).toBe('Claude Code-credentials')
  // The first eight hex digits of sha256("/Users/sam/.claude/accounts/a_org-a").
  expect(await serviceFor('/Users/sam/.claude/accounts/a_org-a', '/Users/sam/.claude')).toBe('Claude Code-credentials-96c5bba1')
})

test('the Keychain store reads, writes with the secret on stdin, and deletes', async () => {
  const calls: { args: string[]; stdin?: string }[] = []
  const keychain = new KeychainCredentials(
    async (args, stdin) => {
      calls.push({ args, ...(stdin === undefined ? {} : { stdin }) })
      if (args[0] === 'find-generic-password') return { exitCode: 0, stdout: '{"claudeAiOauth":{"refreshToken":"r"}}\n' }
      return { exitCode: 0, stdout: '' }
    },
    'sam',
    '/Users/sam/.claude',
  )

  expect(await keychain.read('/Users/sam/.claude')).toEqual({ claudeAiOauth: { refreshToken: 'r' } })
  await keychain.write('/Users/sam/.claude', { a: 1 })
  await keychain.remove('/Users/sam/.claude')

  expect(calls[0].args).toEqual(['find-generic-password', '-a', 'sam', '-w', '-s', 'Claude Code-credentials'])
  expect(calls[1].args).toEqual(['-i'])
  expect(calls[1].stdin).toBe('add-generic-password -U -a "sam" -s "Claude Code-credentials" -X "7b2261223a317d"\n')
  expect(calls[2].args).toEqual(['delete-generic-password', '-a', 'sam', '-s', 'Claude Code-credentials'])
})

test('a missing Keychain item reads as no login', async () => {
  const keychain = new KeychainCredentials(async () => ({ exitCode: 44, stdout: '' }), 'sam', '/d')
  expect(await keychain.read('/d')).toBe(null)
})

test('the credentials file wins when it exists, and the Keychain is used only when it holds the login', async () => {
  const file = { read: async () => ({ claudeAiOauth: {} }), write: async () => {}, remove: async () => {} }
  const empty = { read: async () => null, write: async () => {}, remove: async () => {} }
  const keychain = { read: async () => ({ claudeAiOauth: {} }), write: async () => {}, remove: async () => {} }

  expect(await detectStore(file, keychain, '/d')).toBe(file)
  expect(await detectStore(empty, keychain, '/d')).toBe(keychain)
  expect(await detectStore(empty, empty, '/d')).toBe(empty)
  expect(await detectStore(empty, undefined, '/d')).toBe(empty)
})

test('every hat fits the nine cells above Clawd, and cycling wraps both ways', async () => {
  for (const hat of HATS) {
    for (const row of clawdRows(hat)) expect([...row.map(s => s.text).join('')].length).toBe(9)
  }
  expect(CLAWD_ROWS.length).toBe(3)
  expect(cycleHat('none', -1).id).toBe(HATS[HATS.length - 1].id)
  expect(cycleHat(HATS[HATS.length - 1].id, 1).id).toBe('none')
  expect(hatById('nonsense').id).toBe('none')
})
