// Discord Bot 网关：Gateway WebSocket 主动拉取（零公网入口依赖）
//
// 安全约定：
// - 出站域名：wss://gateway.discord.gg / https://discord.com/api
// - 请求头含 Bot Token，错误消息经 safeError 脱敏
// - 回复为纯文本（content 字段，不开 markdown 解析风险但 Discord 默认渲染 markdown，已用 splitMessage 分片且不加 mention）
// - stop 时关闭 WebSocket + 清除心跳 timer + 中断进行中的请求
// - 单条消息上限 2000 字符
import type { ChannelStatusEvent } from '../../shared/types'
import { getChannelSecrets } from './channel-config'
import { createLogger } from '../logger'
import {
  IGateway,
  IncomingMessage,
  StatusEmitter,
  safeError,
  splitMessage,
  sleep,
  fetchWithTimeout
} from './gateway-base'

const log = createLogger('channels')

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const API_BASE = 'https://discord.com/api/v10'
const REQUEST_TIMEOUT_MS = 15_000
const DISCORD_MSG_LIMIT = 2000
const MAX_REPLY_CHARS = 8000
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

// Intents：GUILD_MESSAGES(1<<9) | DIRECT_MESSAGES(1<<12) | MESSAGE_CONTENT(1<<15)
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15)

interface DiscordPayload {
  op: number
  t: string | null
  s: number | null
  d: unknown
}

interface ReadyData {
  user: { id: string; username: string }
  session_id: string
  resume_gateway_url?: string
}

interface MessageCreateData {
  id: string
  channel_id: string
  guild_id?: string | null
  author: { id: string; username: string; bot?: boolean }
  content?: string
}

interface HelloData {
  heartbeat_interval: number
}

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

class DiscordGateway implements IGateway {
  readonly type = 'discord' as const
  private ws: WebSocket | null = null
  private ctrl: AbortController | null = null
  private running = false
  private starting = false
  private status = new StatusEmitter(this.type)
  private onMessage: MessageHandler | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private selfUserId: string | null = null
  private lastSeq: number | null = null

  onStatus(l: (evt: ChannelStatusEvent) => void): () => void {
    return this.status.add(l)
  }

  isRunning(): boolean {
    return this.running
  }

