// Slack Socket Mode 网关：WebSocket 主动拉取（零公网入口依赖）
//
// 安全约定：
// - 出站域名：https://slack.com/api/* 与 wss://wss.primary.slack.com（动态获取）
// - 请求头含 Bot Token (xoxb-) 与 App-Level Token (xapp-)，错误消息经 safeError 脱敏
// - 回复为纯文本（不开 mrkdwn 解析以减少注入风险，但仍会渲染 Slack markdown；用 splitMessage 分片）
// - stop 时关闭 WebSocket + 清除心跳 + 中断进行中的请求
// - 单条消息上限 40000 字符（Slack 实际有更细粒度 4000 token 限制，留余量分片为 2900）
import type { ChannelStatusEvent } from '../../shared/types'
import { getChannelSecrets } from './channel-config'
import { createLogger } from '../logger'
import {
  IGateway,
  IncomingMessage,
  StatusEmitter,
  safeError,
  splitMessage,
  sleep
} from './gateway-base'

const log = createLogger('channels')

const API_BASE = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 15_000
const SLACK_MSG_LIMIT = 2900 // Slack 文本建议上限 4000，留 buffer
const MAX_REPLY_CHARS = 8000
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

interface SlackEnvelope {
  type: string
  envelope_id?: string
  payload?: {
    event?: {
      type: string
      user?: string
      text?: string
      channel?: string
      bot_id?: string
      ts?: string
    }
    type?: string
  }
  reason?: string
}

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

class SlackGateway implements IGateway {
  readonly type = 'slack' as const
  private ws: WebSocket | null = null
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

  async start(onMessage: MessageHandler): Promise<void> {
    if (this.running || this.starting) return
    const { primary: botToken, secondary: appToken } = getChannelSecrets('slack')
    if (!botToken) {
      const err = '未配置 Bot Token (xoxb-)，请在 Agent 页「Channels」填写'
      this.status.emit('error', err)
      throw new Error(err)
    }
    if (!appToken) {
      const err = '未配置 App-Level Token (xapp-)，Socket Mode 必需'
      this.status.emit('error', err)
      throw new Error(err)
    }
    this.starting = true
    this.ctrl = new AbortController()
    const ctrl = this.ctrl
    this.onMessage = onMessage
    this.status.emit('starting')
    try {
      const url = await this.openSocket(appToken, ctrl.signal)
      if (ctrl.signal.aborted) return
      this.connect(url, botToken, ctrl)
    } catch (err) {
      this.starting = false
      if (ctrl.signal.aborted) return
      this.ctrl = null
      this.onMessage = null
      const msg = safeError(err, 'connections.open')
      this.status.emit('error', msg)
      throw new Error(msg)
    }
  }

  /** 调用 apps.connections.open 拿到 WebSocket URL */
  private async openSocket(appToken: string, signal: AbortSignal): Promise<string> {
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS)
    const merged = AbortSignal.any([signal, timeoutCtrl.signal])
    try {
      const res = await fetch(`${API_BASE}/apps.connections.open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${appToken}`
        },
        body: JSON.stringify({}),
        signal: merged,
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 App Token')
      }
      const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null
      if (!res.ok || !data?.ok || !data.url) {
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      return data.url
    } finally {
      clearTimeout(timer)
    }
  }

  private connect(url: string, botToken: string, ctrl: AbortController): void {
    const ws = new WebSocket(url)
    this.ws = ws
    const onAbort = (): void => {
      try {
        ws.close(4000, 'aborted')
      } catch {
        /* noop */
      }
    }
    ctrl.signal.addEventListener('abort', onAbort, { once: true })

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const env: SlackEnvelope = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        void this.handleEnvelope(env, botToken, ctrl).catch((err) => {
          log.error('Slack 消息处理失败:', safeError(err, 'envelope'))
        })
      } catch (err) {
        log.error('Slack 解析失败:', safeError(err, 'parse'))
      }
    })

    ws.addEventListener('close', () => {
      this.ws = null
      this.running = false
      if (ctrl.signal.aborted) return
      if (this.starting) {
        this.starting = false
        this.status.emit('error', '握手阶段连接关闭')
        return
      }
      // 运行中意外断开：重连
      void this.reconnect(botToken, ctrl).catch((err) => {
        // abort 时 sleep reject 是正常退出路径；其他 reject 记日志
        if (!ctrl.signal.aborted) log.error('Slack reconnect 异常:', safeError(err, 'reconnect'))
      })
    })

    ws.addEventListener('error', () => {
      if (this.starting) {
        this.starting = false
        this.status.emit('error', 'Slack Socket Mode 连接失败（网络或凭证错误）')
      }
    })

    // 启动后即视为运行中（实际等到 hello envelope 才算就绪）
    this.starting = false
    this.running = true
    this.status.emit('running')
  }

  private async handleEnvelope(env: SlackEnvelope, _botToken: string, ctrl: AbortController): Promise<void> {
    // 收到事件必须 ack 否则会被重发
    if (env.envelope_id && this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
    }
    if (env.type === 'hello') {
      this.running = true
      this.status.emit('running')
      return
    }
    if (env.type === 'events_api' && env.payload?.event?.type === 'message') {
      const e = env.payload.event
      if (e.bot_id) return // 忽略其他 bot 消息（含自己回的）
      if (!e.user || !e.text || !e.channel) return
      try {
        await this.onMessage?.({
          chatId: e.channel,
          userId: e.user,
          text: e.text.trim(),
          firstName: ''
        })
      } catch (err) {
        log.error('消息处理失败:', safeError(err, 'handle'))
      }
    }
    if (env.type === 'goodbye' && !ctrl.signal.aborted) {
      // 服务端要求关闭重连
      try {
        this.ws?.close(4001, 'goodbye')
      } catch {
        /* noop */
      }
    }
  }

  private async reconnect(botToken: string, ctrl: AbortController): Promise<void> {
    let backoff = MIN_BACKOFF_MS
    while (!ctrl.signal.aborted) {
      this.status.emit('starting')
      await sleep(backoff, ctrl.signal)
      if (ctrl.signal.aborted) return
      const { secondary: appToken } = getChannelSecrets('slack')
      if (!appToken) {
        this.status.emit('error', 'App-Level Token 已被清除')
        return
      }
      try {
        const url = await this.openSocket(appToken, ctrl.signal)
        if (ctrl.signal.aborted) return
        this.connect(url, botToken, ctrl)
        return
      } catch (err) {
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        this.status.emit('error', safeError(err, 'reconnect'))
      }
    }
  }

  stop(): void {
    this.starting = false
    this.ctrl?.abort()
    this.ctrl = null
    this.ws = null
    this.running = false
    this.onMessage = null
    this.status.reset()
    this.status.emit('stopped')
  }

  async sendText(targetId: string, text: string): Promise<void> {
    const { primary: botToken } = getChannelSecrets('slack')
    if (!botToken) throw new Error('未配置 Bot Token')
    const trimmed =
      text.length > MAX_REPLY_CHARS
        ? text.slice(0, MAX_REPLY_CHARS) + '\n…（内容过长已截断）'
        : text
    for (const chunk of splitMessage(trimmed, SLACK_MSG_LIMIT)) {
      await this.callApi('POST', '/chat.postMessage', { channel: targetId, text: chunk }, botToken)
    }
  }

  private async callApi(
    method: string,
    path: string,
    body: Record<string, unknown>,
    botToken: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`
        },
        body: JSON.stringify(body),
        signal: timeoutCtrl.signal,
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 Bot Token')
      }
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }
}

export const slackGateway = new SlackGateway()
