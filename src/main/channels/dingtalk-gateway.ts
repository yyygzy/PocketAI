// 钉钉 Stream 模式网关：WebSocket 主动拉取（零公网入口依赖）
//
// 协议：POST https://api.dingtalk.com/v1.0/gateway/connections/open 拿到 ws URL
//   返回 { ServerUrl, Token }（部分版本字段为 serverUrl/token 小写）→ 连接 wss://...
// 收到订阅事件 → ack（topic：/v1.0/im/bot/messages/get 等）→ 处理用户消息
// 发送回复：POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend（单聊）
//   Header: accessToken（用 access_token） + Content-Type
//   Body: { chatbotClientId, robotCode, userIds, msgKey: 'sample', msgParam: JSON.stringify({ content }) }
// 注意：单聊机器人接入需创建企业内部应用 + 添加「机器人」配置 + 订阅「群消息会话」事件
//
// 安全约定：
// - 出站域名仅 https://api.dingtalk.com 与动态 ws ServerUrl
// - 请求头含 access_token / app_secret 派生，错误消息经 safeError 脱敏
// - 回复为纯文本（msgKey=sample，msgParam.content 不开 markdown）
// - stop 时关闭 WebSocket + 中断进行中的请求
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
  fetchWithTimeout,
  MAX_REPLY_CHARS,
  MAX_BACKOFF_MS
} from './gateway-base'

const log = createLogger('channels')

const API_BASE = 'https://api.dingtalk.com'
const REQUEST_TIMEOUT_MS = 15_000
const DINGTALK_MSG_LIMIT = 4000 // 钉钉单条消息文本上限约 4096，留 buffer
const MIN_BACKOFF_MS = 1_000

interface DingtalkOpenResult {
  ServerUrl?: string
  Token?: string
  serverUrl?: string
  token?: string
}

interface DingtalkWsMessage {
  /** 协议头 */
  Code?: number
  Headers?: { contentType?: string }
  /** 数据 */
  Headers2?: { contentType?: string }
  Topic?: string
  headers?: { contentType?: string }
  topic?: string
  data?: string
  message?: unknown
}

interface DingtalkBotMessage {
  conversationId?: string
  chatbotClientId?: string
  conversationType?: string // 1 单聊 / 2 群聊
  senderStaffId?: string // 企业内部用户 ID
  senderNick?: string
  text?: { content: string }
  msgType?: string
  messageId?: string
}

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

class DingtalkGateway implements IGateway {
  readonly type = 'dingtalk' as const
  private ws: WebSocket | null = null
  private ctrl: AbortController | null = null
  private running = false
  private starting = false
  private status = new StatusEmitter(this.type)
  private onMessage: MessageHandler | null = null
  private token: string | null = null // ws 握手 token（来自 connections/open 响应）

  onStatus(l: (evt: ChannelStatusEvent) => void): () => void {
    return this.status.add(l)
  }

  isRunning(): boolean {
    return this.running
  }

