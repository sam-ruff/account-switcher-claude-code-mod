import { expect, test } from 'claude-code/testing'
import { type Account } from '../hooks/accounts.ts'
import { HttpUsageApi, UsageCache, parseUsage, remaining, resetLabel, usageStatus } from '../hooks/usage.ts'

const NOW = Date.parse('2026-10-11T13:10:00Z')
const ACCOUNT: Account = { key: 'work', dir: '/accounts/work', isHome: false, needsLogin: false, oauthAccount: { accountUuid: 'work' } }
const BODY = JSON.stringify({ five_hour: { utilization: 36, resets_at: '2026-10-11T15:30:00Z' }, seven_day: { utilization: 72, resets_at: '2026-10-14T08:00:00Z' } })

test('usage parses percentages and formats the local reset date across daylight saving', () => {
  const windows = parseUsage(BODY)
  expect(windows.map(remaining)).toEqual([64, 28])
  expect(resetLabel(windows[0]?.resetsAt, 'Europe/London')).toBe('Sun 11 Oct 16:30')
  expect(resetLabel('2026-10-26T16:30:00Z', 'Europe/London')).toBe('Mon 26 Oct 16:30')
  expect(resetLabel(undefined)).toBe('Not reported')
  expect(parseUsage('{"five_hour":null}')).toEqual([])
  expect(remaining({ label: 'Week', used: 120 })).toBe(0)
})

test('usage status never calls unavailable or stale data available', () => {
  expect(usageStatus({ status: 'unavailable', windows: [] }, NOW).label).toBe('? unknown')
  expect(usageStatus({ status: 'ready', windows: parseUsage(BODY), checkedAt: NOW }, NOW).label).toBe('! low budget')
  expect(usageStatus({ status: 'ready', windows: [{ label: '5h', used: 100 }], checkedAt: NOW }, NOW)).toEqual({ label: '◷ exhausted', colour: 'error', exhausted: true })
  expect(usageStatus({ status: 'ready', windows: parseUsage(BODY), checkedAt: NOW }, NOW).exhausted).toBeUndefined()
  expect(usageStatus({ status: 'ready', windows: parseUsage(BODY), checkedAt: NOW - 15000 }, NOW).label).toBe('! low budget')
  expect(usageStatus({ status: 'ready', windows: parseUsage(BODY), checkedAt: NOW - 30000 }, NOW).label).toBe('? unknown')
  expect(usageStatus({ status: 'ready', windows: parseUsage(BODY), checkedAt: NOW }, NOW + 86400000).label).toBe('? unknown')
  expect(usageStatus({ status: 'ready', windows: [{ label: '5h', used: 10 }], checkedAt: NOW }, NOW).label).toBe('? unknown')
})

test('a passed reset triggers one fresh read without repeatedly bypassing the cache', async () => {
  let now = NOW
  let calls = 0
  const body = JSON.stringify({ five_hour: { utilization: 100, resets_at: new Date(NOW + 1000).toISOString() } })
  const cache = new UsageCache({ fetch: async () => { calls++; return { status: 200, body } } }, async () => now)
  await cache.refresh(ACCOUNT, async () => 'token')
  now += 2000
  await cache.refresh(ACCOUNT, async () => 'token')
  await cache.refresh(ACCOUNT, async () => 'token')
  expect(calls).toBe(2)
  expect(usageStatus(cache.entries.get(ACCOUNT.dir), now).label).toBe('? unknown')
})

test('usage fetch is injected, cached per account and forced on refresh', async () => {
  const tokens: string[] = []
  const cache = new UsageCache({ fetch: async token => { tokens.push(token); return { status: 200, body: BODY } } }, async () => NOW)
  await cache.refresh(ACCOUNT, async () => 'work-token')
  await cache.refresh(ACCOUNT, async () => 'work-token')
  await cache.refresh({ ...ACCOUNT, dir: '/accounts/personal' }, async () => 'personal-token')
  await cache.refresh(ACCOUNT, async () => 'work-token', true)
  expect(tokens).toEqual(['work-token', 'personal-token', 'work-token'])
  expect(cache.entries.get(ACCOUNT.dir)?.status).toBe('ready')
})

