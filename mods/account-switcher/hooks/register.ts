import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  type Account,
  AccountStore,
  bindsSwitchKey,
  describe,
  displayName,
  FileCredentials,
  hasHatBinding,
  hasOldBinding,
  hasSwitchBinding,
  type Io,
  matchAccount,
  parseObject,
  resolvePaths,
  startingAccount,
  SWITCH_ACTION,
  SWITCH_KEY_LABEL,
  withoutSwitchBinding,
  withSwitchBinding,
} from './accounts.ts'
import { cycleHat, HATS } from './clawd.ts'
import { detectStore, KeychainCredentials } from './keychain.ts'
import { nextPanelFocus, orderedAccounts, panel, panelGeometry, panelRows, useKey } from './panel.ts'
import { type Commands, commandsFor, detectPlatform, homeDir, joiner, type Platform } from './platform.ts'
import { HttpUsageApi, UsageCache, USAGE_REFRESH_MS } from './usage.ts'

const PANE = 'accounts'
const PANE_COLUMNS = 52
// Claude Code re-reads .claude.json about every half second; /status waits this long.
const CONFIG_SETTLE_MS = 1500
const SESSIONS_KEY = 'sessions'
const KEYS_OFF_KEY = 'keys-off'
const AUTO_SWITCH_KEY = 'auto-switch'
const LAST_ACCOUNT_KEY = 'last-account'

const HELP = [
  'Usage:',
  `  /account-switch                  open the account sidebar (or press ${SWITCH_KEY_LABEL})`,
  '  /account-switch <name|number>    switch this session to a saved account',
  '  /account-switch list',
  '  /account-switch auto on|off      switch accounts when the budget runs out',
  '  /account-switch add              sign in to another account (same as /login)',
  '  /account-switch rename <name> <label>',
  `  /account-switch hat <name> <hat> one of: ${HATS.map(h => h.id).join(', ')}`,
  '  /account-switch forget <name>',
  `  /account-switch keys on|off      add or remove the ${SWITCH_KEY_LABEL} and hat keys`,
].join('\n')

let accounts: Account[] = []
let current: Account | undefined
let focused = ''
let notice = ''
let autoSwitch = false
const exhausted = new Set<string>()
let switching = false
let budgetFailure = false
let usage: UsageCache | undefined
let usageTimer: Timer | undefined
let continuationTimer: Timer | undefined
let listOffset = 0
let panelWidth = PANE_COLUMNS
let panelHeight = 30

async function refreshUsage($: EngineInterface, force = false): Promise<void> {
  const s = await refresh($)
  usage ??= new UsageCache(new HttpUsageApi((url, init) => $.http.fetch(url, init), (await $.env.get('ANTHROPIC_BASE_URL')) || undefined), () => $.clock.now())
  const cache = usage
  await Promise.all(accounts.map(async account => {
    await cache.refresh(account, async () => s.usageToken(account, await $.clock.now()), force)
    $.ui.invalidate('ui.render')
  }))
}

async function setAutoSwitch($: EngineInterface, enabled: boolean): Promise<string> {
  await $.store.set(AUTO_SWITCH_KEY, enabled)
  autoSwitch = enabled
  exhausted.clear()
  $.ui.invalidate('ui.render')
  return `Auto-switch is ${enabled ? 'on' : 'off'}.`
}

