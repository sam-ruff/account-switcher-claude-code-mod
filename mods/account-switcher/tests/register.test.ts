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
function stub(on: On, files: Map<string, string>, opts: { env?: Record<string, string>; logs?: string[]; store?: Map<string, unknown>; usageRead?: () => void } = {}) {
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
  on('http.fetch', () => { opts.usageRead?.(); return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ five_hour: { utilization: 36, resets_at: '2099-10-11T15:30:00Z' }, seven_day: { utilization: 72, resets_at: '2099-10-14T08:00:00Z' } }) } } })
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

function failures(on: On, rejectPrompt = false) {
  const prompts: string[] = []
  on('classic.StopFailure', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    if (rejectPrompt) return { drop: 'prompt queue unavailable' }
    prompts.push(e.text)
    return { text: e.text }
  })
  return prompts
}

async function failTurn($: Parameters<Parameters<typeof test>[1]>[0], clock: ReturnType<typeof mock.clock>, error: 'rate_limit' | 'billing_error' | 'overloaded' | 'server_error' | 'authentication_failed' | 'invalid_request' = 'rate_limit') {
  await $.classic.StopFailure({ error })
  const completed = $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 0, isAborted: false, reason: 'error' })
  await completed
  await clock.advance(2000)
}

test('auto-switch starts off and leaves budget failures alone', async ($, on) => {
  const { env, clock } = stub(on, machine())
  const prompts = failures(on)
  await $.session.start(headless)
  await failTurn($, clock)
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
  expect(prompts).toEqual([])
})

test('auto-switch tries every account once and stops when all are exhausted', async ($, on) => {
  const files = machine()
  const carol = `${ACCOUNTS}/c_org-c`
  files.set(`${carol}/.credentials.json`, creds('rt-c'))
  files.set(`${carol}/account.json`, JSON.stringify({ label: 'Other', oauthAccount: CAROL }))
  const { env, logs, clock } = stub(on, files)
  const prompts = failures(on)
  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: 'auto on' })
  await failTurn($, clock)
  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(carol)
  await failTurn($, clock, 'billing_error')
  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
  await failTurn($, clock)
  await failTurn($, clock)
  await clock.settle()
  expect(logs.filter(line => line.includes('could not continue'))).toEqual([])
  expect(prompts.length).toBe(2)
  expect(logs.some(line => line.includes('all available accounts are out of budget'))).toBe(true)
  expect(JSON.parse(files.get(HOME_CREDS) as string).claudeAiOauth.refreshToken).toBe('rt-b')
})

test('auto-switch restores its setting and wraps from the last account to the default', async ($, on) => {
  const { env, clock } = stub(on, machine(), {
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: WORK },
    store: new Map([['auto-switch', true]]),
  })
  const prompts = failures(on)
  await $.session.start(headless)
  await failTurn($, clock)
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
  expect(prompts.length).toBe(1)
})

test('auto-switch skips accounts needing login and ignores unrelated errors', async ($, on) => {
  const files = machine()
  files.delete(`${WORK}/.credentials.json`)
  const { env, clock } = stub(on, files, { store: new Map([['auto-switch', true]]) })
  const prompts = failures(on)
  await $.session.start(headless)
  for (const error of ['overloaded', 'server_error', 'authentication_failed', 'invalid_request', 'rate_limit'] as const) {
    await failTurn($, clock, error)
  }
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
  expect(prompts).toEqual([])
})

test('temporary server limits and subagent failures do not switch accounts', async ($, on) => {
  const { env, clock } = stub(on, machine(), { store: new Map([['auto-switch', true]]) })
  const prompts = failures(on)
  await $.session.start(headless)
  await $.classic.StopFailure({ error: 'rate_limit', last_assistant_message: 'Server is temporarily limiting requests (not your usage limit)' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 0, isAborted: false, reason: 'error' })
  await $.classic.StopFailure({ error: 'rate_limit', agent_id: 'worker-1' })
  await $.turn.complete({ turnId: 'turn-2', answer: '', durationMs: 0, isAborted: false, reason: 'error' })
  for (const error of ['overloaded', 'server_error', 'authentication_failed', 'invalid_request'] as const) await failTurn($, clock, error)
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
  expect(prompts).toEqual([])
})

test('an interrupted turn does not continue automatically', async ($, on) => {
  const { env } = stub(on, machine(), { store: new Map([['auto-switch', true]]) })
  const prompts = failures(on)
  await $.session.start(headless)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 0, isAborted: true, reason: 'aborted' })
  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
  expect(prompts).toEqual([])
})

test('a rejected continuation is reported without trying another account', async ($, on) => {
  const { env, logs, clock } = stub(on, machine(), { store: new Map([['auto-switch', true]]) })
  failures(on, true)
  await $.session.start(headless)
  await failTurn($, clock)
  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
  expect(logs.some(line => line.includes('prompt queue unavailable'))).toBe(true)
})

test('turning auto-switch off prevents further continuations', async ($, on) => {
  const { env, store, clock } = stub(on, machine())
  const prompts = failures(on)
  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: 'auto on' })
  expect(store.get('auto-switch')).toBe(true)
  await failTurn($, clock)
  await $.command.run({ command: 'account-switch', args: 'auto off' })
  await failTurn($, clock)
  expect(store.get('auto-switch')).toBe(false)
  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
  expect(prompts.length).toBe(1)
})

