import { AccountStore, type CredentialStore, FileCredentials, type Io, type OauthAccount, type Paths, posixJoin } from '../hooks/accounts.ts'

export const PATHS: Paths = {
  configDir: '/home/u/.claude',
  globalConfig: '/home/u/.claude.json',
  accountsDir: '/home/u/.claude/accounts',
  join: posixJoin,
}

export function storeFor(io: Io, creds: CredentialStore = new FileCredentials(io, posixJoin)): AccountStore {
  return new AccountStore(io, PATHS, creds)
}

export const BOB: OauthAccount = { accountUuid: 'b', emailAddress: 'bob@x.com', organizationUuid: 'org-b' }
export const ALICE: OauthAccount = { accountUuid: 'a', emailAddress: 'alice@x.com', organizationUuid: 'org-a', organizationName: 'Acme' }

export function creds(refresh: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${refresh}`, refreshToken: refresh, expiresAt: 9e12, subscriptionType: 'max', ...extra },
  })
}

export class FakeIo implements Io {
  files = new Map<string, string>()
  dirs = new Map<string, number>()
  clock = 1_000_000
  slept = 0

  read = async (path: string) => this.files.get(path) ?? null
  writeSecret = async (path: string, text: string) => {
    this.files.set(path, text)
  }
  list = async (dir: string) => {
    const names = new Set<string>()
    for (const p of this.files.keys()) {
      if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0])
    }
    return [...names]
  }
  removeTree = async (path: string) => {
    for (const p of [...this.files.keys()]) if (p === path || p.startsWith(`${path}/`)) this.files.delete(p)
  }
  mkdir = async (path: string) => {
    if (this.dirs.has(path)) return false
    this.dirs.set(path, this.clock)
    return true
  }
  rmdir = async (path: string) => {
    this.dirs.delete(path)
  }
  mtime = async (path: string) => this.dirs.get(path) ?? null
  sleep = async (ms: number) => {
    this.slept += ms
    this.clock += ms
  }
  now = async () => this.clock

  json(path: string): Record<string, unknown> {
    return JSON.parse(this.files.get(path) ?? 'null')
  }

  /** A machine signed in as bob in ~/.claude, with alice saved under the label Work. */
  static twoAccounts(): FakeIo {
    const io = new FakeIo()
    io.files.set(PATHS.globalConfig, JSON.stringify({ numStartups: 3, oauthAccount: BOB }))
    io.files.set(`${PATHS.configDir}/.credentials.json`, JSON.stringify({ ...JSON.parse(creds('rt-b', { subscriptionType: 'pro' })), mcpOAuth: { s: 1 } }))
    io.files.set(`${PATHS.accountsDir}/a_org-a/.credentials.json`, creds('rt-a'))
    io.files.set(`${PATHS.accountsDir}/a_org-a/account.json`, JSON.stringify({ label: 'Work', oauthAccount: ALICE }))
    return io
  }
}
