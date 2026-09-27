// IGateway 抽象：所有 IM 网关实现此接口，channel-service 按 type 路由
//
// 设计约定：
// - chatId/userId 统一字符串（各平台 ID 格式不同：TG 数字、Slack 12 位数字、Discord 雪花、飞书 open_id 含字母等）
// - 启动先验证凭证（getMe/握手），成功后进入后台循环（不阻塞调用方）
// - stop 用 AbortController 中断循环与进行中请求
// - 错误消息必须脱敏（URL 中可能含 token），safeError 提供基类辅助
// - 回复为纯文本（不用 parse_mode / markdown，避免注入与转义问题）
import type { ChannelStatus, ChannelStatusEvent, ChannelType } from '../../shared/types'

/** 各平台单条消息字符上限（统一 8000，超出自动分片） */
export const MAX_REPLY_CHARS = 8000
/** 网关重连退避上限 */
export const MAX_BACKOFF_MS = 60_000

// ─── 入站消息边界 ────────────────────────────────────────────────
// 长连接由平台鉴权，但消息字段仍是外部数据（恶意用户、被盗号、平台异常推送）：
// 文本会进 Agent/LLM 与 SQLite，chatId/userId 会进白名单匹配、KV 映射与出站 API
// 调用，必须在进入业务链前统一收口，各 gateway 不得自行拼装 IncomingMessage。

/** 入站文本字符上限（各平台单条上限最大约 4096，20000 已留足余量） */
export const MAX_INCOMING_TEXT_CHARS = 20_000
/** chatId/userId 字符上限（各平台 ID 均远小于此，如 Discord 雪花 18~19 位） */
export const MAX_INCOMING_ID_CHARS = 128
/** 发送者显示名字符上限（用于会话标题） */
export const MAX_INCOMING_NAME_CHARS = 200

/** 入站原始字段（运行时来自 JSON.parse，全部按 unknown 处理） */
export interface RawIncoming {
  chatId?: unknown
  userId?: unknown
  text?: unknown
  firstName?: unknown
}

/** id 类字段：接受 string/number（部分平台 JSON 给数字 ID），拒绝对象/布尔/null */
function coerceId(v: unknown, maxChars: number): string | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : null
  if (s === null) return null
  const t = s.trim()
  if (!t) return null
  return t.length > maxChars ? t.slice(0, maxChars) : t
}

/**
 * 入站消息统一收口：字段类型/长度非法时返回 null（调用方静默丢弃，仅 debug 日志）。
 * - chatId/userId：必填，string/number，非空，超长按上限截断
 * - text：必须是非空字符串，trim 后超长按上限截断并附截断提示
 * - firstName：可选，非字符串按空串，超长截断
 */
export function sanitizeIncoming(raw: RawIncoming): IncomingMessage | null {
  const chatId = coerceId(raw.chatId, MAX_INCOMING_ID_CHARS)
  const userId = coerceId(raw.userId, MAX_INCOMING_ID_CHARS)
  if (!chatId || !userId) return null
  if (typeof raw.text !== 'string') return null
  const text = raw.text.trim()
  if (!text) return null

  const boundedText =
    text.length > MAX_INCOMING_TEXT_CHARS
      ? text.slice(0, MAX_INCOMING_TEXT_CHARS) + '\n…（消息过长已截断）'
      : text

  const firstName =
    typeof raw.firstName === 'string'
      ? raw.firstName.trim().slice(0, MAX_INCOMING_NAME_CHARS)
      : ''

  return { chatId, userId, text: boundedText, firstName }
}

/** 入站文本消息（仅私聊文本；图片/文件等类型 v1 不处理） */
export interface IncomingMessage {
  /** 平台原生 chat ID（字符串） */
  chatId: string
  /** 平台原生 user ID（字符串） */
  userId: string
  /** 消息文本（已 trim） */
  text: string
  /** 发送者显示名（用于会话标题） */
  firstName: string
}

type StatusListener = (evt: ChannelStatusEvent) => void
type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

export interface IGateway {
  readonly type: ChannelType
  onStatus(l: StatusListener): () => void
  isRunning(): boolean
  /** 启动：先验证凭证，成功后进入后台循环（不阻塞调用方） */
  start(onMessage: MessageHandler): Promise<void>
  stop(): void
  /** 发送纯文本回复（自动分片与截断） */
  sendText(targetId: string, text: string): Promise<void>
}

/** 状态发射器（去重：状态无变化不广播，避免轮询循环每次成功都报 running） */
export class StatusEmitter {
  private listeners = new Set<StatusListener>()
  private last: ChannelStatusEvent | null = null

  constructor(private readonly type: ChannelType) {}

  add(l: StatusListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  emit(status: ChannelStatus, lastError: string | null = null): void {
    const prev = this.last
    if (prev && prev.status === status && prev.lastError === lastError) return
    this.last = { type: this.type, status, lastError }
    for (const l of this.listeners) l(this.last)
  }

  reset(): void {
    // stop() 调用前清掉 last，保证 stop → start 会重新广播
    this.last = null
  }
}

/** 错误脱敏：URL 含 token 时一律替换为笼统描述 */
export function safeError(err: unknown, method: string): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  if (/bot\d+:|xox[bpras]-|api\.telegram\.org|discord\.com\/api|slack\.com\/api|open\.feishu\.cn|oapi\.dingtalk\.com|https?:\/\//i.test(msg)) {
    return `${method} 请求失败（网络或凭证错误）`
  }
  return `${method}: ${msg}`
}

/** 按长度分片（优先在换行处切，避免硬切出现半句） */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit - 1)
    if (cut < Math.floor(limit * 0.5)) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 可被 AbortSignal 打断的 sleep（打断后立即 resolve，由外层 while 条件退出循环） */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      done()
    }
    function done(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 带超时的 fetch：内部 AbortController 超时 + 可选外部 signal 合并，
 * 强制 redirect:'manual' 防止重定向泄漏凭证，finally 清理 timer。
 * 调用方不要在 init 里传 signal / redirect，由本函数统一注入。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs)
  const merged = signal
    ? AbortSignal.any([signal, timeoutCtrl.signal])
    : timeoutCtrl.signal
  try {
    return await fetch(url, { ...init, signal: merged, redirect: 'manual' })
  } finally {
    clearTimeout(timer)
  }
}
