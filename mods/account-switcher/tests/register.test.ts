import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const CONFIG = `${HOME}/.claude.json`
const HOME_CREDS = `${HOME}/.claude/.credentials.json`
const ACCOUNTS = `${HOME}/.claude/accounts`
const WORK = `${ACCOUNTS}/a_org-a`
const KEYS = `${HOME}/.claude/keybindings.json`
const PENDING_CREDS = `${ACCOUNTS}/.pending/.credentials.json`

type On = Parameters<Parameters<typeof test>[1]>[1]

const BOB = { accountUuid: 'b', emailAddress: 'bob@x.com', organizationUuid: 'org-b' }
const ALICE = { accountUuid: 'a', emailAddress: 'alice@x.com', organizationUuid: 'org-a', organizationName: 'Acme' }
const CAROL = { accountUuid: 'c', emailAddress: 'carol@x.com', organizationUuid: 'org-c' }

function creds(refresh: string, plan = 'max'): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `at-${refresh}`, refreshToken: refresh, expiresAt: 9e12, subscriptionType: plan } })
}

function machine(): Map<string, string> {
  return new Map([
    [CONFIG, JSON.stringify({ numStartups: 1, oauthAccount: BOB })],
    [HOME_CREDS, creds('rt-b', 'pro')],
    [`${WORK}/.credentials.json`, creds('rt-a')],
    [`${WORK}/account.json`, JSON.stringify({ label: 'Work', oauthAccount: ALICE })],
  ])
}

// Answers $.fs, $.process, $.env and $.store from memory.
function stub(on: On, files: Map<string, string>, opts: { env?: Record<string, string>; logs?: string[]; store?: Map<string, unknown> } = {}) {
  const dirs = new Set<string>()
  const env = new Map(Object.entries({ HOME, ...opts.env }))
  const store = opts.store ?? new Map<string, unknown>()
  const logs = opts.logs ?? []
  const children = (path: string) => [...files.keys()].filter(p => p.startsWith(`${path}/`))

  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || dirs.has(e.path) || children(e.path).length > 0 }))
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) as string } : { deny: 'missing' }))
  on('fs.list', ($, e) => ({
    value: [...new Set(children(e.path).map(p => p.slice(e.path.length + 1).split('/')[0]))].map(name => ({
      name,
      kind: 'file' as const,
      size: 0,
      isLink: false,
    })),
  }))
  on('fs.stat', () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }))
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    const path = args[args.length - 1]
    if (cmd === 'sh') files.set(path, e.init?.stdin ?? '')
    if (cmd === 'rm') for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p)
    if (cmd === 'mkdir') {
      if (dirs.has(path)) return { value: { exitCode: 1, stdout: '', stderr: 'exists' } }
      dirs.add(path)
    }
    if (cmd === 'rmdir') dirs.delete(path)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('env.get', ($, e) => ({ value: env.get(e.name) }))
  on('env.set', ($, e) => {
    if (e.value === undefined) env.delete(e.name)
    else env.set(e.name, e.value)
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  return { env, store, logs, clock }
}

const INSTALLED = [
  { context: 'Global', bindings: { 'ctrl+alt+shift+-': 'app:toggleDiffPreSession' } },
  { context: 'Pane', bindings: { right: 'pane:pageDown', left: 'pane:pageUp' } },
]

const PANE_SITE = {
  plugin: 'account-switcher',
  component: 'Pane',
  requestId: 'accounts',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { title: 'Accounts', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const headless = { surface: null, isInteractive: false, cwd: '/work' } as const
const interactive = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

test('/account-switch list shows every account and which this session uses', async ($, on) => {
  stub(on, machine())

  await $.session.start(headless)
  const out = await $.command.run({ command: 'account-switch', args: 'list' })

  expect(out.text).toBe('1. bob@x.com  Pro  (this session, default)\n2. Work  alice@x.com · Max · Acme')
})

test('switching points only this session at the account', async ($, on) => {
  const files = machine()
  const { env } = stub(on, files)

  await $.session.start(headless)
  const out = await $.command.run({ command: 'account-switch', args: 'work' })

  expect(out.text).toBe('This session now uses Work. Other sessions keep their own account.')
  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
  expect(env.get('CLAUDE_CODE_ORGANIZATION_UUID')).toBe('org-a')
  expect(JSON.parse(files.get(HOME_CREDS) as string).claudeAiOauth.refreshToken).toBe('rt-b')
  expect(JSON.parse(files.get(CONFIG) as string).oauthAccount.emailAddress).toBe('alice@x.com')
})

test('switching back to the default account clears the override', async ($, on) => {
  const { env } = stub(on, machine())

  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: 'work' })
  const out = await $.command.run({ command: 'account-switch', args: '1' })

  expect(out.text).toMatch(/^This session now uses bob@x\.com\./)
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
})

test('switching to the account already in use changes nothing', async ($, on) => {
  const files = machine()
  stub(on, files)

  await $.session.start(headless)
  const before = files.get(CONFIG)
  const out = await $.command.run({ command: 'account-switch', args: 'bob' })

  expect(out.text).toBe('This session already uses bob@x.com.')
  expect(files.get(CONFIG)).toBe(before)
})

test('a resumed session goes back to the account it was using', async ($, on) => {
  const store = new Map<string, unknown>([['sessions', { 'session-1': WORK }]])
  const { env } = stub(on, machine(), { store })

  await $.session.start(headless)

  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
})

test('/status first points the shared account details at this session', async ($, on) => {
  const files = machine()
  const { clock } = stub(on, files, { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: WORK } })
  let seen = ''
  on('command.run', () => {
    seen = JSON.parse(files.get(CONFIG) as string).oauthAccount.emailAddress
    return { text: 'status' }
  })

  await $.session.start(headless)
  files.set(CONFIG, JSON.stringify({ numStartups: 1, oauthAccount: BOB }))
  const status = $.command.run({ command: 'status', args: '' })
  await clock.advance(2000)
  await status

  expect(seen).toBe('alice@x.com')
})

