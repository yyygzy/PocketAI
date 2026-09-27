import { describe, it, expect } from 'vitest'
import { matchAgentShortcut, type ShortcutKeyEvent } from '../src/renderer/src/modules/agent/agent-shared'

const ev = (p: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...p
})
const ctrl = (key: string, p: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent =>
  ev({ key, ctrlKey: true, ...p })

describe('matchAgentShortcut', () => {
  it('Ctrl+N 新建会话（macOS Cmd 也支持）', () => {
    expect(matchAgentShortcut(ctrl('n'), { running: false, searchEnabled: true })).toBe('new')
    expect(matchAgentShortcut(ctrl('N'), { running: false, searchEnabled: true })).toBe('new')
    expect(matchAgentShortcut(ev({ key: 'n', metaKey: true }), { running: false, searchEnabled: true })).toBe('new')
  })

  it('Ctrl+K 打开搜索；无消息时禁用（与按钮一致）', () => {
    expect(matchAgentShortcut(ctrl('k'), { running: false, searchEnabled: true })).toBe('search')
    expect(matchAgentShortcut(ctrl('k'), { running: false, searchEnabled: false })).toBeNull()
  })

  it('Ctrl+/ 聚焦输入框，运行中也可用（textarea disabled 时全局聚焦无意义但不报错）', () => {
    expect(matchAgentShortcut(ctrl('/'), { running: true, searchEnabled: true })).toBe('focusComposer')
  })

  it('Esc 仅运行中触发停止', () => {
    expect(matchAgentShortcut(ev({ key: 'Escape' }), { running: true, searchEnabled: true })).toBe('abort')
    expect(matchAgentShortcut(ev({ key: 'Escape' }), { running: false, searchEnabled: true })).toBeNull()
  })

  it('Alt 组合不参与，避免与系统/输入法冲突', () => {
    expect(matchAgentShortcut(ctrl('n', { altKey: true }), { running: false, searchEnabled: true })).toBeNull()
    expect(matchAgentShortcut(ev({ key: 'Escape', altKey: true }), { running: true, searchEnabled: true })).toBeNull()
  })

  it('Shift 修饰的 Ctrl 组合不匹配（如 Ctrl+Shift+N）', () => {
    expect(matchAgentShortcut(ctrl('N', { shiftKey: true }), { running: false, searchEnabled: true })).toBeNull()
  })

  it('普通按键与带修饰的 Esc 均不匹配', () => {
    expect(matchAgentShortcut(ev({ key: 'n' }), { running: false, searchEnabled: true })).toBeNull()
    expect(matchAgentShortcut(ctrl('Escape'), { running: true, searchEnabled: true })).toBeNull()
    expect(matchAgentShortcut(ctrl('x'), { running: false, searchEnabled: true })).toBeNull()
  })
})