test('a refresh keeps the last reading visible until the new one arrives', async () => {
  let release = () => {}
  let calls = 0
  const cache = new UsageCache({
    fetch: async () => {
      if (calls++ > 0) await new Promise<void>(resolve => { release = resolve })
      return { status: 200, body: BODY }
    },
  }, async () => NOW)
  await cache.refresh(ACCOUNT, async () => 'token')
  const before = cache.entries.get(ACCOUNT.dir)

  const refreshing = cache.refresh(ACCOUNT, async () => 'token', true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(cache.entries.get(ACCOUNT.dir)).toBe(before)

  release()
  await refreshing
  expect(cache.entries.get(ACCOUNT.dir)?.status).toBe('ready')
  expect(calls).toBe(2)
})

test('the first read shows a loading placeholder', async () => {
  let release = () => {}
  const cache = new UsageCache({
    fetch: async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { status: 200, body: BODY }
    },
  }, async () => NOW)
  const reading = cache.refresh(ACCOUNT, async () => 'token')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(cache.entries.get(ACCOUNT.dir)?.status).toBe('loading')
  release()
  await reading
})

test('cached usage expires after fifteen seconds', async () => {
  let now = NOW
  let reads = 0
  const cache = new UsageCache({ fetch: async () => { reads++; return { status: 200, body: BODY } } }, async () => now)
  await cache.refresh(ACCOUNT, async () => 'token')
  now += 14999
  await cache.refresh(ACCOUNT, async () => 'token')
  expect(reads).toBe(1)
  now++
  await cache.refresh(ACCOUNT, async () => 'token')
  expect(reads).toBe(2)
})

test('missing or expired logins skip the usage API entirely', async () => {
  let calls = 0
  const cache = new UsageCache({ fetch: async () => { calls++; return { status: 200, body: BODY } } }, async () => NOW)
  await cache.refresh({ ...ACCOUNT, needsLogin: true }, async () => 'never-read')
  expect(cache.entries.get(ACCOUNT.dir)?.status).toBe('sign-in')
  await cache.refresh({ ...ACCOUNT, dir: '/expired' }, async () => undefined)
  expect(cache.entries.get('/expired')?.status).toBe('refresh-login')
  expect(calls).toBe(0)
})

test('rate-limited usage reads respect backoff even for a manual refresh', async () => {
  let now = NOW
  let calls = 0
  const cache = new UsageCache({ fetch: async () => { calls++; return { status: 429, body: '', retryAfter: '600' } } }, async () => now)
  await cache.refresh(ACCOUNT, async () => 'token')
  now += 300000
  await cache.refresh(ACCOUNT, async () => 'token', true)
  expect(calls).toBe(1)
  expect(cache.entries.get(ACCOUNT.dir)?.status).toBe('limited')
  now += 300001
  await cache.refresh(ACCOUNT, async () => 'token')
  expect(calls).toBe(2)
})

test('bad responses and network errors leave usage unknown without exposing credentials', async () => {
  for (const response of [{ status: 500, body: 'token-secret' }, { status: 200, body: '{bad' }, { status: 200, body: '{"five_hour":{"utilization":"100"}}' }]) {
    const cache = new UsageCache({ fetch: async () => response }, async () => NOW)
    await cache.refresh(ACCOUNT, async () => 'token-secret')
    expect(cache.entries.get(ACCOUNT.dir)?.status).toBe('unavailable')
  }
  const cache = new UsageCache({ fetch: async () => { throw new Error('token-secret') } }, async () => NOW)
  await cache.refresh(ACCOUNT, async () => 'token-secret')
  expect(cache.entries.get(ACCOUNT.dir)).toEqual({ status: 'unavailable', windows: [], checkedAt: NOW })
})

test('usage HTTP adapter sends account-specific auth through its injected transport', async () => {
  const response = await new HttpUsageApi(async (url, init) => {
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(init?.headers?.Authorization).toBe('Bearer test-token')
    expect(init?.headers?.['anthropic-beta']).toBe('oauth-2025-04-20')
    return { status: 200, ok: true, headers: {}, text: BODY }
  }).fetch('test-token')
  expect(response.body).toBe(BODY)
})
