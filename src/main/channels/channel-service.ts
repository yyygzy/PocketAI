// Channels 编排服务：TG 消息 → 白名单过滤 → 会话映射 → chatService → 回复
//
// - 白名单空=拒绝所有（fail closed）；非白名单静默忽略（仅主进程日志，不打印消息内容）
// - 复用 chatService.send 双路径：agentMode=true 走 AgentEngine（含工具/审批弹窗）
// - IM 不适合流式：用收集器捕获 done/error 事件，聚合完整回复后一次性发回
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/types'
import type {
  AgentDoneEvent,
  AgentErrorEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  SendMessagePayload
} from '../../shared/types'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { chatService } from '../chat/chat-service'
import { getChannelConfig, getChannelSecret } from './channel-config'
import { telegramGateway } from './telegram-gateway'
import type { TgIncomingMessage } from './telegram-gateway'

const CONV_MAP_KEY = 'channel.tg_conv_map' // JSON: { [chatId]: conversationId }

function loadConvMap(): Record<string, string> {
  try {
    const raw = appConfigRepo.get(CONV_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

function saveConvMap(map: Record<string, string>): void {
  appConfigRepo.set(CONV_MAP_KEY, JSON.stringify(map))
}

type StatusListener = (evt: { status: string; lastError: string | null }) => void

class ChannelService {
  /** 同一 chat 串行处理：处理中新消息直接提示 */
  private busyChats = new Set<number>()
  private listeners = new Set<StatusListener>()

  onStatus(l: StatusListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emitStatus(evt: { status: string; lastError: string | null }): void {
    for (const l of this.listeners) l(evt)
  }

  init(): void {
    // 网关状态 → 渲染端（ipc/index.ts 注册时接到 broadcast）
    telegramGateway.onStatus((evt) => this.emitStatus(evt))
  }

  /** 应用启动时调用：enabled=1 则自动启动（失败仅记状态，不阻断启动） */
  async autoStart(): Promise<void> {
    const cfg = getChannelConfig()
    if (!cfg.enabled) return
    try {
      await this.start()
    } catch (err) {
      console.error('[channels] 自动启动失败:', (err as Error).message)
    }
  }

  /** 启动网关（校验 enabled/token，由 gateway 负责 getMe 验证与轮询） */
  async start(): Promise<void> {
    const cfg = getChannelConfig()
    if (!cfg.enabled) throw new Error('网关未启用，请先在配置中开启')
    await telegramGateway.start((msg) => this.handleMessage(msg))
  }

  stop(): void {
    telegramGateway.stop()
  }

  /** 单条入站消息处理（白名单 → 目标校验 → 会话 → 问答 → 回复） */
  private async handleMessage(msg: TgIncomingMessage): Promise<void> {
    const { whitelist } = getChannelSecret()
    if (!whitelist.includes(msg.userId)) {
      // 静默忽略，仅记日志（不打印消息内容，防泄露）
      console.log(`[channels] 忽略非白名单用户 userId=${msg.userId} chatId=${msg.chatId}`)
      return
    }

    if (this.busyChats.has(msg.chatId)) {
      await telegramGateway.sendText(msg.chatId, '正在处理上一条消息，请稍候…')
      return
    }
    this.busyChats.add(msg.chatId)
    try {
      await this.processMessage(msg)
    } finally {
      this.busyChats.delete(msg.chatId)
    }
  }

  private async processMessage(msg: TgIncomingMessage): Promise<void> {
    const cfg = getChannelConfig()
    const assistant = cfg.assistantId ? assistantRepo.get(cfg.assistantId) : null
    const providerId = cfg.providerId || assistant?.defaultProviderId || ''
    const model = cfg.model || assistant?.defaultModel || ''
    if (!providerId || !model) {
      await telegramGateway.sendText(
        msg.chatId,
        '尚未配置目标模型：请在应用 Agent 页「Channels」选择助手与模型'
      )
      return
    }

    const conversationId = this.ensureConversation(msg.chatId, msg.firstName, cfg.assistantId)
    const payload: SendMessagePayload = {
      requestId: randomUUID(),
      conversationId,
      assistantId: cfg.assistantId || null,
      content: msg.text,
      targets: [{ providerId, model }],
      agentMode: cfg.agentMode
    }

    const result = await this.runChat(payload)
    if (result.ok && result.content?.trim()) {
      await telegramGateway.sendText(msg.chatId, result.content)
    } else {
      await telegramGateway.sendText(msg.chatId, `处理失败：${result.error || '无回复内容'}`)
    }
  }

  /** 取/建 chat 对应的会话（KV 存映射；会话删除后自动重建） */
  private ensureConversation(chatId: number, firstName: string, assistantId: string): string {
    const map = loadConvMap()
    const existing = map[String(chatId)]
    if (existing) {
      const conv = conversationRepo.get(existing)
      if (conv) return existing
    }
    const conv = conversationRepo.create({
      assistantId: assistantId || null,
      title: `TG:${firstName || chatId}`.slice(0, 30)
    })
    map[String(chatId)] = conv.id
    saveConvMap(map)
    return conv.id
  }

  /** 调 chatService.send 并用收集器捕获完成/错误事件（IM 场景聚合后回复） */
  private runChat(
    payload: SendMessagePayload
  ): Promise<{ ok: boolean; content?: string; error?: string }> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (r: { ok: boolean; content?: string; error?: string }) => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      const emit = (channel: string, data: unknown) => {
        if (channel === IPC.AGENT_DONE_EVENT) {
          finish({ ok: true, content: (data as AgentDoneEvent).fullContent })
        } else if (channel === IPC.CHAT_DONE_EVENT) {
          finish({ ok: true, content: (data as ChatDoneEvent).fullContent })
        } else if (channel === IPC.AGENT_ERROR_EVENT) {
          finish({ ok: false, error: (data as AgentErrorEvent).error })
        } else if (channel === IPC.CHAT_ERROR_EVENT) {
          finish({ ok: false, error: (data as ChatErrorEvent).error })
        }
        // chunk/step 事件忽略：IM 回复不流式
      }
      chatService.send(payload, emit).catch((err) =>
        finish({ ok: false, error: (err as Error).message })
      )
    })
  }
}

export const channelService = new ChannelService()
