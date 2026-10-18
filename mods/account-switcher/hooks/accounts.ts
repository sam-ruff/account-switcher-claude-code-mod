// Per-session Claude subscription accounts.
//
// Each saved account owns a directory, ~/.claude/accounts/<key>/, holding its own
// .credentials.json. A session uses one by pointing CLAUDE_SECURESTORAGE_CONFIG_DIR
// at that directory, so two sessions can run on two accounts and each token refresh
// lands in the right file. The login in ~/.claude itself is the "home" account,
// which sessions use by default and which `claude` outside the mod keeps using.

export interface Io {
  read(path: string): Promise<string | null>
  /** Atomic write with a 0600 file and 0700 parent directories. */
  writeSecret(path: string, text: string): Promise<void>
  /** Names of the entries in a directory, or none if it is missing. */
  list(dir: string): Promise<string[]>
  removeTree(path: string): Promise<void>
  /** Creates a directory, resolving false if it already exists. */
  mkdir(path: string): Promise<boolean>
  rmdir(path: string): Promise<void>
  mtime(path: string): Promise<number | null>
  sleep(ms: number): Promise<void>
  now(): Promise<number>
}

/**
 * Where an account's login lives. Linux and Windows keep it in `<dir>/.credentials.json`;
 * macOS keeps it in a Keychain item whose name Claude Code derives from `dir`.
 */
export interface CredentialStore {
  read(dir: string): Promise<Record<string, unknown> | null>
  write(dir: string, creds: Record<string, unknown>): Promise<void>
  remove(dir: string): Promise<void>
}

export class FileCredentials implements CredentialStore {
  constructor(
    private readonly io: Io,
    private readonly join: Join,
  ) {}

  async read(dir: string): Promise<Record<string, unknown> | null> {
    const path = this.join(dir, CREDENTIALS)
    try {
      return parseObject(await this.io.read(path), path)
    } catch {
      return null
    }
  }

  async write(dir: string, creds: Record<string, unknown>): Promise<void> {
    await this.io.writeSecret(this.join(dir, CREDENTIALS), JSON.stringify(creds, null, 2))
  }

  async remove(): Promise<void> {
    // The file goes with its directory.
  }
}

export type Join = (...parts: string[]) => string

export const posixJoin: Join = (...parts) => parts.join('/')

export interface Paths {
  configDir: string
  globalConfig: string
  accountsDir: string
  join: Join
}

export interface OauthAccount {
  accountUuid: string
  emailAddress?: string
  organizationUuid?: string
  organizationName?: string
  [key: string]: unknown
}

export interface Account {
  key: string
  label?: string
  /** Id of the hat Clawd wears beside this account. */
  hat?: string
  oauthAccount: OauthAccount
  /** Directory holding this account's .credentials.json. */
  dir: string
  isHome: boolean
  plan?: string
  needsLogin: boolean
}

export type Match = { kind: 'found'; account: Account } | { kind: 'none' } | { kind: 'ambiguous'; candidates: Account[] }

export const HOME_KEY = 'home'
export const CREDENTIALS = '.credentials.json'
const META = 'account.json'
const PENDING = '.pending'

// Keys in .credentials.json that belong to the signed-in account. The rest, such as
// MCP server logins, are shared from the home account into the others.
export const ACCOUNT_CREDENTIAL_KEYS = ['claudeAiOauth', 'organizationUuid', 'trustedDeviceToken', 'designOauth']

// Per-account caches Claude Code drops from .claude.json when the account changes.
export const ACCOUNT_CACHE_KEYS = [
  'additionalModelOptionsCache',
  'additionalModelOptionsAnsweredAt',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'cachedArtifactRoster',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
  'cachedUsageUtilization',
  'metricsStatusCache',
  'metricsStatusCacheByPrincipal',
  'githubWebConnectionStatusCache',
  'startupPrefetchedAt',
]

// Claude Code treats its own locks as stale after 15s and refreshes live ones well
// before that. The wait stays under the 10s hook time limit.
const LOCK_STALE_MS = 20_000
const LOCK_RETRY_MS = 100
const LOCK_ATTEMPTS = 50

export function resolvePaths(home: string, configDirEnv: string | undefined, legacyConfigExists: boolean, join: Join = posixJoin): Paths {
  const configDir = configDirEnv || join(home, '.claude')
  const globalConfig = legacyConfigExists
    ? join(configDir, '.config.json')
    : configDirEnv
      ? join(configDirEnv, '.claude.json')
      : join(home, '.claude.json')
  return { configDir, globalConfig, accountsDir: join(configDir, 'accounts'), join }
}

