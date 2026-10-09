// The account sidebar: the session's account in a box at the top, the others
// below, each with Clawd on the right wearing that account's hat.
import { type Account, displayName } from './accounts.ts'
import { clawdRows, hatById, type Segment } from './clawd.ts'

type Element = (props: object) => unknown

export interface PanelElements {
  Box: Element
  Text: Element
  Button: Element
}

export interface PanelState {
  accounts: Account[]
  current: Account | undefined
  /** Key of the control holding the keyboard, as `ui.focus` named it. */
  focused: string
  notice: string
  width: number
}

export interface PanelActions {
  choose(account: Account): () => Promise<void>
  add(): Promise<void>
}

export const useKey = (account: Account) => `use-${account.key}`

function plan(account: Account): string {
  return account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : ''
}

function segmentLine({ Box, Text }: PanelElements, segments: Segment[]): unknown {
  return Box({
    flexDirection: 'row',
    children: segments.map(s => Text({ color: s.colour, ...(s.background ? { backgroundColor: s.background } : {}), children: [s.text] })),
  })
}

function clawd(el: PanelElements, account: Account): unknown {
  return el.Box({ flexDirection: 'column', flexShrink: 0, children: clawdRows(hatById(account.hat)).map(row => segmentLine(el, row)) })
}

/** The rows of text beside Clawd: email and plan, then organisation, then any warning. */
function details(el: PanelElements, account: Account, dim: boolean): unknown[] {
  const { Text } = el
  return [
    Text({ dimColor: dim, wrap: 'truncate-end', children: [[account.oauthAccount.emailAddress, plan(account)].filter(Boolean).join(' · ')] }),
    Text({ dimColor: dim, wrap: 'truncate-end', children: [account.oauthAccount.organizationName ?? ' '] }),
    ...(account.needsLogin ? [Text({ color: 'warning', wrap: 'truncate-end', children: ['sign in again with /login'] })] : []),
  ]
}

export function panel(el: PanelElements, state: PanelState, actions: PanelActions): unknown {
  const { Box, Text, Button } = el
  const blank = () => Text({ children: [' '] })
  const isFocused = (a: Account) => state.focused === useKey(a)
  // The terminal inverts the focused Button's text, so each row's Button holds
  // only its marker and the row draws its own highlight around it.
  const select = (a: Account, marker: unknown, autoFocus: boolean) =>
    Button({ key: useKey(a), plain: true, onPress: actions.choose(a), ...(autoFocus ? { autoFocus: true as const } : {}), children: [marker] })

  const mine = state.current
  const others = state.accounts.filter(a => a.dir !== mine?.dir)
  const addFocused = state.focused === 'add'
  const focusedAccount = state.accounts.find(isFocused)

  const active = mine
    ? Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        borderStyle: 'round',
        borderColor: isFocused(mine) ? 'claude' : 'success',
        paddingX: 2,
        marginTop: 1,
        children: [
          Box({ flexDirection: 'column', flexShrink: 1, children: [
            Box({ flexDirection: 'row', children: [
              select(mine, Text({ children: [''] }), true),
              Text({ bold: true, wrap: 'truncate-end', children: [displayName(mine)] }),
              Text({ color: 'success', children: ['  ● active'] }),
            ] }),
            ...details(el, mine, true),
          ] }),
          clawd(el, mine),
        ],
      })
    : Text({ dimColor: true, wrap: 'wrap', children: ['This session is not signed in with a saved account.'] })

  const rows = others.map((a, i) => {
    const f = isFocused(a)
    return Box({
      key: `row-${a.key}`,
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 1,
      children: [
        Box({ flexDirection: 'row', flexShrink: 1, children: [
          select(a, Text({ color: f ? 'claude' : 'subtle', children: [f ? '┃' : '│'] }), !mine && i === 0),
          Box({ flexDirection: 'column', flexShrink: 1, paddingLeft: 1, children: [
            Text({ bold: true, color: f ? 'claude' : 'text', wrap: 'truncate-end', children: [displayName(a)] }),
            ...details(el, a, !f),
          ] }),
        ] }),
        Box({ paddingRight: 2, flexShrink: 0, children: [clawd(el, a)] }),
      ],
    })
  })

  return Box({
    flexDirection: 'column',
    width: state.width,
    paddingX: 2,
    paddingY: 1,
    children: [
      Text({ dimColor: true, bold: true, children: ['ACTIVE'] }),
      active,
      ...(others.length ? [blank(), Text({ dimColor: true, bold: true, children: ['SWITCH TO'] }), ...rows] : []),
      blank(),
      Box({ flexDirection: 'row', children: [
        Text({ color: addFocused ? 'claude' : 'subtle', children: [addFocused ? '┃ ' : '  '] }),
        Button({
          key: 'add',
          plain: true,
          hotkey: 'a',
          onPress: () => actions.add(),
          children: [Text({ color: addFocused ? 'claude' : 'suggestion', bold: addFocused, children: ['+ Add an account'] })],
        }),
      ] }),
      blank(),
      Text({ dimColor: true, wrap: 'truncate-end', children: [focusedAccount ? `${hatById(focusedAccount.hat).name} · ←→ to change hat` : ' '] }),
      Text({ dimColor: true, wrap: 'wrap', children: ['↑↓ move  ⏎ switch  a add  esc close'] }),
      ...(state.notice ? [blank(), Text({ color: 'warning', wrap: 'wrap', children: [state.notice] })] : []),
    ],
  })
}

/** Rows the panel needs, so an inline pane opens tall enough to show every account. */
export function panelRows(state: Pick<PanelState, 'accounts' | 'current'>): number {
  const others = state.accounts.filter(a => a.dir !== state.current?.dir)
  return 2 + 1 + 6 + (others.length ? 2 + others.length * 5 : 0) + 6
}
