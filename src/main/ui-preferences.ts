// 界面偏好管理
//
// ui.opacity     窗口透明度（0.6–1），主进程 BrowserWindow.setOpacity
//                Windows / macOS 原生支持；Linux 取决于窗口管理器（不支持时静默无效）
// ui.theme       窗口底色主题（内置预设 id，见 shared/themes.ts）。渲染端 localStorage 仍是切换时的事实来源，
//                这里存一份是为了让 BrowserWindow 在页面首帧之前就用对底色（否则浅色主题会先黑一下）。

import { BrowserWindow, type WebContents } from 'electron'
import { appConfigRepo } from './db/repositories/app-config.repo'
import type { UiPreferences, ChatFontSize } from '../shared/types'
import { uiPrefsPatchSchema } from '../shared/schemas/preferences'
import {
  DEFAULT_UI_THEME,
  isUiTheme,
  normalizeUiTheme,
  themeWindowBackground
} from '../shared/themes'
import type { UiTheme } from '../shared/themes'

export type { UiTheme }
export { isUiTheme, normalizeUiTheme }

const K_OPACITY = 'ui.opacity'
const K_CHAT_FONT_SIZE = 'ui.chat_font_size'
const K_CODE_COLLAPSE_LINES = 'ui.code_collapse_lines'
const K_THEME = 'ui.theme'
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

// ─── 主题底色（A-3 / D1） ────────────────────────────────────────
//
// 主题 id 与色板集中在 shared/themes.ts：这里不再有"非浅即深"的三元判断——
// 新增预设只要在注册表里加一条，窗口底色/首帧 class/mermaid 主题就一起跟上。

/**
 * BrowserWindow 的底色。取值必须与渲染端根背景一致（各预设的 `--color-surface`），
 * 否则页面首帧会先露出一条异色底。
 */
export function windowBackground(theme: UiTheme = getUiTheme()): string {
  return themeWindowBackground(theme)
}

/**
 * 读回上次主题。库未打开时（解锁窗创建早于解锁）退回深色，且**不缓存**——
 * 解锁后主窗口要能读到真实值。
 */
export function getUiTheme(): UiTheme {
  try {
    return normalizeUiTheme(appConfigRepo.get(K_THEME))
  } catch {
    return DEFAULT_UI_THEME
  }
}

/**
 * 读 KV 里「有没有」主题值：没有（含脏值）返回 null，供渲染端决定是否回填一次。
 * 与 getUiTheme 不同，**不吞读取异常**——库没打开时调用方应跳过回填，而不是误判成「无值」去写。
 */
export function readStoredUiTheme(): UiTheme | null {
  const raw = appConfigRepo.get(K_THEME)
  return isUiTheme(raw) ? raw : null
}

/** 主题化的窗口标记（浮窗保持透明、解锁窗不参与切换，故不靠标题判断） */
export const THEMED_WINDOW_MARKER = '__pocketaiThemedWindow' as const

export type ThemedBrowserWindow = BrowserWindow & {
  [K in typeof THEMED_WINDOW_MARKER]?: boolean
}

export function markThemedWindow(win: BrowserWindow): void {
  ;(win as ThemedBrowserWindow)[THEMED_WINDOW_MARKER] = true
}

/** 把底色应用到所有主题化窗口（主窗口 + 独立窗口；浮窗/解锁窗不在标记内） */
export function applyThemeToWindows(theme: UiTheme = getUiTheme()): void {
  const color = windowBackground(theme)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if ((win as ThemedBrowserWindow)[THEMED_WINDOW_MARKER] !== true) continue
    try {
      win.setBackgroundColor(color)
    } catch {
      /* 窗口正在销毁/平台不支持时忽略：下次启动仍会按 KV 重建 */
    }
  }
}

/** 保存主题（KV + 立即刷所有主题化窗口的底色），返回归一后的值 */
export function setUiTheme(theme: UiTheme): UiTheme {
  const next = normalizeUiTheme(theme)
  appConfigRepo.set(K_THEME, next)
  applyThemeToWindows(next)
  return next
}

// ─── 首帧主题上报（D1 收尾：首启不闪深色） ──────────────────────
//
// 首次启动（含升级后第一次）时 KV 里还没有主题，建窗只能先按默认深色；
// 而渲染端 localStorage 里可能早就存着浅色。真实主题只有渲染端知道，
// 所以由 theme-init.js 在页面首帧前上报，主进程先把窗口底色改对再显示。

/**
 * 建窗时 KV 里有没有主题值。读不到（库未打开/异常）也按「没有」处理：
 * 两种情况都拿不到真实主题，建窗底色同样只能先给默认深色。
 */
export function hasStoredUiTheme(): boolean {
  try {
    return readStoredUiTheme() !== null
  } catch {
    return false
  }
}

/** 等渲染端首帧上报的窗口（webContents.id → 窗口 + 结算回调，报到一次即移除） */
const themeReportWaiters = new Map<number, { win: BrowserWindow; onReport: () => void }>()

/**
 * 登记「等该窗口的渲染端上报首帧主题」。上报由 theme-init.js 在页面首帧前发出；
 * 超时兜底由调用方负责——等不到也必须照常显示，不能把窗口卡在隐藏态。
 */
export function awaitRendererTheme(win: BrowserWindow, onReport: () => void): void {
  const id = win.webContents.id
  themeReportWaiters.set(id, { win, onReport })
  win.once('closed', () => themeReportWaiters.delete(id))
}

/**
 * 渲染端在首帧前上报当前生效主题：把该窗底色改对，再放行等待中的显示。
 * 只处理「建窗时登记了等待」的窗口——KV 已有底色的窗口、解锁窗、独立窗都不受影响；
 * 也只改窗口底色、不写 KV（KV 仍由主窗口渲染端启动后回填）。
 */
export function reportRendererTheme(sender: WebContents, theme: UiTheme): void {
  const pending = themeReportWaiters.get(sender.id)
  if (!pending) return
  themeReportWaiters.delete(sender.id)
  const { win, onReport } = pending
  if (!win.isDestroyed() && (win as ThemedBrowserWindow)[THEMED_WINDOW_MARKER] === true) {
    try {
      win.setBackgroundColor(windowBackground(normalizeUiTheme(theme)))
    } catch {
      /* 窗口正在销毁/平台不支持时忽略：上报只影响首帧底色 */
    }
  }
  onReport()
}
