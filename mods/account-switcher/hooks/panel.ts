import type { Elements, RenderElement } from 'claude-code'
import { type Account, displayName } from './accounts.ts'
import { clawdRows, hatById, type Segment } from './clawd.ts'
import { type UsageEntry, USAGE_STALE_MS, remaining, resetLabel, usageStatus } from './usage.ts'

export type PanelElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export interface PanelState {
  accounts: Account[]
  current: Account | undefined
  focused: string
  notice: string
  autoSwitch: boolean
  width: number
  height: number
  offset: number
  usage: ReadonlyMap<string, UsageEntry>
  now: number
}

export interface PanelActions {
  choose(account: Account): () => Promise<void>
  add(): Promise<void>
  toggleAutoSwitch(): Promise<void>
  refreshUsage(): Promise<void>
}

export const useKey = (account: Account) => `use-${account.key}`

export function nextPanelFocus(keys: string[], focused: string, direction: number): string | undefined {
  return keys[Math.max(0, Math.min(keys.length - 1, keys.indexOf(focused) + Math.sign(direction)))]
}

export function panelGeometry(width: number, height: number, count: number, offset: number) {
  const rowHeight = width < 44 ? 12 : 10
  const footerHeight = Math.min(8, Math.max(4, height - 5))
  const listHeight = Math.max(1, height - footerHeight - 2)
  const maxOffset = Math.max(0, count * rowHeight - (count ? 1 : 0) - listHeight)
  return { rowHeight, footerHeight, listHeight, maxOffset, offset: Math.max(0, Math.min(offset, maxOffset)) }
}

export function orderedAccounts(state: Pick<PanelState, 'accounts' | 'current'>): Account[] {
  return [...(state.current ? [state.current] : []), ...state.accounts.filter(a => a.dir !== state.current?.dir)]
}

function segmentLine({ Box, Text }: PanelElements, segments: Segment[]): RenderElement {
  return Box({ flexDirection: 'row', children: segments.map(s => Text({ color: s.colour, ...(s.background ? { backgroundColor: s.background } : {}), children: [s.text] })) })
}

function usageRows({ Box, Text }: PanelElements, entry: UsageEntry | undefined, state: PanelState, header: boolean): RenderElement[] {
  const text = (value: string, colour?: string) => Text({ ...(colour ? { color: colour } : { dimColor: true }), wrap: 'wrap', children: [value] })
  if (!entry || entry.status === 'loading') return [text('Reading usage…')]
  if (entry.status === 'sign-in') return [text('Sign in again with /login', 'warning')]
  if (entry.status === 'refresh-login') return [text('Usage unavailable · switch to refresh login')]
  if (entry.status === 'limited') return [text('Usage refresh rate-limited · try later')]
  if (entry.status !== 'ready') return [text('Usage unavailable · r to retry')]

  const narrow = state.width < 44
  const stale = entry.checkedAt === undefined || state.now - entry.checkedAt >= USAGE_STALE_MS
  const rows: RenderElement[] = header ? [text(narrow ? 'WINDOW  LEFT / RESETS' : 'WINDOW  LEFT       RESETS')] : []
  for (const label of ['5h', 'Week']) {
    const window = entry.windows.find(w => w.label === label)
    const resetPassed = window?.resetsAt && Date.parse(window.resetsAt) <= state.now
    const left = window && !stale && !resetPassed ? remaining(window) : undefined
    const fraction = left === 0 && window !== undefined && window.used < 100
    const colour = left === undefined ? 'subtle' : left === 0 && !fraction ? 'error' : left < 30 ? 'warning' : 'success'
    const blocks = left === undefined ? '····' : '▰'.repeat(Math.floor(left / 25)) + '▱'.repeat(4 - Math.floor(left / 25))
    const percent = left === undefined ? ' --%' : fraction ? ' <1%' : `${left}%`.padStart(4)
    const reset = resetPassed ? 'Reset passed · r to refresh' : resetLabel(window?.resetsAt)
    const values = Box({ flexDirection: 'row', children: [text(label.padEnd(8), 'text'), text(`${percent} ${blocks} `, colour)] })
    rows.push(narrow
      ? Box({ flexDirection: 'column', children: [values, text(`↻ ${reset}`)] })
      : Box({ flexDirection: 'row', children: [values, text(`↻ ${reset}`)] }))
  }
  return rows
}

/** Out of credits tints red, even on the active row, whose label still says it is active. */
export function rowBackground(active: boolean, focused: boolean, exhausted: boolean): string | undefined {
  if (exhausted) return focused ? 'rgb(74,40,43)' : 'rgb(52,30,33)'
  if (active) return focused ? 'rgb(40,65,49)' : 'rgb(31,48,38)'
  return focused ? 'rgb(53,53,57)' : undefined
}

