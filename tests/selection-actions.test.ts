// 选区助手共享纯函数测试（划词浮条 / PopupApp 动作）
import { describe, it, expect } from 'vitest'
import {
  MAX_SELECTION_TEXT,
  SELECTION_ACTIONS,
  composeSelectionPrompt,
  isEditableSelectionHost,
  normalizeSelectionText
} from '../src/renderer/src/utils/selection-actions'

/** 仿 shortcuts.test.ts 的鸭子类型假元素（node 环境无 DOM） */
function fakeEl(tag: string, contentEditable = false, parent?: unknown): Record<string, unknown> {
  return {
    tagName: tag,
    isContentEditable: contentEditable,
    parentElement: parent ?? null
  }
}

describe('SELECTION_ACTIONS', () => {
  it('四动作固定顺序', () => {
    expect(SELECTION_ACTIONS).toEqual(['translate', 'summary', 'polish', 'ask'])
  })
})

describe('isEditableSelectionHost', () => {
  it('null 安全', () => {
    expect(isEditableSelectionHost(null)).toBe(false)
  })

  it('输入元素自身命中', () => {
    expect(isEditableSelectionHost(fakeEl('TEXTAREA') as never)).toBe(true)
    expect(isEditableSelectionHost(fakeEl('INPUT') as never)).toBe(true)
    expect(isEditableSelectionHost(fakeEl('SELECT') as never)).toBe(true)
    expect(isEditableSelectionHost(fakeEl('DIV', true) as never)).toBe(true)
  })

  it('普通正文元素不命中', () => {
    expect(isEditableSelectionHost(fakeEl('DIV') as never)).toBe(false)
    expect(isEditableSelectionHost(fakeEl('P') as never)).toBe(false)
    expect(isEditableSelectionHost(fakeEl('CODE') as never)).toBe(false)
  })

  it('沿 parentElement 链上溯：富文本/输入框后代命中，正文后代不命中', () => {
    // contenteditable 内的子节点（常见于 Markdown 富文本/输入框内部）
    const child = fakeEl('SPAN', false, fakeEl('DIV', true))
    expect(isEditableSelectionHost(child as never)).toBe(true)
    // 普通气泡正文内的多层子节点
    const deep = fakeEl('CODE', false, fakeEl('PRE', false, fakeEl('DIV', false)))
    expect(isEditableSelectionHost(deep as never)).toBe(false)
  })
})

describe('normalizeSelectionText', () => {
  it('空串 / 纯空白 → null', () => {
    expect(normalizeSelectionText('')).toBeNull()
    expect(normalizeSelectionText('   \n\t  ')).toBeNull()
  })

  it('去首尾空白', () => {
    expect(normalizeSelectionText('  你好 世界 \n')).toBe('你好 世界')
  })

  it('超长截断到 8000（内部空白保留）', () => {
    const long = 'a'.repeat(MAX_SELECTION_TEXT + 500)
    const out = normalizeSelectionText(long)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(MAX_SELECTION_TEXT)
  })

  it('恰好上限不截断', () => {
    const edge = '字'.repeat(MAX_SELECTION_TEXT)
    expect(normalizeSelectionText(edge)).toBe(edge)
  })
})

describe('composeSelectionPrompt', () => {
  const text = 'The quick brown fox.'

  it('ask 原样返回文本（用户在浮窗继续追问）', () => {
    expect(composeSelectionPrompt('ask', text)).toBe(text)
  })

  it('四个动作都包含原文', () => {
    for (const a of SELECTION_ACTIONS) {
      expect(composeSelectionPrompt(a, text)).toContain(text)
    }
  })

  it('translate 含翻译指令且约束只输出译文', () => {
    const p = composeSelectionPrompt('translate', text)
    expect(p).toContain('翻译')
    expect(p).toContain('只输出译文')
  })

  it('summary 含中文要点/列表指令', () => {
    const p = composeSelectionPrompt('summary', text)
    expect(p).toContain('总结')
    expect(p).toContain('要点')
  })

  it('polish 含润色改写与保持原意指令', () => {
    const p = composeSelectionPrompt('polish', text)
    expect(p).toContain('润色改写')
    expect(p).toContain('保持原意')
  })
})