async function switchAfterLimit($: EngineInterface): Promise<void> {
  if (!autoSwitch || switching) return
  switching = true
  let continuationScheduled = false
  try {
    const s = await refresh($)
    if (!current) return
    exhausted.add(current.dir)
    const index = accounts.findIndex(a => a.dir === current?.dir)
    const ordered = [...accounts.slice(index + 1), ...accounts.slice(0, index)]
    const target = ordered.find(a => !a.needsLogin && !exhausted.has(a.dir))
    if (!target) {
      notice = 'Auto-switch stopped: all available accounts are out of budget. Try again when a budget resets.'
      $.ui.log(notice)
      $.ui.invalidate('ui.render')
      return
    }
    await useAccount($, s, target)
    $.ui.log(`Budget exhausted. Switched this session to ${displayName(target)}.`)
    continuationScheduled = true
    continuationTimer = $.clock.every(CONFIG_SETTLE_MS, async () => {
      continuationTimer?.cancel()
      continuationTimer = undefined
      try {
        const continuation = await $.prompt.submit({ text: 'Continue the previous task from where it stopped because the account budget was exhausted.' })
        if (continuation.drop) $.ui.log(`Auto-switch could not continue: ${continuation.drop}`)
      } catch (error) {
        $.ui.log(`Auto-switch could not continue: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        switching = false
      }
    })
  } catch (error) {
    $.ui.log(`Auto-switch failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (!continuationScheduled) switching = false
  }
}

interface Env {
  platform: Platform
  commands: Commands
  join: (...parts: string[]) => string
}

async function environment($: EngineInterface): Promise<Env> {
  const platform = detectPlatform({ appData: await $.env.get('APPDATA'), userProfile: await $.env.get('USERPROFILE') })
  return { platform, commands: commandsFor(platform), join: joiner(platform) }
}

async function readText($: EngineInterface, env: Env, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  try {
    return String(await $.fs.read(path))
  } catch {
    // $.fs.read stops at 4 MiB and a long-lived ~/.claude.json can be larger.
    const r = await $.process.run(env.commands.read(path))
    if (r.exitCode !== 0) throw new Error(`could not read ${path}: ${r.stderr.trim()}`)
    return r.stdout
  }
}

async function writeText($: EngineInterface, env: Env, path: string, text: string): Promise<void> {
  const r = await $.process.run(env.commands.writeSecret(path), { stdin: text })
  if (r.exitCode !== 0) throw new Error(`could not write ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
}

function makeIo($: EngineInterface, env: Env, accountsDir: string): Io {
  return {
    read: path => readText($, env, path),
    writeSecret: (path, text) => writeText($, env, path, text),
    list: async dir => ((await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(e => e.name) : []),
    removeTree: async path => {
      // Only ever delete inside the accounts directory.
      if (!path.startsWith(accountsDir) || path === accountsDir) throw new Error(`refusing to delete ${path}`)
      await $.process.run(env.commands.removeTree(path))
    },
    mkdir: async path => (await $.process.run(env.commands.mkdir(path))).exitCode === 0,
    rmdir: async path => {
      await $.process.run(env.commands.rmdir(path))
    },
    mtime: async path => ((await $.fs.exists(path)) ? (await $.fs.stat(path)).mtimeMs : null),
    sleep: ms => $.clock.sleep(ms),
    now: () => $.clock.now(),
  }
}

async function store($: EngineInterface): Promise<AccountStore> {
  const env = await environment($)
  const home = homeDir(env.platform, { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE') })
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const legacy = await $.fs.exists(env.join(configDir || env.join(home, '.claude'), '.config.json'))
  const paths = resolvePaths(home, configDir, legacy, env.join)
  const io = makeIo($, env, paths.accountsDir)
  const files = new FileCredentials(io, env.join)
  const keychain = await macKeychain($, paths.configDir)
  return new AccountStore(io, paths, await detectStore(files, keychain, paths.configDir))
}

/** The Keychain store on macOS, where `security` exists; undefined elsewhere. */
async function macKeychain($: EngineInterface, defaultDir: string): Promise<KeychainCredentials | undefined> {
  if (await $.env.get('APPDATA')) return undefined
  const probe = await $.process.run(['sh', '-c', 'command -v security && uname -s']).catch(() => undefined)
  if (!probe || probe.exitCode !== 0 || !probe.stdout.includes('Darwin')) return undefined
  const user = (await $.env.get('USER')) || 'claude-code-user'
  return new KeychainCredentials(
    async (args, stdin) => {
      const r = await $.process.run(['security', ...args], stdin === undefined ? {} : { stdin })
      return { exitCode: r.exitCode, stdout: r.stdout }
    },
    /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user',
    defaultDir,
  )
}

async function refresh($: EngineInterface): Promise<AccountStore> {
  const s = await store($)
  accounts = await s.list()
  current = await s.forSession(await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'))
  $.ui.invalidate('ui.render')
  return s
}

/** Switches this session to `account` and makes it the one new sessions start on. */
async function useAccount($: EngineInterface, s: AccountStore, account: Account): Promise<void> {
  await $.store.set(LAST_ACCOUNT_KEY, account.dir)
  await applyAccount($, s, account)
}

/** Points this session's credential storage, and the shared account details, at `account`. */
async function applyAccount($: EngineInterface, s: AccountStore, account: Account): Promise<void> {
  await s.shareFromHome(account)
  await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', account.isHome ? undefined : account.dir)
  await $.env.set('CLAUDE_CODE_ORGANIZATION_UUID', account.oauthAccount.organizationUuid)
  await s.pointConfigAt(account.oauthAccount)
  await rememberSession($, account)
  await refresh($)
}

async function pointConfigAtSession($: EngineInterface): Promise<void> {
  const s = await refresh($)
  if (!current) return
  await s.pointConfigAt(current.oauthAccount, true)
  await $.clock.sleep(CONFIG_SETTLE_MS)
}

async function rememberSession($: EngineInterface, account: Account): Promise<void> {
  const id = await $.session.id()
  const saved = ((await $.store.get(SESSIONS_KEY)) as Record<string, string> | undefined) ?? {}
  const next = Object.fromEntries(Object.entries({ ...saved, [id]: account.dir }).slice(-200))
  await $.store.set(SESSIONS_KEY, next)
}

async function restoreSession($: EngineInterface, s: AccountStore): Promise<void> {
  if (await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')) return
  const id = await $.session.id()
  const saved = ((await $.store.get(SESSIONS_KEY)) as Record<string, string> | undefined) ?? {}
  const last = await $.store.get(LAST_ACCOUNT_KEY)
  const account = startingAccount(await s.list(), saved[id], typeof last === 'string' ? last : undefined)
  if (account && !account.isHome) await applyAccount($, s, account)
}

async function keybindingsPath($: EngineInterface, s: AccountStore): Promise<string> {
  return (await environment($)).join(s.configDir, 'keybindings.json')
}

async function installKeys($: EngineInterface, s: AccountStore, on: boolean): Promise<string> {
  const env = await environment($)
  const path = await keybindingsPath($, s)
  const file = parseObject(await readText($, env, path), path) ?? {}
  if (on && bindsSwitchKey(file) && !hasSwitchBinding(file)) {
    return `${SWITCH_KEY_LABEL} already has a binding in keybindings.json, so it was left alone.`
  }
  await writeText($, env, path, JSON.stringify(on ? withSwitchBinding(file) : withoutSwitchBinding(file), null, 2))
  await $.store.set(KEYS_OFF_KEY, !on)
  return on
    ? `${SWITCH_KEY_LABEL} opens the account sidebar, and Right and Left in it change Clawd's hat.`
    : `Removed the ${SWITCH_KEY_LABEL} shortcut and the hat keys.`
}

/** Installs the shortcuts the first time, and upgrades the ones earlier versions used. */
async function ensureKeys($: EngineInterface, s: AccountStore): Promise<void> {
  if (await $.store.get(KEYS_OFF_KEY)) return
  const env = await environment($)
  const path = await keybindingsPath($, s)
  const file = parseObject(await readText($, env, path), path) ?? {}
  if (hasOldBinding(file)) {
    await writeText($, env, path, JSON.stringify(withSwitchBinding(file), null, 2))
    $.ui.log(`The account sidebar moved to ${SWITCH_KEY_LABEL}, and Ctrl+Shift+- is undo again.`)
    return
  }
  if (hasSwitchBinding(file) && !hasHatBinding(file)) {
    await writeText($, env, path, JSON.stringify(withSwitchBinding(file), null, 2))
    return
  }
  if (bindsSwitchKey(file)) return
  $.ui.log(await installKeys($, s, true))
}

function nameOf(account: Account | undefined): string {
  return account ? displayName(account) : 'no account'
}

function formatList(list: Account[], active: Account | undefined): string {
  if (list.length === 0) return 'No accounts yet. Run /login to sign in.'
  return list
    .map((a, i) => {
      const flags = [a.dir === active?.dir ? 'this session' : '', a.isHome ? 'default' : '', a.needsLogin ? 'needs /login' : '']
        .filter(Boolean)
        .join(', ')
      const detail = describe(a)
      return `${i + 1}. ${displayName(a)}${detail ? `  ${detail}` : ''}${flags ? `  (${flags})` : ''}`
    })
    .join('\n')
}

async function switchTo($: EngineInterface, query: string): Promise<string> {
  const s = await refresh($)
  const match = matchAccount(accounts, query)
  if (match.kind === 'none') return `No account matches "${query}".\n${formatList(accounts, current)}`
  if (match.kind === 'ambiguous') return `"${query}" matches more than one account: ${match.candidates.map(displayName).join(', ')}`
  if (match.account.dir === current?.dir) return `This session already uses ${displayName(match.account)}.`
  await useAccount($, s, match.account)
  exhausted.clear()
  const warning = match.account.needsLogin ? ' Its login has expired, so run /login to sign in to it again.' : ''
  return `This session now uses ${displayName(match.account)}. Other sessions keep their own account.${warning}`
}

async function setHat($: EngineInterface, account: Account, hat: string): Promise<void> {
  const s = await store($)
  await s.setHat(account, hat)
  accounts = accounts.map(a => (a.dir === account.dir ? { ...a, hat } : a))
  if (current?.dir === account.dir) current = { ...current, hat }
  $.ui.invalidate('ui.render')
}

async function runCommand($: EngineInterface, args: string): Promise<string | null> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const s = await refresh($)

  switch (verb.toLowerCase()) {
    case '':
      return null
    case 'help':
      return HELP
    case 'list':
    case 'ls':
      return formatList(accounts, current)
    case 'auto':
      if (rest.length !== 1 || (rest[0] !== 'on' && rest[0] !== 'off')) return 'Usage: /account-switch auto on|off'
      return setAutoSwitch($, rest[0] === 'on')
    case 'add':
    case 'login':
      return 'Run /login and sign in. The new account is added and this session switches to it.'
    case 'rename': {
      const [query, ...label] = rest
      if (!query || label.length === 0) return 'Usage: /account-switch rename <name> <label>'
      const match = matchAccount(accounts, query)
      if (match.kind !== 'found') return `No single account matches "${query}".`
      await s.rename(match.account, label.join(' '))
      await refresh($)
      return `Renamed ${displayName(match.account)} to ${label.join(' ').trim()}.`
    }
    case 'hat': {
      const [query, hatId] = rest
      const hat = HATS.find(h => h.id === hatId?.toLowerCase())
      if (!query || !hat) return `Usage: /account-switch hat <name> <${HATS.map(h => h.id).join('|')}>`
      const match = matchAccount(accounts, query)
      if (match.kind !== 'found') return `No single account matches "${query}".`
      await setHat($, match.account, hat.id)
      return `${displayName(match.account)}'s Clawd now wears: ${hat.name}.`
    }
    case 'forget':
    case 'remove':
    case 'rm': {
      const query = rest.join(' ')
      if (!query) return 'Usage: /account-switch forget <name>'
      const match = matchAccount(accounts, query)
      if (match.kind !== 'found') return `No single account matches "${query}".`
      if (match.account.isHome) return `${displayName(match.account)} is the default login in ~/.claude. Use /logout from a session on it to remove it.`
      if (match.account.dir === current?.dir) return `This session uses ${displayName(match.account)}. Switch to another account first.`
      await s.forget(match.account)
      await refresh($)
      return `Forgot ${displayName(match.account)}. Its login stays valid on Anthropic's side until it expires.`
    }
    case 'keys':
      return installKeys($, s, rest[0]?.toLowerCase() !== 'off')
    case 'use':
    case 'switch':
      return rest.length ? switchTo($, rest.join(' ')) : HELP
    default:
      return switchTo($, args)
  }
}

async function togglePane($: EngineInterface): Promise<void> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return
  }
  notice = ''
  listOffset = 0
  await refresh($)
  focused = current ? useKey(current) : ''
  await $.ui.open({ id: PANE, title: 'Accounts', focus: true, closeOnEscape: true, columns: PANE_COLUMNS, rows: panelRows({ accounts, current }) })
  await refreshUsage($)
  usageTimer?.cancel()
  usageTimer = $.clock.every(USAGE_REFRESH_MS, async () => {
    if (!(await $.ui.panes()).some(p => p.id === PANE)) {
      usageTimer?.cancel()
      usageTimer = undefined
      return
    }
    await refreshUsage($, true)
  })
}

export const register: Register = on => {
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    usageTimer?.cancel()
    usageTimer = undefined
    return result
  })

  on('session.end', async ($, e, next) => {
    usageTimer?.cancel()
    usageTimer = undefined
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    try {
      autoSwitch = (await $.store.get(AUTO_SWITCH_KEY)) === true
      exhausted.clear()
      usage = undefined
      usageTimer?.cancel()
      usageTimer = undefined
      const s = await store($)
      await s.learnHome()
      await restoreSession($, s)
      await refresh($)
      if (e.isInteractive) await ensureKeys($, s)
    } catch (error) {
      $.ui.log(`account-switcher could not start: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    await $.command.register({
      name: 'account-switch',
      description: 'Switch this session between Claude subscription accounts',
      argumentHint: '[name|list|add|rename|hat|forget|keys|auto]',
      immediate: true,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind)) {
      continuationTimer?.cancel()
      continuationTimer = undefined
      switching = false
      exhausted.clear()
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    const temporaryLimit = /not your usage limit/i.test(e.last_assistant_message ?? '')
    if (!e.agent_id && !temporaryLimit && !result.preventContinuation && !result.block && (e.error === 'rate_limit' || e.error === 'billing_error')) {
      budgetFailure = true
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const shouldSwitch = budgetFailure && e.reason === 'error' && !e.isAborted
    budgetFailure = false
    if (shouldSwitch) await switchAfterLimit($)
    return result
  })

  on('command.run', { command: 'account-switch' }, async ($, e) => {
    try {
      const text = await runCommand($, e.args)
      if (text !== null) return { text }
    } catch (error) {
      return { text: `Account switch failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if ((await $.session.surfaces()).length === 0) return { text: formatList(accounts, current) }
    await togglePane($)
    return {}
  })

  // .claude.json holds one account for every session, and /status reads it, so
  // point it at this session's account first and give Claude Code time to re-read it.
  on('command.run', { command: 'status' }, async ($, e, next) => {
    await pointConfigAtSession($)
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // A new login goes into a scratch directory so it never overwrites the login this
  // session or any other is using, then becomes an account of its own.
  on('command.run', { command: 'login' }, async ($, e, next) => {
    const s = await refresh($)
    const before = current
    await s.clearPending()
    await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', s.pendingDir)

    let result
    try {
      result = await next(e)
    } finally {
      const added = await s.adoptPending(await s.configAccount())
      const target = added ?? before
      if (target) await useAccount($, s, target)
      else await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined)
      if (added) $.ui.log(`This session now uses ${nameOf(added)}. Switch back any time with ${SWITCH_KEY_LABEL} or /account-switch.`)
    }
    return result
  }).catch(async ($, e, next) => next(e))

  // /logout revokes the login on Anthropic's side, which signs out every session on it.
  on('command.run', { command: 'logout' }, async ($, e, next) => {
    const s = await refresh($)
    const leaving = current
    if (!leaving) return next(e)

    let answer = 'Log out'
    try {
      answer = await $.ui.ask(
        `Logging out revokes ${nameOf(leaving)}'s login, so every session using it is signed out and you would have to sign in again. To use a different account in this session, use /account-switch instead. Log out anyway?`,
        { header: 'Logout', options: ['Log out', 'Cancel'] },
      )
    } catch {
      // No one to ask, as in claude -p.
    }
    if (answer !== 'Log out') return { text: 'Logout cancelled.' }

    const result = await next(e)
    await s.forget(leaving)
    const home = (await s.list()).find(a => a.isHome)
    if (home && !leaving.isHome) await useAccount($, s, home)
    else await refresh($)
    return result
  }).catch(async ($, e, next) => next(e))

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && e.element && focused !== e.element) {
      focused = e.element
      const index = orderedAccounts({ accounts, current }).findIndex(a => useKey(a) === focused)
      if (index >= 0) {
        const geometry = panelGeometry(panelWidth, panelHeight, accounts.length, listOffset)
        const top = index * geometry.rowHeight
        if (top < listOffset) listOffset = top
        else if (top + geometry.rowHeight > listOffset + geometry.listHeight) listOffset = Math.min(top, top + geometry.rowHeight - geometry.listHeight)
      }
      $.ui.invalidate('ui.render')
    }
    return result
  }).catch(async ($, e, next) => next(e))

  // Right and Left arrive as page scrolls (see HAT_KEYS); over an account they change its hat.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const account = accounts.find(a => focused === useKey(a))
    const isPageKey = e.origin.kind === 'person' && !e.pointer && Math.abs(e.by) >= e.bodyRows
    if (account && isPageKey) {
      await setHat($, account, cycleHat(account.hat, e.by > 0 ? 1 : -1).id)
      return { deny: 'changed the hat instead' }
    }
    if (e.origin.kind === 'person' && !e.pointer && Math.abs(e.by) === 1) {
      const keys = [...orderedAccounts({ accounts, current }).map(useKey), 'auto-switch', 'add', 'refresh-usage']
      const target = nextPanelFocus(keys, focused, e.by)
      if (target && target !== focused) await $.ui.focus({ requestId: PANE, key: target })
      return { deny: 'moved the panel selection' }
    }
    if (e.origin.kind !== 'person') return { deny: 'keep the panel footer fixed' }
    const geometry = panelGeometry(panelWidth, panelHeight, accounts.length, listOffset)
    if (!e.pointer || (e.pointer.row >= 2 && e.pointer.row < 2 + geometry.listHeight)) {
      listOffset = panelGeometry(panelWidth, panelHeight, accounts.length, listOffset + e.by).offset
      $.ui.invalidate('ui.render')
    }
    return { deny: 'scroll accounts inside the fixed panel' }
  }).catch(async ($, e, next) => next(e))

  // The account line above the prompt. Clicking it, or the shortcut, opens the sidebar.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const theirs = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const plan = current?.plan ? ` · ${current.plan.charAt(0).toUpperCase()}${current.plan.slice(1)}` : ''
    const line = Button({
      key: 'account-switch',
      label: `Account: ${nameOf(current)}${plan}`,
      plain: true,
      dimColor: true,
      action: SWITCH_ACTION,
      onPress: () => togglePane($),
    })
    return theirs ? Box({ flexDirection: 'column', children: [theirs, line] }) : line
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    panelWidth = e.props.bodyColumns
    panelHeight = e.props.scroll.bodyRows
    listOffset = panelGeometry(panelWidth, panelHeight, accounts.length, listOffset).offset
    const { Box, Text, Button } = $.ui.resolve(e)
    return panel(
      { Box, Text, Button },
      { accounts, current, focused, notice, autoSwitch, width: panelWidth, height: panelHeight, offset: listOffset, usage: usage?.entries ?? new Map(), now: await $.clock.now() },
      {
        refreshUsage: () => refreshUsage($, true),
        toggleAutoSwitch: async () => {
          notice = await setAutoSwitch($, !autoSwitch)
          $.ui.invalidate('ui.render')
        },
        choose: account => async () => {
          notice = await switchTo($, account.isHome ? 'home' : account.key).catch(
            error => `Account switch failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          if (notice.startsWith('This session')) {
            await $.ui.close({ id: PANE })
            $.ui.log(notice)
            notice = ''
            return
          }
          $.ui.invalidate('ui.render')
        },
        add: async () => {
          await $.ui.close({ id: PANE })
          await $.prompt.fill({ text: '/login' })
        },
      },
    )
  })
}