  async start(onMessage: MessageHandler): Promise<void> {
    if (this.running || this.starting) return
    const { primary: token } = getChannelSecrets('discord')
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
      this.connect(token, ctrl)
    } catch (err) {
      this.starting = false
      if (ctrl.signal.aborted) return
      this.ctrl = null
      this.onMessage = null
      const msg = safeError(err, 'connect')
      this.status.emit('error', msg)
      throw new Error(msg)
    }
  }

  private connect(token: string, ctrl: AbortController): void {
    const ws = new WebSocket(GATEWAY_URL)
    this.ws = ws
    const onAbort = (): void => {
      try {
        ws.close(4000, 'aborted')
      } catch {
        /* noop */
      }
    }
    ctrl.signal.addEventListener('abort', onAbort, { once: true })

    ws.addEventListener('open', () => {
      // 等 Hello 事件后再 Identify
    })

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const data: DiscordPayload = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        void this.handlePayload(data, token, ctrl).catch((err) => {
          log.error('Discord 消息处理失败:', safeError(err, 'payload'))
        })
      } catch (err) {
        log.error('Discord 解析失败:', safeError(err, 'parse'))
      }
    })

    ws.addEventListener('close', (ev: CloseEvent) => {
      this.cleanupConnection()
      if (ctrl.signal.aborted) {
        // stop 触发：状态已由 stop() 设置
        return
      }
      // 代码 4000+ 为应用主动关闭：不重连
      if (ev.code >= 4000) return
      // 服务端要求重连：自动 backoff 重试
      if (this.starting) {
        this.starting = false
        this.status.emit('error', '握手阶段连接关闭，请检查网络')
        return
      }
      // 运行中意外断开：尝试重连
      if (this.running) {
        this.running = false
        void this.reconnect(token, ctrl).catch((err) => {
          if (!ctrl.signal.aborted) log.error('Discord reconnect 异常:', safeError(err, 'reconnect'))
        })
      }
    })

    ws.addEventListener('error', () => {
      // close 事件会跟随，错误信息不外泄 token；统一笼统提示
      if (this.starting) {
        this.starting = false
        this.status.emit('error', 'Discord 网关连接失败（网络或凭证错误）')
      }
    })
  }

  private async handlePayload(p: DiscordPayload, token: string, ctrl: AbortController): Promise<void> {
    if (p.s !== null) this.lastSeq = p.s
    switch (p.op) {
      case 10: // Hello
        {
          const hello = p.d as HelloData
          this.startHeartbeat(hello.heartbeat_interval, ctrl.signal)
          this.identify(token)
        }
        break
      case 0: // Dispatch
        if (p.t === 'READY') {
          const r = p.d as ReadyData
          this.selfUserId = r.user.id
          this.starting = false
          if (ctrl.signal.aborted) return
          this.running = true
          this.status.emit('running')
          log.info(`Discord bot @${r.user.username} 已就绪`)
        } else if (p.t === 'MESSAGE_CREATE') {
          const m = p.d as MessageCreateData
          if (m.author?.bot) return
          if (this.selfUserId && m.author?.id === this.selfUserId) return
          const text = (m.content ?? '').trim()
          if (!text) return
          try {
            await this.onMessage?.({
              chatId: m.channel_id,
              userId: m.author.id,
              text,
              firstName: m.author.username
            })
          } catch (err) {
            log.error('消息处理失败:', safeError(err, 'handle'))
          }
        }
        break
      case 1: // Heartbeat ACK
        // 服务端确认心跳，无需操作
        break
      case 7: // Reconnect
        try {
          this.ws?.close(4001, 'server requested reconnect')
        } catch {
          /* noop */
        }
        break
      case 9: // Invalid Session
        // 重置会话后重新 Identify
        this.lastSeq = null
        setTimeout(() => this.identify(token), 2000)
        break
      case 11:
        // Heartbeat ACK（部分版本 op 11）
        break
    }
  }

  private identify(token: string): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token,
          intents: INTENTS,
          properties: {
            os: 'linux',
            browser: 'pocketai',
            device: 'pocketai'
          }
        }
      })
    )
  }

  private startHeartbeat(intervalMs: number, ctrl: AbortSignal): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (ctrl.aborted) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        return
      }
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }))
      }
    }, Math.max(intervalMs, 5000))
  }

  private async reconnect(token: string, ctrl: AbortController): Promise<void> {
    let backoff = MIN_BACKOFF_MS
    while (!ctrl.signal.aborted) {
      this.status.emit('starting')
      await sleep(backoff, ctrl.signal)
      if (ctrl.signal.aborted) return
      try {
        this.connect(token, ctrl)
        return // 进入连接后由事件回调驱动状态
      } catch (err) {
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        this.status.emit('error', safeError(err, 'reconnect'))
      }
    }
  }

  private cleanupConnection(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.ws = null
    this.running = false
  }

  stop(): void {
    this.starting = false
    this.ctrl?.abort()
    this.ctrl = null
    this.cleanupConnection()
    this.onMessage = null
    this.selfUserId = null
    this.lastSeq = null
    this.status.reset()
    this.status.emit('stopped')
  }

  async sendText(targetId: string, text: string): Promise<void> {
    const { primary: token } = getChannelSecrets('discord')
    if (!token) throw new Error('未配置 Bot Token')
    const trimmed =
      text.length > MAX_REPLY_CHARS
        ? text.slice(0, MAX_REPLY_CHARS) + '\n…（内容过长已截断）'
        : text
    for (const chunk of splitMessage(trimmed, DISCORD_MSG_LIMIT)) {
      await this.callApi('POST', `/channels/${targetId}/messages`, { content: chunk }, token)
    }
  }

  private async callApi(
    method: string,
    path: string,
    body: Record<string, unknown>,
    token: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const res = await fetchWithTimeout(
      `${API_BASE}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${token}`
        },
        body: JSON.stringify(body)
      },
      timeoutMs
    )
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`HTTP ${res.status}（服务端重定向，已拒绝以保护 Bot Token）`)
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(`HTTP ${res.status}: ${data?.message ?? res.statusText}`)
      }
      return await res.json().catch(() => null)
  }
}

export const discordGateway = new DiscordGateway()
