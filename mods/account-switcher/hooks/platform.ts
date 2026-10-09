// The shell commands behind each file operation, per platform. Linux and macOS use
// POSIX tools; Windows uses PowerShell, which every supported Windows ships.

export type Platform = 'posix' | 'windows'

export interface Commands {
  /** Writes stdin to the path atomically, owner-only, creating parent directories. */
  writeSecret(path: string): string[]
  removeTree(path: string): string[]
  /** Exits 0 only if it created the directory. */
  mkdir(path: string): string[]
  rmdir(path: string): string[]
  read(path: string): string[]
}

// Writes go through a temp file and rename so readers never see half a file,
// and through readlink so a symlinked ~/.claude.json keeps its link.
const POSIX_WRITE = [
  'set -e',
  'umask 077',
  't=$1',
  'if [ -L "$t" ]; then t=$(readlink -f -- "$t"); fi',
  'mkdir -p -- "$(dirname -- "$t")"',
  'tmp="$t.tmp.$$"',
  'cat > "$tmp"',
  'mv -f -- "$tmp" "$t"',
].join('\n')

// The path arrives as an argument, never inside the script, so no quoting is needed.
// The file inherits the user profile's ACL, which only that user and SYSTEM can read.
const WINDOWS_WRITE = [
  '$t = $args[0]',
  '$item = Get-Item -LiteralPath $t -ErrorAction SilentlyContinue',
  'if ($item -and $item.LinkType) { $t = $item.Target }',
  '$dir = Split-Path -Parent $t',
  'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
  '$tmp = "$t.tmp.$PID"',
  '$text = [Console]::In.ReadToEnd()',
  '[IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding $false))',
  'Move-Item -LiteralPath $tmp -Destination $t -Force',
].join('; ')

const POWERSHELL = ['powershell', '-NoProfile', '-NonInteractive', '-Command']

const posix: Commands = {
  writeSecret: path => ['sh', '-c', POSIX_WRITE, 'sh', path],
  removeTree: path => ['rm', '-rf', '--', path],
  mkdir: path => ['mkdir', '--', path],
  rmdir: path => ['rmdir', '--', path],
  read: path => ['cat', '--', path],
}

const windows: Commands = {
  writeSecret: path => [...POWERSHELL, WINDOWS_WRITE, path],
  removeTree: path => [...POWERSHELL, 'Remove-Item -LiteralPath $args[0] -Recurse -Force -ErrorAction SilentlyContinue', path],
  // New-Item fails when the directory exists, which is what the lock relies on.
  mkdir: path => [...POWERSHELL, 'New-Item -ItemType Directory -Path $args[0] -ErrorAction Stop | Out-Null', path],
  rmdir: path => [...POWERSHELL, 'Remove-Item -LiteralPath $args[0] -Force -ErrorAction SilentlyContinue', path],
  read: path => [...POWERSHELL, 'Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8', path],
}

export function commandsFor(platform: Platform): Commands {
  return platform === 'windows' ? windows : posix
}

/** Windows always sets APPDATA and USERPROFILE; Linux and macOS set neither. */
export function detectPlatform(env: { appData?: string; userProfile?: string }): Platform {
  return env.appData && env.userProfile ? 'windows' : 'posix'
}

/**
 * The home directory Claude Code itself uses: USERPROFILE on Windows, HOME
 * elsewhere. Kept in its native spelling, since Claude Code names a credential
 * directory's Keychain item and lock files after the exact string.
 */
export function homeDir(platform: Platform, env: { home?: string; userProfile?: string }): string {
  return (platform === 'windows' ? env.userProfile || env.home : env.home) ?? ''
}

/** Joins path parts with the platform's separator. */
export function joiner(platform: Platform): (...parts: string[]) => string {
  const sep = platform === 'windows' ? '\\' : '/'
  return (...parts) => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep)
}
