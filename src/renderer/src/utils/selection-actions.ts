// 选区助手共享纯函数：主窗口划词浮条与浮窗 PopupApp 共用同一套动作定义/提示词。
// 提示词语言固定中文指令（模型普遍理解），输出语言在各条指令中明确约束。
import type { SelectionAction } from '../../../shared/types'
import { isEditableTarget } from './shortcuts'

/** 选区文本上限（与主进程 popup.ts MAX_SELECTION_TEXT 同一口径） */
export const MAX_SELECTION_TEXT = 8000

/** 浮条/浮窗动作展示顺序 */
export const SELECTION_ACTIONS: SelectionAction[] = ['translate', 'summary', 'polish', 'ask']

/**
 * 选区宿主是否位于可编辑区域（输入框/文本域/下拉/富文本及其后代）。
 * 复用 shortcuts.isEditableTarget 鸭子判定，并沿 parentElement 链上溯——
 * 选中文本的直接元素常是 contenteditable 内的子节点。
 */
export function isEditableSelectionHost(el: Element | null): boolean {
  let cur: Element | null = el
  // DOM 树深度有限；保险上限防环/异常伪对象
  for (let i = 0; i < 64 && cur; i++) {
    if (isEditableTarget(cur)) return true
    cur = 'parentElement' in cur ? (cur.parentElement as Element | null) : null
  }
  return false
}

/**
 * 规整选区文本：去首尾空白；空/纯空白返回 null（不弹浮条）；
 * 超长按上限截断（防误选整页灌爆浮窗与请求）。
 */
export function normalizeSelectionText(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  return text.length > MAX_SELECTION_TEXT ? text.slice(0, MAX_SELECTION_TEXT) : text
}

/**
 * 动作 → 发送给模型的完整提示词；ask（追问/自由问答）直接使用原文，
 * 用户可在浮窗输入框继续追问。
 */
export function composeSelectionPrompt(action: SelectionAction, text: string): string {
  switch (action) {
    case 'translate':
      return `请把下面的内容翻译成英文（若内容已是英文则翻译成简体中文）。只输出译文，不要解释。\n\n"""\n${text}\n"""`
    case 'summary':
      return `请用简体中文总结下面内容的要点，使用不超过 5 条要点的无序列表。\n\n"""\n${text}\n"""`
    case 'polish':
      return `请润色改写下面的内容，保持原意与原语言，只输出改写后的全文，不要解释。\n\n"""\n${text}\n"""`
    case 'ask':
      return text
  }
}
