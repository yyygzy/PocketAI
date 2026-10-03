// 聊天正文字号档位：CSS 变量 --chat-font-size 驱动消息气泡正文 / Markdown / 输入框。
//
// 启动时由入口拉取 UI 偏好后应用；设置页切换时立即应用，无需重启。
// 与 custom-css 同构：主进程只存取档位值，渲染端负责落地样式。

import type { ChatFontSize } from '../../shared/types'
import { logIpcError } from './utils/ipc'

/** 三档对应的像素值（消息正文基准；Markdown 标题等用 em 相对缩放，自动跟随） */
export const FONT_SIZE_PX: Record<ChatFontSize, number> = {
  small: 13,
  medium: 14,
  large: 16
}

/** CSS 变量名（与 styles.css :root 中的缺省值保持一致） */
export const CHAT_FONT_VAR = '--chat-font-size'

/** 非法/缺失档位回退 medium */
export function normalizeFontSize(v: unknown): ChatFontSize {
  return v === 'small' || v === 'large' ? v : 'medium'
}

/** 立即把档位应用到 <html>；无 DOM 环境（单测）时静默跳过 */
export function applyChatFontSize(size: unknown): void {
  const key = normalizeFontSize(size)
  if (typeof document === 'undefined' || !document.documentElement) return
  document.documentElement.style.setProperty(CHAT_FONT_VAR, `${FONT_SIZE_PX[key]}px`)
}

/** 启动时拉取偏好并应用（失败静默，沿用 CSS 缺省 14px） */
export async function loadAndApplyChatFontSize(): Promise<void> {
  try {
    const r = await window.pocketai.getUiPrefs()
    if (r.ok && r.data) applyChatFontSize(r.data.chatFontSize)
  } catch (e) {
    logIpcError('loadAndApplyChatFontSize', e)
    /* 忽略：偏好读取失败不应阻断启动 */
  }
}