test('/login adds a new account and switches this session to it', async ($, on) => {
  const files = machine()
  const { env } = stub(on, files)
  on('command.run', ($, e) => {
    if (e.command === 'login') {
      files.set(PENDING_CREDS, creds('rt-c'))
      files.set(CONFIG, JSON.stringify({ numStartups: 1, oauthAccount: CAROL }))
    }
    return { text: 'Login successful' }
  })

  await $.session.start(headless)
  await $.command.run({ command: 'login', args: '' })

  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(`${ACCOUNTS}/c_org-c`)
  expect(JSON.parse(files.get(HOME_CREDS) as string).claudeAiOauth.refreshToken).toBe('rt-b')
  const list = await $.command.run({ command: 'account-switch', args: 'list' })
  expect(list.text).toMatch(/carol@x\.com  Max  \(this session\)/)
})

test('a cancelled /login puts the session back on its account', async ($, on) => {
  const files = machine()
  const { env } = stub(on, files, { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: WORK } })
  on('command.run', () => ({ text: 'Login interrupted' }))

  await $.session.start(headless)
  await $.command.run({ command: 'login', args: '' })

  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
  expect([...files.keys()].some(p => p.includes('.pending'))).toBe(false)
})

test('/logout asks first and can be cancelled', async ($, on) => {
  stub(on, machine())
  let loggedOut = false
  on('tool.call', ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Cancel' } } }))
  on('command.run', () => {
    loggedOut = true
    return { text: 'Logged out' }
  })

  await $.session.start(headless)
  const out = await $.command.run({ command: 'logout', args: '' })

  expect(out.text).toBe('Logout cancelled.')
  expect(loggedOut).toBe(false)
})

test('/logout of a saved account forgets it and returns the session to the default', async ($, on) => {
  const files = machine()
  const { env } = stub(on, files, { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: WORK } })
  on('tool.call', ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Log out' } } }))
  on('command.run', () => ({ text: 'Logged out' }))

  await $.session.start(headless)
  await $.command.run({ command: 'logout', args: '' })

  expect(files.has(`${WORK}/.credentials.json`)).toBe(false)
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
})

test('rename and forget', async ($, on) => {
  const files = machine()
  stub(on, files)

  await $.session.start(headless)
  expect((await $.command.run({ command: 'account-switch', args: 'rename work Day job' })).text).toBe('Renamed Work to Day job.')
  expect((await $.command.run({ command: 'account-switch', args: 'forget day' })).text).toMatch(/^Forgot Day job\./)
  expect(files.has(`${WORK}/account.json`)).toBe(false)
  expect((await $.command.run({ command: 'account-switch', args: 'forget bob' })).text).toMatch(/default login/)
})

test('an interactive session installs the shortcut once and respects keys off', async ($, on) => {
  const files = machine()
  const { logs, store } = stub(on, files)
  on('session.surfaces', () => ({ value: ['terminal'] }))

  await $.session.start(interactive)
  expect(logs[0]).toBe("Ctrl+Alt+Shift+numpad - opens the account sidebar, and Right and Left in it change Clawd's hat.")
  expect(JSON.parse(files.get(KEYS) as string).bindings).toEqual(INSTALLED)

  await $.command.run({ command: 'account-switch', args: 'keys off' })
  expect(JSON.parse(files.get(KEYS) as string).bindings).toEqual([])
  expect(store.get('keys-off')).toBe(true)
})

test('the Ctrl+Shift+- binding from version 0.2 moves to the new key', async ($, on) => {
  const files = machine()
  files.set(
    KEYS,
    JSON.stringify({
      bindings: [
        { context: 'Chat', bindings: { 'ctrl+shift+-': null, 'ctrl+_': null, 'ctrl+x ctrl+u': 'chat:undo' } },
        { context: 'Global', bindings: { 'ctrl+shift+-': 'app:toggleDiffPreSession', 'ctrl+_': 'app:toggleDiffPreSession' } },
      ],
    }),
  )
  const { logs } = stub(on, files)

  await $.session.start(interactive)

  expect(JSON.parse(files.get(KEYS) as string).bindings).toEqual(INSTALLED)
  expect(logs[0]).toMatch(/moved to Ctrl\+Alt\+Shift\+numpad -/)
})

test('an existing binding on the shortcut key is left alone', async ($, on) => {
  const files = machine()
  const mine = JSON.stringify({ bindings: [{ context: 'Global', bindings: { 'ctrl+alt+shift+-': 'app:toggleTodos' } }] })
  files.set(KEYS, mine)
  stub(on, files)

  await $.session.start(interactive)

  expect(files.get(KEYS)).toBe(mine)
})

test('a broken config reports an error instead of throwing', async ($, on) => {
  const files = machine()
  stub(on, files)
  files.set(CONFIG, '{not json')

  const out = await $.command.run({ command: 'account-switch', args: 'work' })

  expect(out.text).toMatch(/^Account switch failed: /)
})

test('the sidebar lists accounts, and pressing one switches this session', async ($, on) => {
  const { env } = stub(on, machine())
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))

  await $.session.start(headless)
  expect(await $.command.run({ command: 'account-switch', args: '' })).toEqual({})

  const ui = await $.ui.mount(PANE_SITE)
  expect(await ui.find({ type: 'Text', text: 'ACTIVE' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'SWITCH TO' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Work' })).toBeDefined()
  // Clawd's body rows are drawn beside every account.
  expect(await ui.find({ type: 'Text', text: '▝▜█████▛▘' })).toBeDefined()
  await ui.press({ key: 'use-a_org-a' })

  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
})

test('Right and Left over an account change its hat and keep it', async ($, on) => {
  const files = machine()
  stub(on, files)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))

  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: '' })
  await $.ui.focus({ component: 'Pane', requestId: 'accounts', element: 'use-a_org-a', origin: { kind: 'person' } })
  const page = { component: 'Pane', requestId: 'accounts', bodyRows: 30, contentRows: 40, offset: 30, origin: { kind: 'person' } } as const
  const right = await $.ui.scroll({ ...page, by: 30 })
  await $.ui.scroll({ ...page, by: 30 })
  await $.ui.scroll({ ...page, by: -30 })
  // A single-row scroll from the wheel or arrows still scrolls.
  const wheel = await $.ui.scroll({ ...page, by: 1 })

  expect(right.deny).toBe('changed the hat instead')
  expect(wheel.deny).toBeUndefined()
  expect(JSON.parse(files.get(`${WORK}/account.json`) as string).hat).toBe('top')
  const ui = await $.ui.mount(PANE_SITE)
  expect(await ui.find({ type: 'Text', text: 'Top hat · ←→ to change hat' })).toBeDefined()
})

test('/account-switch hat sets a hat by name', async ($, on) => {
  const files = machine()
  stub(on, files)

  await $.session.start(headless)
  const out = await $.command.run({ command: 'account-switch', args: 'hat work crown' })

  expect(out.text).toBe("Work's Clawd now wears: Crown.")
  expect(JSON.parse(files.get(`${WORK}/account.json`) as string).hat).toBe('crown')
})

test('the band names the session account and carries the shortcut action', async ($, on) => {
  stub(on, machine(), { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: WORK } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other mods'] }))
  on('ui.panes', () => ({ value: [] }))
  let opened = false
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true } }
  })

  await $.session.start(headless)
  const ui = await $.ui.mount({
    plugin: 'account-switcher',
    component: 'AbovePrompt',
    requestId: 'band',
    surface: 'terminal',
    viewport: { columns: 140, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
  const button = await ui.find({ key: 'account-switch' })
  expect(button?.props.label).toBe('Account: Work · Max')
  expect(button?.props.action).toBe('app:toggleDiffPreSession')
  await ui.press({ key: 'account-switch' })
  expect(opened).toBe(true)
})
