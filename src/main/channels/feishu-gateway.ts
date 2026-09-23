// 飞书长连接网关：WebSocket 主动拉取事件订阅（零公网入口依赖）
//
// 协议流程：
//   1. tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal { app_id, app_secret }
//   2. ws URL: POST /open-apis/v1.0/event/ws/get_url?type=events_v2&Authorization: Bearer {token}
//      返回 { url, expires_in }
//   3. WebSocket 连接后定期 ping，收到事件 { type: 'event_v2', payload: {...}, seq_id } → ack { type: 'event_v2_ack', seq_id }
//   4. 处理 im.message.receive_v1：event.message.message_type=='text' → 文本内容 + chat_id + sender.open_id
//
// 安全约定：
// - 出站域名仅 https://open.feishu.cn 与动态 ws URL（来自飞书）
// - 请求头含 app_secret 派生的 tenant_access_token，错误消息经 safeError 脱敏
// - 回复为纯文本（msg_type=text，content=JSON.stringify({text})）
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
  sleep
} from './gateway-base'

const log = createLogger('channels')

const API_BASE = 'https://open.feishu.cn'
const REQUEST_TIMEOUT_MS = 15_000
const FEISHU_MSG_LIMIT = 4000 // 飞书单条消息文本上限约 4096，留 buffer
const MAX_REPLY_CHARS = 8000
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const PING_INTERVAL_MS = 30_000

interface TenantTokenResult {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

interface WsUrlResult {
  code?: number
  msg?: string
  data?: { url?: string; expires_in?: number }
  url?: string
}

interface FeishuEvent {
  type: string // 'event_v2' / 'event_v2_ack' / 'status_v2' 等
  seq_id?: string
  payload?: unknown
  data?: unknown
}

interface FeishuMessageEvent {
  header: { event_type: string }
  event: {
    sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string } }
    message?: {
      message_type?: string
      content?: string
      chat_id?: string
      chat_type?: string // p2p / group
    }
  }
}

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

class FeishuGateway implements IGateway {
  readonly type = 'feishu' as const
  private ws: WebSocket | null = null
  private ctrl: AbortController | null = null
  private running = false
  private starting = false
  private status = new StatusEmitter(this.type)
  private onMessage: MessageHandler | null = null
  private pingTimer: NodeJS.Timeout | null = null

  onStatus(l: (evt: ChannelStatusEvent) => void): () => void {
    return this.status.add(l)
  }

  isRunning(): boolean {
    return this.running
  }

  async start(onMessage: MessageHandler): Promise<void> {
    if (this.running || this.starting) return
    const { appId, secondary: appSecret } = getChannelSecrets('feishu')
    if (!appId || !appSecret) {
      const err = '未配置 App ID / App Secret，请在 Agent 页「Channels」填写'
      this.status.emit('error', err)
      throw new Error(err)
    }
    this.starting = true
    this.ctrl = new AbortController()
    const ctrl = this.ctrl
    this.onMessage = onMessage
    this.status.emit('starting')
    try {
      const token = await this.fetchTenantToken(appId, appSecret, ctrl.signal)
      if (ctrl.signal.aborted) return
      const url = await this.fetchWsUrl(token, ctrl.signal)
      if (ctrl.signal.aborted) return
      this.connect(url, appId, appSecret, ctrl)
    } catch (err) {
      this.starting = false
      if (ctrl.signal.aborted) return
      this.ctrl = null
      this.onMessage = null
      const msg = safeError(err, 'init')
      this.status.emit('error', msg)
      throw new Error(msg)
    }
  }