export function accountKey(oauth: OauthAccount): string {
  return `${oauth.accountUuid}_${oauth.organizationUuid ?? 'personal'}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

export function displayName(account: Pick<Account, 'label' | 'oauthAccount' | 'key'>): string {
  return account.label ?? account.oauthAccount.emailAddress ?? account.key
}

export function describe(account: Account): string {
  const parts: string[] = []
  if (account.label && account.oauthAccount.emailAddress) parts.push(account.oauthAccount.emailAddress)
  if (account.plan) parts.push(account.plan.charAt(0).toUpperCase() + account.plan.slice(1))
  if (account.oauthAccount.organizationName) parts.push(account.oauthAccount.organizationName)
  return parts.join(' · ')
}

/** Matches by 1-based position, exact name, then case-insensitive prefix of label or email. */
export function matchAccount(accounts: Account[], query: string): Match {
  const q = query.trim().toLowerCase()
  if (!q) return { kind: 'none' }

  const index = Number(q)
  if (Number.isInteger(index) && index >= 1 && index <= accounts.length) {
    return { kind: 'found', account: accounts[index - 1] }
  }

  const names = (a: Account) =>
    [a.label, a.oauthAccount.emailAddress, a.isHome ? HOME_KEY : a.key]
      .filter((n): n is string => !!n)
      .map(n => n.toLowerCase())

  const exact = accounts.filter(a => names(a).includes(q))
  if (exact.length === 1) return { kind: 'found', account: exact[0] }

  const prefixed = accounts.filter(a => names(a).some(n => n.startsWith(q)))
  if (prefixed.length === 1) return { kind: 'found', account: prefixed[0] }
  if (prefixed.length > 1) return { kind: 'ambiguous', candidates: prefixed }
  return { kind: 'none' }
}

/**
 * The account a session starts on: the one it used before a resume, otherwise the
 * last account chosen in any session, provided it is still signed in.
 */
export function startingAccount(accounts: Account[], sessionDir: string | undefined, lastDir: string | undefined): Account | undefined {
  if (sessionDir) return accounts.find(a => a.dir === sessionDir)
  return accounts.find(a => a.dir === lastDir && !a.needsLogin)
}

export function applyAccountConfig(config: Record<string, unknown>, oauth: OauthAccount): Record<string, unknown> {
  const next = { ...config }
  const current = config.oauthAccount as OauthAccount | undefined
  if (!current || accountKey(current) !== accountKey(oauth)) {
    for (const key of ACCOUNT_CACHE_KEYS) delete next[key]
  }
  next.oauthAccount = oauth
  return next
}

export function splitCredentials(creds: Record<string, unknown>): { account: Record<string, unknown>; shared: Record<string, unknown> } {
  const account: Record<string, unknown> = {}
  const shared: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(creds)) {
    if (ACCOUNT_CREDENTIAL_KEYS.includes(key)) account[key] = value
    else shared[key] = value
  }
  return { account, shared }
}

// The shortcut is a Button bound to an engine action that nothing else handles
// while the newer /diff mod is enabled. Claude Code reads numpad minus as "-", so
// Ctrl+Alt+Shift+numpad minus arrives as ctrl+alt+shift+- from terminals that
// report modifiers on it (kitty protocol, xterm modifyOtherKeys, and keypad mode).
export const SWITCH_ACTION = 'app:toggleDiffPreSession'
export const SWITCH_KEY = 'ctrl+alt+shift+-'
export const SWITCH_KEY_LABEL = 'Ctrl+Alt+Shift+numpad -'

// A mod can't read Right and Left in its pane, so they are bound to page scrolls,
// which the mod refuses and turns into changing the focused account's hat.
export const HAT_KEYS: Record<string, string> = { right: 'pane:pageDown', left: 'pane:pageUp' }

// What version 0.2 installed, removed on upgrade so undo gets its key back.
const OLD_SWITCH_KEYS = ['ctrl+shift+-', 'ctrl+_']
const OLD_UNDO_FALLBACK = 'ctrl+x ctrl+u'

interface BindingBlock {
  context: string
  bindings: Record<string, string | null>
}

function bindingBlocks(file: Record<string, unknown>): BindingBlock[] {
  return Array.isArray(file.bindings) ? (file.bindings as BindingBlock[]) : []
}

/** Whether the keybindings file already binds the switch key to anything. */
export function bindsSwitchKey(file: Record<string, unknown>): boolean {
  return bindingBlocks(file).some(b => SWITCH_KEY in (b.bindings ?? {}))
}

/** Whether the switch key is bound to the sidebar. */
export function hasSwitchBinding(file: Record<string, unknown>): boolean {
  return bindingBlocks(file).some(b => b.context === 'Global' && b.bindings?.[SWITCH_KEY] === SWITCH_ACTION)
}

export function hasOldBinding(file: Record<string, unknown>): boolean {
  return bindingBlocks(file).some(b => b.context === 'Global' && OLD_SWITCH_KEYS.some(k => b.bindings?.[k] === SWITCH_ACTION))
}

/** Drops the bindings an older version of the mod installed. */
export function withoutOldBinding(file: Record<string, unknown>): Record<string, unknown> {
  const blocks = bindingBlocks(file)
    .map(b => {
      const bindings = { ...b.bindings }
      for (const key of OLD_SWITCH_KEYS) {
        if (b.context === 'Global' && bindings[key] === SWITCH_ACTION) delete bindings[key]
        if (b.context === 'Chat' && bindings[key] === null) delete bindings[key]
      }
      if (b.context === 'Chat' && bindings[OLD_UNDO_FALLBACK] === 'chat:undo') delete bindings[OLD_UNDO_FALLBACK]
      return { ...b, bindings }
    })
    .filter(b => Object.keys(b.bindings).length > 0)
  return { ...file, bindings: blocks }
}

/** Whether Right and Left in a pane already reach the mod as hat changes. */
export function hasHatBinding(file: Record<string, unknown>): boolean {
  const pane = bindingBlocks(file).find(b => b.context === 'Pane')
  return Object.entries(HAT_KEYS).every(([key, action]) => pane?.bindings?.[key] === action)
}

/** Adds the sidebar shortcut, and the hat keys unless the user bound Right or Left in panes themselves. */
export function withSwitchBinding(file: Record<string, unknown>): Record<string, unknown> {
  const blocks = bindingBlocks(withoutOldBinding(file)).map(b => ({ ...b, bindings: { ...b.bindings } }))
  const block = (context: string) => {
    let found = blocks.find(b => b.context === context)
    if (!found) {
      found = { context, bindings: {} }
      blocks.push(found)
    }
    return found
  }
  block('Global').bindings[SWITCH_KEY] = SWITCH_ACTION
  const pane = block('Pane')
  for (const [key, action] of Object.entries(HAT_KEYS)) {
    if (!(key in pane.bindings)) pane.bindings[key] = action
  }
  return { ...file, bindings: blocks }
}

export function withoutSwitchBinding(file: Record<string, unknown>): Record<string, unknown> {
  const blocks = bindingBlocks(withoutOldBinding(file))
    .map(b => {
      const bindings = { ...b.bindings }
      if (b.context === 'Global' && bindings[SWITCH_KEY] === SWITCH_ACTION) delete bindings[SWITCH_KEY]
      if (b.context === 'Pane') {
        for (const [key, action] of Object.entries(HAT_KEYS)) if (bindings[key] === action) delete bindings[key]
      }
      return { ...b, bindings }
    })
    .filter(b => Object.keys(b.bindings).length > 0)
  return { ...file, bindings: blocks }
}

interface Tokens {
  refreshToken?: string
  subscriptionType?: string
  refreshTokenExpiresAt?: number
}

function tokensOf(creds: Record<string, unknown> | null): Tokens | undefined {
  const value = creds?.claudeAiOauth
  if (value === null || typeof value !== 'object') return undefined
  return value as Tokens
}

export function parseObject(text: string | null, path: string): Record<string, unknown> | null {
  if (text === null || text.trim() === '') return null
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} does not hold a JSON object`)
  }
  return value as Record<string, unknown>
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface Meta {
  oauthAccount: OauthAccount
  label?: string
  hat?: string
}

