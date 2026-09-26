// Telegram Bot 网关：getUpdates long polling（零公网依赖）
//
// 安全约定：
// - 出站域名仅 https://api.telegram.org
// - 请求 URL 含 token，任何错误消息都必须经 safeError 脱敏（不得出现 URL/凭证）
// - 回复为纯文本（不用 parse_mode，避免注入与转义问题）
// - stop 用 AbortController 中断轮询与进行中的请求
import type { ChannelStatusEvent } from '../../shared/types'
import { getChannelSecrets, getTgOffset, setTgOffset } from './channel-config'
import { createLogger } from '../logger'
import {
  IGateway,
  IncomingMessage,
  StatusEmitter,
  safeError,
  splitMessage,
  sleep,
  fetchWithTimeout,
  MAX_REPLY_CHARS,
  MAX_BACKOFF_MS
} from './gateway-base'

const log = createLogger('channels')

const API_BASE = 'https://api.telegram.org'
const LONG_POLL_TIMEOUT_S = 25
const REQUEST_TIMEOUT_MS = 35_000 // 覆盖 long poll 25s + 网络余量
const GETME_TIMEOUT_MS = 10_000
const TG_MSG_LIMIT = 4096
const MIN_BACKOFF_MS = 1_000

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

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

class TelegramGateway implements IGateway {
  readonly type = 'telegram' as const
  private ctrl: AbortController | null = null
  private running = false
  private starting = false
  private status = new StatusEmitter(this.type)
  private onMessage: MessageHandler | null = null

  onStatus(l: (evt: ChannelStatusEvent) => void): () => void {
    return this.status.add(l)
  }

  isRunning(): boolean {
    return this.running
  }

  /** 调用 TG Bot API（POST JSON）。错误消息只含方法名与状态码，不含 URL */
  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const { primary: token } = getChannelSecrets('telegram')
    if (!token) throw new Error('未配置 Bot Token')
    const res = await fetchWithTimeout(
      `${API_BASE}/bot${token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      timeoutMs,
      signal
    )
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`HTTP ${res.status}（服务端重定向，已拒绝以保护 Bot Token）`)
      }
      const data = (await res.json().catch(() => null)) as TgApiResponse<T> | null
      if (!res.ok || !data?.ok) {
        const desc = data?.description ? `: ${data.description}` : ''
        throw new Error(`HTTP ${res.status}${desc}`)
      }
      return data.result as T
  }

  /** 启动：先 getMe 验证凭证，成功后进入后台轮询循环（不阻塞调用方） */
  async start(onMessage: MessageHandler): Promise<void> {
    if (this.running || this.starting) return
    const { primary: token } = getChannelSecrets('telegram')
    if (!token) {
      const err = '未配置 Bot Token，请在 Agent 页「Channels」填写'
      this.status.emit('error', err)
      throw new Error(err)
    }
    this.starting = true
    this.ctrl = new AbortController()
    const ctrl = this.ctrl
    this.onMessage = onMessage
    this.status.emit('starting')
    try {
      const me = await this.callApi<{ id: number; username: string }>(
        'getMe',
        {},
        ctrl.signal,
        GETME_TIMEOUT_MS
      )
      log.info(`Telegram bot @${me.username} 凭证验证通过`)
    } catch (err) {
      this.starting = false
      // starting 阶段被 stop() 中止：stop 已发 stopped 状态，不再覆盖为 error
      if (ctrl.signal.aborted) return
      this.ctrl = null
      this.onMessage = null
      const msg = safeError(err, 'getMe')
      this.status.emit('error', msg)
      throw new Error(msg)
    }
    this.starting = false
    if (ctrl.signal.aborted) return // getMe 成功瞬间被 stop
    this.running = true
    this.status.emit('running')
    void this.pollLoop().catch((err) => {
      // abort 时 catch 块内 sleep reject 是正常退出；其他 reject 记日志
      if (!ctrl.signal.aborted) log.error('Telegram pollLoop 异常:', safeError(err, 'pollLoop'))
    })
  }

  stop(): void {
    if (!this.running && !this.ctrl) return
    this.starting = false
    this.ctrl?.abort()
    this.running = false
    this.ctrl = null
    this.onMessage = null
    this.status.reset()
    this.status.emit('stopped')
  }

  /** 发送纯文本回复：总长截断 + 4096 分片 */
  async sendText(targetId: string, text: string): Promise<void> {
    const chatId = Number(targetId)
    if (!Number.isInteger(chatId)) throw new Error('无效 chatId')
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
        this.status.emit('running')
        for (const u of updates ?? []) {
          // 先推进 offset 再处理：宁可极端情况丢消息，也不重复处理
          setTgOffset(u.update_id + 1)
          const msg = this.extractMessage(u)
          if (!msg) continue
          try {
            await this.onMessage?.(msg)
          } catch (err) {
            // 单条处理失败不影响轮询循环
            log.error('消息处理失败:', safeError(err, 'handle'))
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) break
        const msg = safeError(err, 'getUpdates')
        log.error('Telegram getUpdates 轮询失败:', msg)
        this.status.emit('running', msg)
        // 可中断退避：stop 时立即退出循环而非睡满 backoff
        await sleep(backoffMs, ctrl.signal)
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
  }

  private extractMessage(u: TgUpdate): IncomingMessage | null {
    const m = u.message
    if (!m || !m.from || m.from.is_bot) return null
    if (typeof m.text !== 'string' || !m.text.trim()) return null
    return {
      chatId: String(m.chat.id),
      userId: String(m.from.id),
      text: m.text.trim(),
      firstName: m.chat.first_name ?? ''
    }
  }
}

export const telegramGateway = new TelegramGateway()
