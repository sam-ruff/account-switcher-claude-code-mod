import type { CredentialStore } from './accounts.ts'

/**
 * Picks the store Claude Code is using: the credentials file when one exists, as
 * on Linux and Windows and on recent macOS builds, else the macOS Keychain.
 */
export async function detectStore(
  files: CredentialStore,
  keychain: CredentialStore | undefined,
  defaultDir: string,
): Promise<CredentialStore> {
  if (!keychain || (await files.read(defaultDir))) return files
  return (await keychain.read(defaultDir)) ? keychain : files
}

/** Runs `security` and returns its exit code and output. */
export type Security = (args: string[], stdin?: string) => Promise<{ exitCode: number; stdout: string }>

const SERVICE = 'Claude Code-credentials'
const NOT_FOUND = 44

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The Keychain item Claude Code reads for a credential directory: the plain
 * service name for the default directory, and otherwise the name followed by the
 * first eight hex digits of the directory's SHA-256.
 */
export async function serviceFor(dir: string, defaultDir: string): Promise<string> {
  if (dir === defaultDir) return SERVICE
  return `${SERVICE}-${(await sha256Hex(dir.normalize('NFC'))).slice(0, 8)}`
}

/** macOS: each account's login is a generic password in the login Keychain. */
export class KeychainCredentials implements CredentialStore {
  constructor(
    private readonly security: Security,
    private readonly user: string,
    private readonly defaultDir: string,
  ) {}

  async read(dir: string): Promise<Record<string, unknown> | null> {
    const service = await serviceFor(dir, this.defaultDir)
    const r = await this.security(['find-generic-password', '-a', this.user, '-w', '-s', service])
    if (r.exitCode === NOT_FOUND || r.exitCode !== 0) return null
    try {
      const value: unknown = JSON.parse(r.stdout.trim())
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  async write(dir: string, creds: Record<string, unknown>): Promise<void> {
    const service = await serviceFor(dir, this.defaultDir)
    const hex = [...new TextEncoder().encode(JSON.stringify(creds))].map(b => b.toString(16).padStart(2, '0')).join('')
    // Passing the secret on stdin through `security -i` keeps it out of the process list.
    const line = `add-generic-password -U -a "${this.user}" -s "${service}" -X "${hex}"\n`
    const r = await this.security(['-i'], line)
    if (r.exitCode !== 0) throw new Error(`could not save the login to the Keychain (security exited ${r.exitCode})`)
  }

  async remove(dir: string): Promise<void> {
    const service = await serviceFor(dir, this.defaultDir)
    await this.security(['delete-generic-password', '-a', this.user, '-s', service])
  }
}