  private async fetchTenantToken(appId: string, appSecret: string, signal: AbortSignal): Promise<string> {
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS)
    const merged = AbortSignal.any([signal, timeoutCtrl.signal])
    try {
      const res = await fetch(`${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: merged,
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 App Secret')
      }
      const data = (await res.json().catch(() => null)) as TenantTokenResult | null
      if (!res.ok || !data?.tenant_access_token) {
        throw new Error(data?.msg ?? `HTTP ${res.status}`)
      }
      return data.tenant_access_token
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchWsUrl(tenantToken: string, signal: AbortSignal): Promise<string> {
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS)
    const merged = AbortSignal.any([signal, timeoutCtrl.signal])
    try {
      const res = await fetch(`${API_BASE}/open-apis/v1.0/event/ws/get_url?type=events_v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenantToken}`
        },
        body: JSON.stringify({}),
        signal: merged,
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 tenant_access_token')
      }
      const data = (await res.json().catch(() => null)) as WsUrlResult | null
      const url = data?.data?.url ?? data?.url
      if (!res.ok || !url) {
        throw new Error(data?.msg ?? `HTTP ${res.status}`)
      }
      return url
    } finally {
      clearTimeout(timer)
    }
  }

  private connect(url: string, appId: string, appSecret: string, ctrl: AbortController): void {
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

    ws.addEventListener('open', () => {
      this.startPing()
    })

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const data: FeishuEvent = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        void this.handleEvent(data, appId, appSecret, ctrl).catch((err) => {
          log.error('飞书消息处理失败:', safeError(err, 'event'))
        })
      } catch (err) {
        log.error('飞书解析失败:', safeError(err, 'parse'))
      }
    })

    ws.addEventListener('close', () => {
      this.stopPing()
      this.ws = null
      this.running = false
      if (ctrl.signal.aborted) return
      if (this.starting) {
        this.starting = false
        this.status.emit('error', '握手阶段连接关闭')
        return
      }
      void this.reconnect(appId, appSecret, ctrl).catch((err) => {
        if (!ctrl.signal.aborted) log.error('飞书 reconnect 异常:', safeError(err, 'reconnect'))
      })
    })

    ws.addEventListener('error', () => {
      if (this.starting) {
        this.starting = false
        this.status.emit('error', '飞书长连接失败（网络或凭证错误）')
      }
    })

    this.starting = false
    this.running = true
    this.status.emit('running')
  }

  private async handleEvent(
    ev: FeishuEvent,
    appId: string,
    appSecret: string,
    _ctrl: AbortController
  ): Promise<void> {
    // 事件需 ack：{ type: 'event_v2_ack', seq_id }
    if (ev.seq_id && this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'event_v2_ack', seq_id: ev.seq_id }))
    }
    if (ev.type === 'event_v2' && ev.payload) {
      const inner = ev.payload as FeishuMessageEvent
      if (inner?.header?.event_type === 'im.message.receive_v1') {
        const m = inner.event?.message
        const sender = inner.event?.sender?.sender_id
        if (!m || m.message_type !== 'text' || !m.chat_id || !sender) return
        let text = ''
        try {
          const content = JSON.parse(m.content ?? '{}') as { text?: string }
          text = (content.text ?? '').trim()
        } catch {
          return
        }
        if (!text) return
        try {
          await this.onMessage?.({
            chatId: m.chat_id,
            userId: sender.open_id ?? sender.union_id ?? sender.user_id ?? '',
            text,
            firstName: ''
          })
        } catch (err) {
          log.error('消息处理失败:', safeError(err, 'handle'))
        }
      }
    }
    // status_v2 等其他类型：已 ack 即可
    void appId
    void appSecret
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        // 飞书长连接要求定期 ping 帧：发送文本 'ping'
        this.ws.send('ping')
      }
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private async reconnect(appId: string, appSecret: string, ctrl: AbortController): Promise<void> {
    let backoff = MIN_BACKOFF_MS
    while (!ctrl.signal.aborted) {
      this.status.emit('starting')
      await sleep(backoff, ctrl.signal)
      if (ctrl.signal.aborted) return
      try {
        const token = await this.fetchTenantToken(appId, appSecret, ctrl.signal)
        if (ctrl.signal.aborted) return
        const url = await this.fetchWsUrl(token, ctrl.signal)
        if (ctrl.signal.aborted) return
        this.connect(url, appId, appSecret, ctrl)
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
    this.stopPing()
    this.ws = null
    this.running = false
    this.onMessage = null
    this.status.reset()
    this.status.emit('stopped')
  }

  async sendText(targetId: string, text: string): Promise<void> {
    const { appId, secondary: appSecret } = getChannelSecrets('feishu')
    if (!appId || !appSecret) throw new Error('未配置 App ID / App Secret')
    // token 可能过期，每次重新取
    const token = await this.fetchTenantToken(appId, appSecret, new AbortController().signal)
    const trimmed =
      text.length > MAX_REPLY_CHARS
        ? text.slice(0, MAX_REPLY_CHARS) + '\n…（内容过长已截断）'
        : text
    for (const chunk of splitMessage(trimmed, FEISHU_MSG_LIMIT)) {
      await this.callApi(
        'POST',
        '/open-apis/im/v1/messages?receive_id_type=chat_id',
        {
          receive_id: targetId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk })
        },
        token
      )
    }
  }

  private async callApi(
    method: string,
    path: string,
    body: Record<string, unknown>,
    tenantToken: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenantToken}`
        },
        body: JSON.stringify(body),
        signal: timeoutCtrl.signal,
        redirect: 'manual'
      })
      if (res.status >= 300 && res.status < 400) {
        throw new Error('HTTP 重定向，已拒绝以保护 tenant_access_token')
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { msg?: string; message?: string } | null
        throw new Error(`HTTP ${res.status}: ${data?.msg ?? data?.message ?? res.statusText}`)
      }
      return await res.json().catch(() => null)
    } finally {
      clearTimeout(timer)
    }
  }
}

export const feishuGateway = new FeishuGateway()