function accountRow(el: PanelElements, state: PanelState, actions: PanelActions, account: Account, first: boolean): RenderElement {
  const { Box, Text, Button } = el
  const active = account.dir === state.current?.dir
  const focused = state.focused === useKey(account)
  const entry = account.needsLogin ? { status: 'sign-in' as const, windows: [] } : state.usage.get(account.dir)
  const status = usageStatus(entry, state.now)
  const backgroundColor = rowBackground(active, focused, status.exhausted === true)
  const plan = account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : ''
  return Box({ key: `row-${account.key}`, height: panelGeometry(state.width, state.height, state.accounts.length, 0).rowHeight - 1, backgroundColor, paddingX: 1, paddingY: 1, flexDirection: 'column', children: [
    Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: [
      Box({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', height: 4, children: [
        Box({ flexDirection: 'column', flexShrink: 1, children: [
          Box({ flexDirection: state.width < 44 ? 'column' : 'row', columnGap: 1, children: [
            Box({ flexShrink: 1, children: [Button({ key: useKey(account), plain: true, ...(first ? { autoFocus: true as const } : {}), onPress: actions.choose(account), children: [Text({ bold: true, color: 'text', wrap: 'truncate-end', children: [` ${displayName(account)} `] })] })] }),
            Text({ color: active ? 'success' : status.colour, children: [active ? '● active' : status.label] }),
          ] }),
          Box({ paddingLeft: 1, children: [Text({ dimColor: true, wrap: 'truncate-end', children: [[account.oauthAccount.emailAddress, plan].filter(Boolean).join(' · ')] })] }),
        ] }),
        ...(state.width >= 36 ? [Box({ flexDirection: 'column', flexShrink: 0, width: 9, height: 4, children: clawdRows(hatById(account.hat)).map(row => segmentLine(el, row)) })] : []),
      ] }),
      Box({ paddingLeft: 1, flexDirection: 'column', children: usageRows(el, entry, state, true) }),
    ] }),
  ] })
}

export function panel(el: PanelElements, state: PanelState, actions: PanelActions): RenderElement {
  const { Box, Text, Button } = el
  const accounts = orderedAccounts(state)
  const focused = state.accounts.find(a => state.focused === useKey(a))
  const geometry = panelGeometry(state.width, state.height, accounts.length, state.offset)
  const line = '─'.repeat(Math.max(1, state.width - (state.width < 36 ? 2 : 4)))
  const hint = (value: string) => Text({ dimColor: true, wrap: 'truncate-end', children: [value] })
  // One spare row keeps native scroll keys active; the hook scrolls only the list.
  return Box({ flexDirection: 'column', width: state.width, height: state.height + 1, paddingX: state.width < 36 ? 1 : 2, overflow: 'hidden', children: [
    Box({ height: 2, flexShrink: 0, justifyContent: 'space-between', children: [
      Text({ bold: true, children: ['Accounts'] }),
      hint(geometry.maxOffset ? `${geometry.offset > 0 ? '↑' : ' '} ${geometry.offset < geometry.maxOffset ? '↓' : ' '}` : ''),
    ] }),
    Box({ key: 'account-list', height: geometry.listHeight, flexShrink: 0, overflow: 'hidden', children: [
      Box({ position: 'absolute', top: -geometry.offset, left: 0, right: 0, flexDirection: 'column', children: accounts.length ? accounts.map((account, index) =>
        Box({ height: geometry.rowHeight, flexShrink: 0, flexDirection: 'column', overflow: 'hidden', children: [
          accountRow(el, state, actions, account, index === 0),
          Box({ position: 'absolute', bottom: 0, left: 0, right: 0, children: [hint(line)] }),
        ] })) : [hint('No saved accounts.')] }),
    ] }),
    Box({ key: 'account-footer', height: geometry.footerHeight, flexShrink: 0, flexDirection: 'column', overflow: 'hidden', children: [
      hint(line),
      Button({ key: 'auto-switch', plain: true, hotkey: 's', label: `Auto-switch: ${state.autoSwitch ? 'on' : 'off'}`, onPress: actions.toggleAutoSwitch }),
      Box({ flexDirection: state.width < 40 ? 'column' : 'row', columnGap: 2, children: [
        Button({ key: 'add', plain: true, hotkey: 'a', label: '+ Add account', onPress: actions.add }),
        Button({ key: 'refresh-usage', plain: true, hotkey: 'r', label: 'Refresh usage', onPress: actions.refreshUsage }),
      ] }),
      hint('15s refresh · local reset times'),
      ...(geometry.footerHeight >= 7 ? [hint(focused ? `${hatById(focused.hat).name} · ←→ to change hat` : '←→ change account hat')] : []),
      ...(geometry.footerHeight >= 8 && state.width >= 40 ? [state.notice
        ? Text({ color: 'warning', wrap: 'truncate-end', children: [state.notice] })
        : hint('Auto-switch tries each signed-in account.')] : []),
      ...(geometry.footerHeight >= 6 ? [hint('↑↓ / tab move · enter select')] : []),
      ...(geometry.footerHeight >= 5 ? [hint('esc close')] : []),
    ] }),
  ] })
}

export function panelRows(state: Pick<PanelState, 'accounts' | 'current'>): number {
  return 16 + state.accounts.length * 10
}