function metaOf(value: Record<string, unknown> | null): Meta | undefined {
  const oauth = value?.oauthAccount as OauthAccount | undefined
  if (!oauth?.accountUuid) return undefined
  return {
    oauthAccount: oauth,
    ...(typeof value?.label === 'string' ? { label: value.label } : {}),
    ...(typeof value?.hat === 'string' ? { hat: value.hat } : {}),
  }
}

export class AccountStore {
  constructor(
    private readonly io: Io,
    private readonly paths: Paths,
    private readonly creds: CredentialStore,
  ) {}

  get pendingDir(): string {
    return this.join(this.paths.accountsDir, PENDING)
  }

  private get join(): Join {
    return this.paths.join
  }

  private get homeMetaPath(): string {
    return this.join(this.paths.accountsDir, 'home.json')
  }

  private dirFor(key: string): string {
    return this.join(this.paths.accountsDir, key)
  }

  get configDir(): string {
    return this.paths.configDir
  }

  async usageToken(account: Account, now: number): Promise<string | undefined> {
    const credentials = await this.creds.read(account.dir)
    const oauth = credentials?.claudeAiOauth as { accessToken?: unknown; expiresAt?: unknown } | undefined
    if (typeof oauth?.expiresAt === 'number' && oauth.expiresAt <= now) return undefined
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : undefined
  }

