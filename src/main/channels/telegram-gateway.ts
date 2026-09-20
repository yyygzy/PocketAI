// Telegram Bot 网关：getUpdates long polling（零公网依赖）
//
// 安全约定：
// - 出站域名仅 https://api.telegram.org
// - 请求 URL 含 token，任何错误消息都必须经 safeError 脱敏（不得出现 URL/凭证）
// - 回复为纯文本（不用 parse_mode，避免注入与转义问题）
// - stop 用 AbortController 中断轮询与进行中的请求
import type { ChannelStatus, ChannelStatusEvent } from '../../shared/types'
import { getChannelSecret, getTgOffset, setTgOffset } from './channel-config'

const API_BASE = 'https://api.telegram.org'
const LONG_POLL_TIMEOUT_S = 25
const REQUEST_TIMEOUT_MS = 35_000 // 覆盖 long poll 25s + 网络余量
const GETME_TIMEOUT_MS = 10_000
const TG_MSG_LIMIT = 4096
const MAX_REPLY_CHARS = 8000
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

/** 入站文本消息（仅私聊文本；图片/文件等类型 v1 不处理） */
export interface TgIncomingMessage {
  chatId: number
  userId: number
  text: string
  firstName: string
}

type StatusListener = (evt: ChannelStatusEvent) => void
type MessageHandler = (msg: TgIncomingMessage) => void | Promise<void>

interface TgUpdate {
  update_id: number
  message?: {
    chat: { id: number; first_name?: string; type?: string }
    from?: { id: number; is_bot: boolean }
    text?: string
  }
}

interface TgApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

/** 按长度分片（优先在换行处切，避免硬切出现半句） */
function splitMessage(text: string, limit: number): string[] {
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

function extractTextMessage(u: TgUpdate): TgIncomingMessage | null {
  const m = u.message
  if (!m || !m.from || m.from.is_bot) return null
  if (typeof m.text !== 'string' || !m.text.trim()) return null
  return {
    chatId: m.chat.id,
    userId: m.from.id,
    text: m.text.trim(),
    firstName: m.chat.first_name ?? ''
  }
}

class TelegramGateway {
  private ctrl: AbortController | null = null
  private running = false
  private starting = false
  private listeners = new Set<StatusListener>()
  private onMessage: MessageHandler | null = null

  onStatus(l: StatusListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  isRunning(): boolean {
    return this.running
  }

  private emitStatus(status: ChannelStatus, lastError: string | null = null): void {
    // 去重：轮询循环每次成功会重复报 running，无变化不广播
    const prev = this.lastStatus
    if (prev && prev.status === status && prev.lastError === lastError) return
    this.lastStatus = { status, lastError }
    for (const l of this.listeners) l({ status, lastError })
  }

  private lastStatus: ChannelStatusEvent | null = null

  /** 错误脱敏：URL 含 token，任何疑似含 URL/凭证的错误一律替换为笼统描述 */
  private safeError(err: unknown, method: string): string {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    if (/bot\d+:|api\.telegram\.org|https?:\/\//i.test(msg)) {
      return `${method} 请求失败（网络或凭证错误）`
    }
    return `${method}: ${msg}`
  }

  /** 调用 TG Bot API（POST JSON）。错误消息只含方法名与状态码，不含 URL */
  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const { token } = getChannelSecret()
    if (!token) throw new Error('未配置 Bot Token')
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs)
    const merged = signal ? AbortSignal.any([signal, timeoutCtrl.signal]) : timeoutCtrl.signal
    try {
      const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: merged,
        // Bot Token 在 URL 路径中；禁止跟随重定向，避免 token 被发往 Location 主机
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`HTTP ${res.status}（服务端重定向，已拒绝以保护 Bot Token）`)
      }
      const data = (await res.json().catch(() => null)) as TgApiResponse<T> | null
      if (!res.ok || !data?.ok) {
        const desc = data?.description ? `: ${data.description}` : ''
        throw new Error(`HTTP ${res.status}${desc}`)
      }
      return data.result as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** 启动：先 getMe 验证凭证，成功后进入后台轮询循环（不阻塞调用方） */
  async start(onMessage: MessageHandler): Promise<void> {
    if (this.running || this.starting) return
    const { token } = getChannelSecret()
    if (!token) {
      const err = '未配置 Bot Token，请在 Agent 页「Channels」填写'
      this.emitStatus('error', err)
      throw new Error(err)
    }
    this.starting = true
    this.ctrl = new AbortController()
    const ctrl = this.ctrl
    this.onMessage = onMessage
    this.emitStatus('starting')
    try {
      const me = await this.callApi<{ id: number; username: string }>(
        'getMe',
        {},
        ctrl.signal,
        GETME_TIMEOUT_MS
      )
      console.log(`[channels] Telegram bot @${me.username} 凭证验证通过`)
    } catch (err) {
      this.starting = false
      // starting 阶段被 stop() 中止：stop 已发 stopped 状态，不再覆盖为 error
      if (ctrl.signal.aborted) return
      this.ctrl = null
      this.onMessage = null
      const msg = this.safeError(err, 'getMe')
      this.emitStatus('error', msg)
      throw new Error(msg)
    }
    this.starting = false
    if (ctrl.signal.aborted) return // getMe 成功瞬间被 stop
    this.running = true
    this.emitStatus('running')
    void this.pollLoop()
  }

  stop(): void {
    if (!this.running && !this.ctrl) return
    this.starting = false
    this.ctrl?.abort()
    this.running = false
    this.ctrl = null
    this.onMessage = null
    this.emitStatus('stopped')
  }

  /** 发送纯文本回复：总长截断 + 4096 分片 */
  async sendText(chatId: number, text: string): Promise<void> {
    const trimmed =
      text.length > MAX_REPLY_CHARS
        ? text.slice(0, MAX_REPLY_CHARS) + '\n…（内容过长已截断）'
        : text
    for (const chunk of splitMessage(trimmed, TG_MSG_LIMIT)) {
      await this.callApi('sendMessage', { chat_id: chatId, text: chunk })
    }
  }

  private async pollLoop(): Promise<void> {
    const ctrl = this.ctrl
    if (!ctrl) return
    let backoffMs = MIN_BACKOFF_MS
    while (!ctrl.signal.aborted) {
      try {
        const updates = await this.callApi<TgUpdate[]>(
          'getUpdates',
          { timeout: LONG_POLL_TIMEOUT_S, offset: getTgOffset() },
          ctrl.signal
        )
        backoffMs = MIN_BACKOFF_MS
        this.emitStatus('running')
        for (const u of updates ?? []) {
          // 先推进 offset 再处理：宁可极端情况丢消息，也不重复处理
          setTgOffset(u.update_id + 1)
          const msg = extractTextMessage(u)
          if (!msg) continue
          try {
            await this.onMessage?.(msg)
          } catch (err) {
            // 单条处理失败不影响轮询循环
            console.error('[channels] 消息处理失败:', this.safeError(err, 'handle'))
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) break
        const msg = this.safeError(err, 'getUpdates')
        console.error('[channels]', msg)
        this.emitStatus('running', msg)
        // 可中断退避：stop 时立即退出循环而非睡满 backoff
        await this.sleep(backoffMs, ctrl.signal)
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
  }

  /** 可被 AbortSignal 打断的 sleep（打断后立即 resolve，由外层 while 条件退出循环） */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
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
}

export const telegramGateway = new TelegramGateway()
