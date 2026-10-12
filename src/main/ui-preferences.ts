// 界面偏好管理
//
// ui.opacity     窗口透明度（0.6–1），主进程 BrowserWindow.setOpacity
//                Windows / macOS 原生支持；Linux 取决于窗口管理器（不支持时静默无效）
// ui.custom_css  自定义 CSS 文本，渲染端读取后注入 <style>，主进程只负责存取
//
// 安全：CSS 仅作用于本应用渲染进程沙箱，不接触 Node API；限制长度防止误塞大内容。

import { BrowserWindow } from 'electron'
import { appConfigRepo } from './db/repositories/app-config.repo'
import type { UiPreferences, ChatFontSize } from '../shared/types'
import { uiPrefsPatchSchema } from '../shared/schemas/preferences'

const K_OPACITY = 'ui.opacity'
const K_CUSTOM_CSS = 'ui.custom_css'
const K_CHAT_FONT_SIZE = 'ui.chat_font_size'
const K_CODE_COLLAPSE_LINES = 'ui.code_collapse_lines'
// Agent 模块「上次用在哪」：助手 + 会话。存这里而不是 localStorage，是因为 app_config 属于
// 合并时的 LOCAL_KEEP 表——换机合并不会把另一台机器的"上次会话"搬过来（那是会点错人的状态）
const K_AGENT_ASSISTANT_ID = 'ui.agent_assistant_id'
const K_AGENT_CONVERSATION_ID = 'ui.agent_conversation_id'

/** 偏好里存的实体 id 上限（DB 用 UUID，36 字符；128 足够宽松又不致于塞进大内容） */
export const MAX_PREFERENCE_ID_CHARS = 128

/** id 类偏好：只保留去空白 + 限长；其余原样（空串=清除，由调用方决定语义） */
function normalizePreferenceId(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, MAX_PREFERENCE_ID_CHARS)
}

export const MIN_OPACITY = 0.6
export const MAX_OPACITY = 1
export const MAX_CSS_LENGTH = 200_000
/** 代码块折叠阈值：默认 20 行；0 是合法值（永不折叠），只有脏数据才回落默认 */
export const DEFAULT_CODE_COLLAPSE_LINES = 20
export const MAX_CODE_COLLAPSE_LINES = 200

const FONT_SIZES: readonly ChatFontSize[] = ['small', 'medium', 'large']

/** 非法/缺失字号档位回退 medium */
export function normalizeChatFontSize(v: string | null | undefined): ChatFontSize {
  return v && (FONT_SIZES as readonly string[]).includes(v) ? (v as ChatFontSize) : 'medium'
}

/** 代码块折叠阈值：向下取整并夹到 0–200；0 合法（永不折叠），仅脏值（NaN/负数/非数字）回落默认 20 */
export function normalizeCodeCollapseLines(v: unknown): number {
  if (v === null || v === undefined || v === '') return DEFAULT_CODE_COLLAPSE_LINES
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CODE_COLLAPSE_LINES
  return Math.min(MAX_CODE_COLLAPSE_LINES, Math.floor(n))
}

/** 主窗口标记属性（不靠标题区分，避免浮窗/独立窗口同标题被误应用透明度） */
export const MAIN_WINDOW_MARKER = '__pocketaiMainWindow' as const

/** 打了主窗口标记的 BrowserWindow 视图 */
export type MarkedBrowserWindow = BrowserWindow & {
  [K in typeof MAIN_WINDOW_MARKER]?: boolean
}

export function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, v))
}

export function getUiPreferences(): UiPreferences {
  const raw = Number(appConfigRepo.get(K_OPACITY))
  return {
    opacity: Number.isFinite(raw) && raw > 0 ? clampOpacity(raw) : 1,
    customCss: appConfigRepo.get(K_CUSTOM_CSS) ?? '',
    chatFontSize: normalizeChatFontSize(appConfigRepo.get(K_CHAT_FONT_SIZE)),
    codeCollapseLines: normalizeCodeCollapseLines(appConfigRepo.get(K_CODE_COLLAPSE_LINES)),
    agentAssistantId: normalizePreferenceId(appConfigRepo.get(K_AGENT_ASSISTANT_ID)),
    agentConversationId: normalizePreferenceId(appConfigRepo.get(K_AGENT_CONVERSATION_ID))
  }
}

/** 保存偏好（部分更新），并立即把透明度应用到主窗口 */
export function setUiPreferences(patch: Partial<UiPreferences>): UiPreferences {
  uiPrefsPatchSchema.parse(patch)
  if (patch.opacity !== undefined) {
    appConfigRepo.set(K_OPACITY, String(clampOpacity(patch.opacity)))
  }
  if (patch.customCss !== undefined) {
    const css = patch.customCss.slice(0, MAX_CSS_LENGTH)
    appConfigRepo.set(K_CUSTOM_CSS, css)
  }
  if (patch.chatFontSize !== undefined) {
    appConfigRepo.set(K_CHAT_FONT_SIZE, normalizeChatFontSize(patch.chatFontSize))
  }
  if (patch.codeCollapseLines !== undefined) {
    appConfigRepo.set(K_CODE_COLLAPSE_LINES, String(normalizeCodeCollapseLines(patch.codeCollapseLines)))
  }
  if (patch.agentAssistantId !== undefined) {
    appConfigRepo.set(K_AGENT_ASSISTANT_ID, normalizePreferenceId(patch.agentAssistantId))
  }
  if (patch.agentConversationId !== undefined) {
    appConfigRepo.set(K_AGENT_CONVERSATION_ID, normalizePreferenceId(patch.agentConversationId))
  }
  const next = getUiPreferences()
  applyOpacityToMainWindows(next.opacity)
  return next
}

/** 对所有主窗口应用透明度（排除浮窗 / 解锁窗） */
export function applyOpacityToMainWindows(opacity?: number): void {
  const value = opacity ?? getUiPreferences().opacity
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if ((win as MarkedBrowserWindow)[MAIN_WINDOW_MARKER] !== true) continue
    try {
      win.setOpacity(value)
    } catch {
      /* 平台不支持时静默忽略 */
    }
  }
}
