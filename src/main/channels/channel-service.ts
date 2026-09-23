// Channels 编排服务：多网关消息 → 白名单过滤 → 会话映射 → chatService → 回复
//
// 设计：
// - 各 gateway 实现 IGateway；service 在 init() 中注册所有 gateway.onStatus
// - autoStart() 遍历 CHANNEL_TYPES，enabled=1 则启动对应 gateway
// - start(type)/stop(type) 控制单一网关；handleMessage(type, msg) 按 type 路由
// - 白名单空=拒绝所有（fail closed）；非白名单静默忽略（仅主进程日志，不打印消息内容）
// - 复用 chatService.send 双路径：agentMode=true 走 AgentEngine（含工具/审批弹窗）
// - IM 不适合流式：用收集器捕获 done/error 事件，聚合完整回复后一次性发回
// - 同一 chat 串行处理：busyChats Set（key = type:chatId）防并发
import { randomUUID } from 'crypto'
import { IPC, CHANNEL_TYPES } from '../../shared/types'
import type {
  AgentDoneEvent,
  AgentErrorEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChannelType,
  ChannelStatusEvent,
  SendMessagePayload
} from '../../shared/types'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { chatService } from '../chat/chat-service'
import { getChannelConfig, getChannelSecrets, convMapKey } from './channel-config'
import { errMsg } from '../error'
import { telegramGateway } from './telegram-gateway'
import { discordGateway } from './discord-gateway'
import { slackGateway } from './slack-gateway'
import { feishuGateway } from './feishu-gateway'
import { dingtalkGateway } from './dingtalk-gateway'
import type { IGateway, IncomingMessage } from './gateway-base'
import { createLogger } from '../logger'

const log = createLogger('channels')

const GATEWAYS: Record<ChannelType, IGateway> = {
  telegram: telegramGateway,
  discord: discordGateway,
  slack: slackGateway,
  feishu: feishuGateway,
  dingtalk: dingtalkGateway
}

function loadConvMap(type: ChannelType): Record<string, string> {
  try {
    const raw = appConfigRepo.get(convMapKey(type))
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

function saveConvMap(type: ChannelType, map: Record<string, string>): void {
  appConfigRepo.set(convMapKey(type), JSON.stringify(map))
}

type StatusListener = (evt: ChannelStatusEvent) => void

class ChannelService {
  /** 同一 chat 串行处理：处理中新消息直接提示（key: type:chatId） */
  private busyChats = new Set<string>()
  private listeners = new Set<StatusListener>()

  onStatus(l: StatusListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emitStatus(evt: ChannelStatusEvent): void {
    for (const l of this.listeners) l(evt)
  }

  init(): void {
    // 各网关状态 → 渲染端（ipc/index.ts 注册时接到 broadcast）
    for (const type of CHANNEL_TYPES) {
      const gw = GATEWAYS[type]
      gw.onStatus((evt) => this.emitStatus(evt))
    }
  }

  /** 应用启动时调用：遍历所有 enabled=1 的网关自动启动 */
  async autoStart(): Promise<void> {
    for (const type of CHANNEL_TYPES) {
      const cfg = getChannelConfig(type)
      if (!cfg.enabled) continue
      try {
        await this.start(type)
      } catch (err) {
        log.error(`${type} 自动启动失败:`, errMsg(err))
      }
    }
  }

  /** 启动单个网关（校验 enabled/secret，由 gateway 负责握手） */
  async start(type: ChannelType): Promise<void> {
    const cfg = getChannelConfig(type)
    if (!cfg.enabled) throw new Error(`${type} 网关未启用，请先在配置中开启`)
    const gw = GATEWAYS[type]
    await gw.start((msg) => this.handleMessage(type, msg))
  }

  stop(type: ChannelType): void {
    GATEWAYS[type].stop()
  }

  /** 单条入站消息处理（白名单 → 会话 → 问答 → 回复） */
  private async handleMessage(type: ChannelType, msg: IncomingMessage): Promise<void> {
    const { whitelist } = getChannelSecrets(type)
    if (whitelist.length === 0 || !whitelist.includes(msg.userId)) {
      // 静默忽略，仅记日志（不打印消息内容，防泄露）
      log.debug(`${type} 忽略非白名单用户 userId=${msg.userId} chatId=${msg.chatId}`)
      return
    }

    const busyKey = `${type}:${msg.chatId}`
    if (this.busyChats.has(busyKey)) {
      await GATEWAYS[type].sendText(msg.chatId, '正在处理上一条消息，请稍候…')
      return
    }
    this.busyChats.add(busyKey)
    try {
      await this.processMessage(type, msg)
    } finally {
      this.busyChats.delete(busyKey)
    }
  }

  private async processMessage(type: ChannelType, msg: IncomingMessage): Promise<void> {
    const cfg = getChannelConfig(type)
    const assistant = cfg.assistantId ? assistantRepo.get(cfg.assistantId) : null
    const providerId = cfg.providerId || assistant?.defaultProviderId || ''
    const model = cfg.model || assistant?.defaultModel || ''
    if (!providerId || !model) {
      await GATEWAYS[type].sendText(
        msg.chatId,
        '尚未配置目标模型：请在应用 Agent 页「Channels」选择助手与模型'
      )
      return
    }

    const conversationId = this.ensureConversation(type, msg.chatId, msg.firstName, cfg.assistantId)
    const payload: SendMessagePayload = {
      requestId: randomUUID(),
      conversationId,
      assistantId: cfg.assistantId || null,
      content: msg.text,
      targets: [{ providerId, model }],
      agentMode: cfg.agentMode,
      // IM 通道无人值守：需人工确认的工具直接报错，不挂 5 分钟审批
      unattended: true
    }

    const result = await this.runChat(payload)
    if (result.ok && result.content?.trim()) {
      await GATEWAYS[type].sendText(msg.chatId, result.content)
    } else {
      await GATEWAYS[type].sendText(msg.chatId, `处理失败：${result.error || '无回复内容'}`)
    }
  }

  /** 取/建 chat 对应的会话（KV 存映射；会话删除后自动重建） */
  private ensureConversation(
    type: ChannelType,
    chatId: string,
    firstName: string,
    assistantId: string
  ): string {
    const map = loadConvMap(type)
    const existing = map[chatId]
    if (existing) {
      const conv = conversationRepo.get(existing)
      if (conv) return existing
    }
    const conv = conversationRepo.create({
      assistantId: assistantId || null,
      title: `${type}:${firstName || chatId}`.slice(0, 30)
    })
    map[chatId] = conv.id
    saveConvMap(type, map)
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
        finish({ ok: false, error: errMsg(err) })
      )
    })
  }
}

export const channelService = new ChannelService()
