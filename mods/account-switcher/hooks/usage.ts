import type { EngineInterface } from 'claude-code'
import type { Account } from './accounts.ts'

export interface UsageWindow {
  label: string
  used: number
  resetsAt?: string
}

export interface UsageEntry {
  status: 'loading' | 'ready' | 'unavailable' | 'sign-in' | 'refresh-login' | 'limited'
  windows: UsageWindow[]
  checkedAt?: number
  retryAt?: number
}

export interface UsageApi {
  fetch(accessToken: string): Promise<{ status: number; body: string; retryAfter?: string }>
}

export class HttpUsageApi implements UsageApi {
  constructor(private readonly fetchHttp: EngineInterface['http']['fetch'], private readonly baseUrl = 'https://api.anthropic.com') {}

  async fetch(accessToken: string) {
    const response = await this.fetchHttp(`${this.baseUrl.replace(/\/$/, '')}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    })
    return { status: response.status, body: response.text, retryAfter: response.headers['retry-after'] }
  }
}

export const USAGE_REFRESH_MS = 15_000

export function parseUsage(body: string): UsageWindow[] {
  const data: unknown = JSON.parse(body)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid usage response')
  const windows: UsageWindow[] = []
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'Week']]) {
    const raw = (data as Record<string, unknown>)[key as string]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'object') throw new Error('Invalid usage window')
    const { utilization, resets_at } = raw as { utilization?: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) throw new Error('Invalid usage percentage')
    const resetsAt = typeof resets_at === 'string' && Number.isFinite(Date.parse(resets_at)) ? resets_at : undefined
    windows.push({ label: label as string, used: utilization, ...(resetsAt ? { resetsAt } : {}) })
  }
  return windows
}

export class UsageCache {
  readonly entries = new Map<string, UsageEntry>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly api: UsageApi, private readonly now: () => Promise<number>) {}

  async refresh(account: Account, token: () => Promise<string | undefined>, force = false): Promise<void> {
    const pending = this.pending.get(account.dir)
    if (pending) return pending
    const work = this.load(account, token, force)
    this.pending.set(account.dir, work)
    try {
      await work
    } finally {
      this.pending.delete(account.dir)
    }
  }

  private async load(account: Account, token: () => Promise<string | undefined>, force: boolean): Promise<void> {
    const now = await this.now()
    if (account.needsLogin) {
      this.entries.set(account.dir, { status: 'sign-in', windows: [], checkedAt: now })
      return
    }
    const previous = this.entries.get(account.dir)
    if (previous?.retryAt && previous.retryAt > now) return
    const resetPassed = previous?.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now && Date.parse(w.resetsAt) > (previous.checkedAt ?? 0))
    if (!force && !resetPassed && previous?.checkedAt !== undefined && now - previous.checkedAt < USAGE_REFRESH_MS) return
    this.entries.set(account.dir, { status: 'loading', windows: [] })
    let entry: UsageEntry = { status: 'unavailable', windows: [], checkedAt: now }
    try {
      const accessToken = await token()
      if (!accessToken) {
        this.entries.set(account.dir, { ...entry, status: 'refresh-login' })
        return
      }
      const response = await this.api.fetch(accessToken)
      if (response.status === 200) {
        const windows = parseUsage(response.body)
        entry = { ...entry, status: windows.length ? 'ready' : 'unavailable', windows }
      } else if (response.status === 401 || response.status === 403) {
        entry.status = 'refresh-login'
      } else if (response.status === 429) {
        const seconds = response.retryAfter ? Number(response.retryAfter) : NaN
        const retryAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(response.retryAfter ?? '')
        entry = { ...entry, status: 'limited', retryAt: Math.max(now + USAGE_REFRESH_MS, Number.isFinite(retryAt) ? retryAt : 0) }
      }
    } catch {
      // Keep failed reads separate from an exhausted subscription budget.
    }
    this.entries.set(account.dir, entry)
  }
}

export function remaining(window: UsageWindow): number {
  return Math.max(0, Math.floor(100 - window.used))
}

export function usageStatus(entry: UsageEntry | undefined, now: number): { label: string; colour: string; exhausted?: true } {
  if (!entry || entry.status === 'loading') return { label: '· loading', colour: 'subtle' }
  if (entry.status === 'sign-in') return { label: '! sign in', colour: 'warning' }
  if (entry.status !== 'ready' || entry.checkedAt === undefined || now - entry.checkedAt >= USAGE_REFRESH_MS || entry.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now)) {
    return { label: '? unknown', colour: 'subtle' }
  }
  if (entry.windows.some(w => w.used >= 100)) return { label: '◷ exhausted', colour: 'error', exhausted: true }
  if (!['5h', 'Week'].every(label => entry.windows.some(w => w.label === label))) return { label: '? unknown', colour: 'subtle' }
  if (entry.windows.some(w => remaining(w) < 30)) return { label: '! low budget', colour: 'warning' }
  return { label: '○ available', colour: 'success' }
}

export function resetLabel(iso: string | undefined, timeZone?: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'Not reported'
  const date = new Date(iso)
  const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', ...(timeZone ? { timeZone } : {}) })
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) })
  return `${day.replace(',', '')} ${time}`
}