test('a failed account switch reports the error and does not queue a continuation', async ($, on) => {
  const files = machine()
  const { logs, clock } = stub(on, files, { store: new Map([['auto-switch', true]]) })
  const prompts = failures(on)
  await $.session.start(headless)
  files.set(CONFIG, '{broken')
  await failTurn($, clock)
  expect(prompts).toEqual([])
  expect(logs.some(line => line.startsWith('Auto-switch failed:'))).toBe(true)
})

test('the sidebar toggles auto-switch and shows the saved setting', async ($, on) => {
  const { store } = stub(on, machine())
  await $.session.start(headless)
  const ui = await $.ui.mount(PANE_SITE)
  expect((await ui.find({ key: 'auto-switch' }))?.props.label).toBe('Auto-switch: off')
  await ui.press({ key: 'auto-switch' })
  expect(store.get('auto-switch')).toBe(true)
  expect((await ui.find({ key: 'auto-switch' }))?.props.label).toBe('Auto-switch: on')
  await ui.press({ key: 'auto-switch' })
  expect(store.get('auto-switch')).toBe(false)
})

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

test('switching remembers the account for new sessions', async ($, on) => {
  const { store } = stub(on, machine())

  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: 'work' })
  expect(store.get('last-account')).toBe(WORK)

  await $.command.run({ command: 'account-switch', args: '1' })
  expect(store.get('last-account')).toBe(`${HOME}/.claude`)
})

test('a new session starts on the account last chosen in any session', async ($, on) => {
  const store = new Map<string, unknown>([['last-account', WORK]])
  const files = machine()
  const { env } = stub(on, files, { store })

  await $.session.start(headless)

  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
  expect(env.get('CLAUDE_CODE_ORGANIZATION_UUID')).toBe('org-a')
  expect(store.get('sessions')).toEqual({ 'session-1': WORK })
})

test('a resumed session keeps its own account over the last chosen one', async ($, on) => {
  const store = new Map<string, unknown>([
    ['sessions', { 'session-1': `${HOME}/.claude` }],
    ['last-account', WORK],
  ])
  const { env } = stub(on, machine(), { store })

  await $.session.start(headless)

  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
  expect(store.get('last-account')).toBe(WORK)
})

test('a new session stays on the default when the last chosen account needs login', async ($, on) => {
  const files = machine()
  files.delete(`${WORK}/.credentials.json`)
  const { env } = stub(on, files, { store: new Map([['last-account', WORK]]) })

  await $.session.start(headless)

  expect(env.has('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false)
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
  expect(await ui.find({ key: 'account-list' })).toBeDefined()
  expect(await ui.find({ key: 'account-footer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' Work ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'WINDOW  LEFT       RESETS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 64% ▰▰▱▱ ' })).toBeDefined()
  expect(await ui.find({ key: 'refresh-usage' })).toBeDefined()
  await ui.press({ key: 'refresh-usage' })
  // Clawd's body rows are drawn beside every account.
  expect(await ui.find({ type: 'Text', text: '▝▜█████▛▘' })).toBeDefined()
  await ui.press({ key: 'use-a_org-a' })

  expect(env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(WORK)
})

test('usage refreshes every fifteen seconds while open and stops when closed', async ($, on) => {
  let open = false
  let reads = 0
  const { clock } = stub(on, machine(), { usageRead: () => reads++ })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.panes', () => ({ value: open ? [{ id: 'accounts' }] : [] }))
  on('ui.open', () => { open = true; return { value: { isPlaced: true } } })
  on('ui.close', () => { open = false; return { value: undefined } })
  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: '' })
  expect(reads).toBe(2)
  await clock.advance(14999)
  expect(reads).toBe(2)
  await clock.advance(1)
  expect(reads).toBe(4)
  await clock.advance(15000)
  expect(reads).toBe(6)
  await $.command.run({ command: 'account-switch', args: '' })
  await clock.advance(30000)
  expect(reads).toBe(6)
  await $.command.run({ command: 'account-switch', args: '' })
  expect(reads).toBe(8)
  await clock.advance(15000)
  expect(reads).toBe(10)
})

test('a narrow ledger stacks reset times and keeps its controls', async ($, on) => {
  stub(on, machine())
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start(headless)
  await $.command.run({ command: 'account-switch', args: '' })
  const ui = await $.ui.mount({ ...PANE_SITE, props: { ...PANE_SITE.props, bodyColumns: 30 } })
  expect(await ui.find({ type: 'Text', text: 'WINDOW  LEFT / RESETS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 64% ▰▰▱▱ ' })).toBeDefined()
  expect(await ui.find({ key: 'auto-switch' })).toBeDefined()
  expect(await ui.find({ key: 'refresh-usage' })).toBeDefined()
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
  const wheel = await $.ui.scroll({ ...page, by: 1, pointer: { row: 3, column: 2 } })

  expect(right.deny).toBe('changed the hat instead')
  expect(wheel.deny).toBe('scroll accounts inside the fixed panel')
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