  /** Every account with a login: the home account first, then saved ones by name. */
  async list(): Promise<Account[]> {
    const now = await this.io.now()
    const accounts: Account[] = []

    const home = await this.homeAccount(now)
    if (home) accounts.push(home)

    const saved: Account[] = []
    for (const name of await this.io.list(this.paths.accountsDir)) {
      if (name.startsWith('.') || name.endsWith('.json')) continue
      const dir = this.dirFor(name)
      const metaPath = this.join(dir, META)
      try {
        const meta = metaOf(parseObject(await this.io.read(metaPath), metaPath))
        if (meta) saved.push(await this.hydrate({ key: name, ...meta }, dir, false, now))
      } catch {
        // A corrupt entry should not hide the others.
      }
    }
    saved.sort((a, b) => displayName(a).localeCompare(displayName(b)))
    return [...accounts, ...saved]
  }

  /** The account a session uses, from its CLAUDE_SECURESTORAGE_CONFIG_DIR. */
  async forSession(storageDir: string | undefined): Promise<Account | undefined> {
    const dir = storageDir || this.paths.configDir
    return (await this.list()).find(a => a.dir === dir)
  }

  /**
   * Records who the home account is the first time the mod runs. Afterwards
   * .claude.json follows whichever session switched last, so it can't be trusted.
   */
  async learnHome(): Promise<void> {
    if (await this.homeMeta()) return
    const creds = await this.creds.read(this.paths.configDir)
    if (!tokensOf(creds)?.refreshToken) return
    const oauth = await this.configAccount()
    if (oauth) await this.rememberHome(oauth)
  }

  /**
   * Files the login that `/login` just wrote into the pending directory. It replaces
   * the home login when there is none or it is the same account, and otherwise
   * becomes a saved account of its own. Returns the account, or undefined if the
   * login did not finish.
   */
  async adoptPending(oauth: OauthAccount | undefined): Promise<Account | undefined> {
    const pending = await this.creds.read(this.pendingDir)
    if (!oauth || !pending || !tokensOf(pending)?.refreshToken) {
      await this.clearPending()
      return undefined
    }

    const key = accountKey(oauth)
    const home = await this.homeMeta()
    const homeCreds = await this.creds.read(this.paths.configDir)
    const intoHome = !tokensOf(homeCreds)?.refreshToken || (home && accountKey(home.oauthAccount) === key)

    if (intoHome) {
      await this.withLock(this.join(this.paths.configDir, '.storage-write'), async () => {
        const live = (await this.creds.read(this.paths.configDir)) ?? {}
        await this.creds.write(this.paths.configDir, { ...splitCredentials(live).shared, ...splitCredentials(pending).account })
      })
      await this.rememberHome(oauth)
    } else {
      const dir = this.dirFor(key)
      const metaPath = this.join(dir, META)
      const existing = metaOf(parseObject(await this.io.read(metaPath), metaPath))
      await this.creds.write(dir, { ...splitCredentials(homeCreds ?? {}).shared, ...splitCredentials(pending).account })
      await this.writeMeta(dir, { ...existing, oauthAccount: oauth })
    }

    await this.clearPending()
    const target = intoHome ? this.paths.configDir : this.dirFor(key)
    return (await this.list()).find(a => a.dir === target)
  }

  async clearPending(): Promise<void> {
    await this.creds.remove(this.pendingDir)
    await this.io.removeTree(this.pendingDir)
  }

  /** Copies MCP logins and other shared entries from the home account where the account has none. */
  async shareFromHome(account: Account): Promise<void> {
    if (account.isHome) return
    const { shared } = splitCredentials((await this.creds.read(this.paths.configDir)) ?? {})
    await this.withLock(this.join(account.dir, '.storage-write'), async () => {
      const creds = (await this.creds.read(account.dir)) ?? {}
      const missing = Object.fromEntries(Object.entries(shared).filter(([k]) => !(k in creds)))
      if (Object.keys(missing).length === 0) return
      await this.creds.write(account.dir, { ...creds, ...missing })
    })
  }

