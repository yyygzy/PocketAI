// 应用内快捷键纯函数测试（node 环境，事件/元素用鸭子类型对象构造）
import { describe, expect, it } from 'vitest'
import { isEditableTarget, matchAppShortcut, type ShortcutKeyLike } from '../src/renderer/src/utils/shortcuts'

function key(partial: Partial<ShortcutKeyLike> & Pick<ShortcutKeyLike, 'key'>): ShortcutKeyLike {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...partial }
}

/** 伪装成某类 DOM 元素（node 环境无 HTMLElement，纯函数按鸭子类型判定） */
function fakeEl(tagName: string, isContentEditable = false): object {
  return { tagName, isContentEditable }
}

describe('matchAppShortcut 修饰键组合', () => {
  it('Ctrl+N / Ctrl+K / Ctrl+/ 命中会话类动作', () => {
    expect(matchAppShortcut(key({ key: 'n', ctrlKey: true }), { running: false })?.id).toBe('newConv')
    expect(matchAppShortcut(key({ key: 'k', ctrlKey: true }), { running: false })?.id).toBe('focusSearch')
    expect(matchAppShortcut(key({ key: '/', ctrlKey: true }), { running: false })?.id).toBe('focusComposer')
  })

  it('Ctrl+W / Ctrl+, / Ctrl+L 命中窗口类动作', () => {
    expect(matchAppShortcut(key({ key: 'w', ctrlKey: true }), { running: false })).toEqual({ id: 'closeTab' })
    expect(matchAppShortcut(key({ key: ',', ctrlKey: true }), { running: false })).toEqual({ id: 'openSettings' })
    expect(matchAppShortcut(key({ key: 'l', ctrlKey: true }), { running: false })).toEqual({ id: 'lock' })
  })

  it('Ctrl+1~9 命中切标签并带序号；0 不命中', () => {
    expect(matchAppShortcut(key({ key: '1', ctrlKey: true }), { running: false })).toEqual({ id: 'tab', tabIndex: 1 })
    expect(matchAppShortcut(key({ key: '9', ctrlKey: true }), { running: false })).toEqual({ id: 'tab', tabIndex: 9 })
    expect(matchAppShortcut(key({ key: '5', ctrlKey: true }), { running: false })).toEqual({ id: 'tab', tabIndex: 5 })
    expect(matchAppShortcut(key({ key: '0', ctrlKey: true }), { running: false })).toBeNull()
  })

  it('Meta(⌘) 与 Ctrl 等价；key 大小写不敏感', () => {
    expect(matchAppShortcut(key({ key: 'N', metaKey: true }), { running: false })?.id).toBe('newConv')
    expect(matchAppShortcut(key({ key: 'W', metaKey: true }), { running: false })?.id).toBe('closeTab')
  })

  it('Alt 组合一律不命中（Ctrl+Alt 同按也不行）', () => {
    expect(matchAppShortcut(key({ key: 'n', ctrlKey: true, altKey: true }), { running: false })).toBeNull()
    expect(matchAppShortcut(key({ key: 'n', altKey: true }), { running: false })).toBeNull()
  })

  it('带 Shift 的修饰组合不命中（避免 Shift+数字等符号误触）', () => {
    expect(matchAppShortcut(key({ key: 'k', ctrlKey: true, shiftKey: true }), { running: false })).toBeNull()
    // Shift+1 = !，e.key 为 '!'，既不是数字也不是字母动作
    expect(matchAppShortcut(key({ key: '!', ctrlKey: true }), { running: false })).toBeNull()
  })

  it('未注册组合与纯字母不命中', () => {
    expect(matchAppShortcut(key({ key: 'x', ctrlKey: true }), { running: false })).toBeNull()
    expect(matchAppShortcut(key({ key: 'n' }), { running: false })).toBeNull()
  })

  it('修饰键组合在输入框聚焦时仍命中（中枢需接管 preventDefault）', () => {
    const inInput = key({ key: 'w', ctrlKey: true, target: fakeEl('INPUT') as EventTarget })
    expect(matchAppShortcut(inInput, { running: false })?.id).toBe('closeTab')
    const inTextarea = key({ key: 'l', ctrlKey: true, target: fakeEl('TEXTAREA') as EventTarget })
    expect(matchAppShortcut(inTextarea, { running: false })?.id).toBe('lock')
  })
})

describe('matchAppShortcut Esc 停止生成', () => {
  it('运行中 + 无修饰 + 非编辑态焦点 → abort', () => {
    expect(matchAppShortcut(key({ key: 'Escape' }), { running: true })).toEqual({ id: 'abort' })
    expect(matchAppShortcut(key({ key: 'Escape', target: fakeEl('DIV') as EventTarget }), { running: true })).toEqual({
      id: 'abort'
    })
  })

  it('非运行中不命中', () => {
    expect(matchAppShortcut(key({ key: 'Escape' }), { running: false })).toBeNull()
  })

  it('带修饰键不命中', () => {
    expect(matchAppShortcut(key({ key: 'Escape', ctrlKey: true }), { running: true })).toBeNull()
    expect(matchAppShortcut(key({ key: 'Escape', altKey: true }), { running: true })).toBeNull()
    expect(matchAppShortcut(key({ key: 'Escape', shiftKey: true }), { running: true })).toBeNull()
  })

  it('焦点在输入框/文本域/富文本时不命中（Esc 留给控件自身）', () => {
    for (const el of [fakeEl('INPUT'), fakeEl('TEXTAREA'), fakeEl('SELECT'), fakeEl('DIV', true)]) {
      expect(matchAppShortcut(key({ key: 'Escape', target: el as EventTarget }), { running: true })).toBeNull()
    }
  })
})

describe('isEditableTarget', () => {
  it('null / undefined / 非对象 → false', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })

  it('INPUT / TEXTAREA / SELECT / contentEditable → true；普通元素 → false', () => {
    expect(isEditableTarget(fakeEl('INPUT') as EventTarget)).toBe(true)
    expect(isEditableTarget(fakeEl('TEXTAREA') as EventTarget)).toBe(true)
    expect(isEditableTarget(fakeEl('SELECT') as EventTarget)).toBe(true)
    expect(isEditableTarget(fakeEl('DIV', true) as EventTarget)).toBe(true)
    expect(isEditableTarget(fakeEl('DIV') as EventTarget)).toBe(false)
    expect(isEditableTarget(fakeEl('BUTTON') as EventTarget)).toBe(false)
  })
})
