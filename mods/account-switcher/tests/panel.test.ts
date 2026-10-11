import { expect, test } from 'claude-code/testing'
import { nextPanelFocus, panelGeometry } from '../hooks/panel.ts'

test('account scrolling reserves space for the fixed header and footer', () => {
  for (const width of [30, 52, 78]) {
    for (const height of [14, 20, 55]) {
      const start = panelGeometry(width, height, 12, -10)
      const end = panelGeometry(width, height, 12, 9999)
      expect(start.offset).toBe(0)
      expect(end.offset).toBe(end.maxOffset)
      expect(end.listHeight + end.footerHeight + 2).toBe(height)
      expect(end.offset + end.listHeight).toBe(12 * end.rowHeight - 1)
    }
  }
})

test('arrow navigation includes accounts and controls and stops at either end', () => {
  const keys = ['home', 'work', 'auto-switch', 'add', 'refresh']
  expect(nextPanelFocus(keys, 'home', 1)).toBe('work')
  expect(nextPanelFocus(keys, 'work', -1)).toBe('home')
  expect(nextPanelFocus(keys, 'work', 1)).toBe('auto-switch')
  expect(nextPanelFocus(keys, 'auto-switch', -1)).toBe('work')
  expect(nextPanelFocus(keys, 'home', -1)).toBe('home')
  expect(nextPanelFocus(keys, 'refresh', 1)).toBe('refresh')
  expect(nextPanelFocus([], '', 1)).toBeUndefined()
})