  async rename(account: Account, label: string): Promise<void> {
    const trimmed = label.trim()
    await this.updateMeta(account, meta => {
      const { label: _old, ...rest } = meta
      return trimmed ? { ...rest, label: trimmed } : rest
    })
  }

  async setHat(account: Account, hat: string): Promise<void> {
    await this.updateMeta(account, meta => ({ ...meta, hat }))
  }

  async forget(account: Account): Promise<void> {
    if (account.isHome) {
      await this.io.removeTree(this.homeMetaPath)
      return
    }
    await this.creds.remove(account.dir)
    await this.io.removeTree(account.dir)
  }

  /**
   * Points .claude.json's account details at `oauth`. /status reads them, and the
   * file is shared by every session, so each session points it at its own account
   * when it needs them right. With `touch`, the file is rewritten even when it
   * already matches, because a running session only re-reads it when its mtime is
   * newer than the copy it holds. Resolves true if it wrote.
   */
  async pointConfigAt(oauth: OauthAccount, touch = false): Promise<boolean> {
    return this.withLock(this.paths.globalConfig, async () => {
      const config = parseObject(await this.io.read(this.paths.globalConfig), this.paths.globalConfig) ?? {}
      const next = applyAccountConfig(config, oauth)
      if (!touch && sameJson(config, next)) return false
      await this.io.writeSecret(this.paths.globalConfig, JSON.stringify(next, null, 2))
      return true
    })
  }

  async configAccount(): Promise<OauthAccount | undefined> {
    const config = parseObject(await this.io.read(this.paths.globalConfig), this.paths.globalConfig)
    const oauth = config?.oauthAccount as OauthAccount | undefined
    return oauth?.accountUuid ? oauth : undefined
  }

  async configValue(key: string): Promise<unknown> {
    return parseObject(await this.io.read(this.paths.globalConfig), this.paths.globalConfig)?.[key]
  }

  private async rememberHome(oauth: OauthAccount): Promise<void> {
    const home = await this.homeMeta()
    const same = home && accountKey(home.oauthAccount) === accountKey(oauth)
    await this.writeMeta(null, same ? { ...home, oauthAccount: oauth } : { oauthAccount: oauth })
  }

  private async updateMeta(account: Account, change: (meta: Meta) => Meta): Promise<void> {
    if (account.isHome) {
      const home = await this.homeMeta()
      if (home) await this.writeMeta(null, change(home))
      return
    }
    const path = this.join(account.dir, META)
    const meta = metaOf(parseObject(await this.io.read(path), path)) ?? { oauthAccount: account.oauthAccount }
    await this.writeMeta(account.dir, change(meta))
  }

  /** Writes a saved account's metadata, or the home account's when `dir` is null. */
  private async writeMeta(dir: string | null, meta: Meta): Promise<void> {
    const path = dir === null ? this.homeMetaPath : this.join(dir, META)
    await this.io.writeSecret(path, JSON.stringify(meta, null, 2))
  }

  private async homeMeta(): Promise<Meta | undefined> {
    return metaOf(parseObject(await this.io.read(this.homeMetaPath), this.homeMetaPath))
  }

  private async homeAccount(now: number): Promise<Account | undefined> {
    const home = await this.homeMeta()
    if (!home) return undefined
    const account = await this.hydrate({ key: HOME_KEY, ...home }, this.paths.configDir, true, now)
    return account.needsLogin && !account.plan ? undefined : account
  }

  private async hydrate(meta: Meta & { key: string }, dir: string, isHome: boolean, now: number): Promise<Account> {
    const tokens = tokensOf(await this.creds.read(dir))
    const expired = typeof tokens?.refreshTokenExpiresAt === 'number' && tokens.refreshTokenExpiresAt < now
    return {
      ...meta,
      dir,
      isHome,
      ...(tokens?.subscriptionType ? { plan: tokens.subscriptionType } : {}),
      needsLogin: !tokens?.refreshToken || expired,
    }
  }

  private async withLock<T>(target: string, work: () => Promise<T>): Promise<T> {
    const lockDir = `${target}.lock`
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      if (await this.io.mkdir(lockDir)) {
        try {
          return await work()
        } finally {
          await this.io.rmdir(lockDir)
        }
      }
      const mtime = await this.io.mtime(lockDir)
      if (mtime !== null && (await this.io.now()) - mtime > LOCK_STALE_MS) {
        await this.io.rmdir(lockDir)
        continue
      }
      await this.io.sleep(LOCK_RETRY_MS)
    }
    throw new Error(`timed out waiting for ${lockDir}`)
  }
}