  async start(onMessage: MessageHandler): Promise<void> {
    if (this.running || this.starting) return
    const { appId: appKey, secondary: appSecret } = getChannelSecrets('dingtalk')
    if (!appKey || !appSecret) {
      const err = '未配置 App Key / App Secret，请在 Agent 页「Channels」填写'
      this.status.emit('error', err)
      throw new Error(err)
    }
    this.starting = true
    this.ctrl = new AbortController()
    const ctrl = this.ctrl
    this.onMessage = onMessage
    this.status.emit('starting')
    try {
      const open = await this.openConnection(appKey, appSecret, ctrl.signal)
      if (ctrl.signal.aborted) return
      this.token = open.token
      this.connect(open.url, appKey, appSecret, ctrl)
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

  /** 调用 gateway/connections/open 拿到 WebSocket URL */
  private async openConnection(
    appKey: string,
    appSecret: string,
    signal: AbortSignal
  ): Promise<{ url: string; token: string }> {
    const res = await fetchWithTimeout(
      `${API_BASE}/v1.0/gateway/connections/open`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: appKey, clientSecret: appSecret })
      },
      REQUEST_TIMEOUT_MS,
      signal
    )
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 App Secret')
      }
      const data = (await res.json().catch(() => null)) as DingtalkOpenResult | null
      const url = data?.ServerUrl ?? data?.serverUrl
      const token = data?.Token ?? data?.token
      if (!res.ok || !url) {
        throw new Error(`HTTP ${res.status}`)
      }
      return { url, token: token ?? '' }
  }

  private connect(url: string, appKey: string, appSecret: string, ctrl: AbortController): void {
    const wsUrl = this.token ? `${url}?token=${encodeURIComponent(this.token)}` : url
    const ws = new WebSocket(wsUrl)
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
        const raw = typeof ev.data === 'string' ? ev.data : ''
        const msg: DingtalkWsMessage = JSON.parse(raw)
        void this.handleMessage(msg, appKey, appSecret, ctrl).catch((err) => {
          log.error('钉钉消息处理失败:', safeError(err, 'msg'))
        })
      } catch (err) {
        log.error('钉钉解析失败:', safeError(err, 'parse'))
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
      void this.reconnect(appKey, appSecret, ctrl).catch((err) => {
        if (!ctrl.signal.aborted) log.error('钉钉 reconnect 异常:', safeError(err, 'reconnect'))
      })
    })

    ws.addEventListener('error', () => {
      if (this.starting) {
        this.starting = false
        this.status.emit('error', '钉钉 Stream 连接失败（网络或凭证错误）')
      }
    })

    this.starting = false
    this.running = true
    this.status.emit('running')
  }

  private async handleMessage(
    msg: DingtalkWsMessage,
    _appKey: string,
    _appSecret: string,
    _ctrl: AbortController
  ): Promise<void> {
    const topic = msg.Topic ?? msg.topic
    if (!topic) return
    // 心跳/系统消息：直接 ack
    const bizId = msg.Headers2?.contentType ?? msg.Headers?.contentType ?? msg.headers?.contentType
    if (bizId === 'system' || topic === 'system') {
      this.ack(msg)
      return
    }
    // 业务事件：先 ack 再处理
    this.ack(msg)
    if (topic.includes('/v1.0/im/bot/messages/get') && msg.data) {
      try {
        const inner = JSON.parse(msg.data) as DingtalkBotMessage
        if (inner.msgType && inner.msgType !== 'text') return
        const text = inner.text?.content?.trim()
        if (!text || !inner.senderStaffId || !inner.conversationId) return
        try {
          await this.onMessage?.({
            chatId: inner.conversationId,
            userId: inner.senderStaffId,
            text,
            firstName: inner.senderNick ?? ''
          })
        } catch (err) {
          log.error('消息处理失败:', safeError(err, 'handle'))
        }
      } catch (err) {
        log.error('钉钉内层 JSON 解析失败:', safeError(err, 'parse'))
      }
    }
  }

  private ack(msg: DingtalkWsMessage): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    // Stream ack 格式：回 Headers2 + topic + message-id
    const code = msg.Code ?? 0
    this.ws.send(
      JSON.stringify({
        Code: code + 1,
        Headers: { 'contentType': 'application/json' },
        Headers2: { 'contentType': 'application/json' },
        Topic: msg.Topic ?? msg.topic,
        message: msg.message ?? ''
      })
    )
  }

  private async reconnect(appKey: string, appSecret: string, ctrl: AbortController): Promise<void> {
    let backoff = MIN_BACKOFF_MS
    while (!ctrl.signal.aborted) {
      this.status.emit('starting')
      await sleep(backoff, ctrl.signal)
      if (ctrl.signal.aborted) return
      try {
        const open = await this.openConnection(appKey, appSecret, ctrl.signal)
        if (ctrl.signal.aborted) return
        this.token = open.token
        this.connect(open.url, appKey, appSecret, ctrl)
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
    this.token = null
    this.status.reset()
    this.status.emit('stopped')
  }

  async sendText(targetId: string, text: string): Promise<void> {
    // 钉钉单聊机器人回复用 oToMessages/batchSend（需 robotCode = appKey + userIds）
    const { appId: appKey, secondary: appSecret } = getChannelSecrets('dingtalk')
    if (!appKey || !appSecret) throw new Error('未配置 App Key / App Secret')
    const trimmed =
      text.length > MAX_REPLY_CHARS
        ? text.slice(0, MAX_REPLY_CHARS) + '\n…（内容过长已截断）'
        : text
    for (const chunk of splitMessage(trimmed, DINGTALK_MSG_LIMIT)) {
      await this.callApi('POST', '/v1.0/robot/oToMessages/batchSend', {
        chatbotClientId: appKey,
        robotCode: appKey,
        userIds: [targetId],
        msgKey: 'sample',
        msgParam: JSON.stringify({ content: chunk })
      }, appKey, appSecret)
    }
  }

  /** 钉钉 access_token 派生：POST /v1.0/oauth2/accessToken */
  private async getAccessToken(appKey: string, appSecret: string, signal: AbortSignal): Promise<string> {
    const res = await fetchWithTimeout(
      `${API_BASE}/v1.0/oauth2/accessToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret })
      },
      REQUEST_TIMEOUT_MS,
      signal
    )
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 App Secret')
      }
      const data = (await res.json().catch(() => null)) as { accessToken?: string; expiresIn?: number } | null
      if (!res.ok || !data?.accessToken) {
        throw new Error(`HTTP ${res.status}`)
      }
      return data.accessToken
  }

  private async callApi(
    method: string,
    path: string,
    body: Record<string, unknown>,
    appKey: string,
    appSecret: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken(appKey, appSecret, new AbortController().signal)
    const res = await fetchWithTimeout(
      `${API_BASE}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken
        },
        body: JSON.stringify(body)
      },
      timeoutMs
    )
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 access_token')
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; msg?: string } | null
        throw new Error(`HTTP ${res.status}: ${data?.message ?? data?.msg ?? res.statusText}`)
      }
      return await res.json().catch(() => null)
  }
}

export const dingtalkGateway = new DingtalkGateway()
