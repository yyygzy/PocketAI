// IM 渠道（Telegram/Discord/Slack/飞书/钉钉 Bot 网关）IPC
// Token 明文不出主进程；运行时接线必须在 DB 打开后由 initChannelRuntime() 单独调用
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import type { ChannelType } from '../../../shared/types'
import { CHANNEL_TYPES } from '../../../shared/types'
import { getChannelConfig, setChannelConfig } from '../../channels/channel-config'
import { channelService } from '../../channels/channel-service'
import { telegramGateway } from '../../channels/telegram-gateway'
import { discordGateway } from '../../channels/discord-gateway'
import { slackGateway } from '../../channels/slack-gateway'
import { feishuGateway } from '../../channels/feishu-gateway'
import { dingtalkGateway } from '../../channels/dingtalk-gateway'
import { broadcast } from '../broadcast'
import { safeHandle } from '../safe-handle'

function toChannelType(type: unknown): ChannelType {
  const t = typeof type === 'string' ? type : ''
  return (CHANNEL_TYPES as readonly string[]).includes(t) ? (t as ChannelType) : 'telegram'
}

export function registerChannelHandlers(): void {
  ipcMain.handle(
    IPC.CHANNEL_GET_CONFIG,
    (_e, type: unknown) => getChannelConfig(toChannelType(type))
  )
  ipcMain.handle(
    IPC.CHANNEL_SET_CONFIG,
    (
      _e,
      type: unknown,
      input: {
        enabled?: unknown
        primarySecret?: unknown
        secondarySecret?: unknown
        appId?: unknown
        whitelist?: unknown
        assistantId?: unknown
        providerId?: unknown
        model?: unknown
        agentMode?: unknown
      }
    ) => {
      const patch: {
        enabled?: boolean
        primarySecret?: string
        secondarySecret?: string
        appId?: string
        whitelist?: string
        assistantId?: string
        providerId?: string
        model?: string
        agentMode?: boolean
      } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (typeof input?.primarySecret === 'string') patch.primarySecret = input.primarySecret
      if (typeof input?.secondarySecret === 'string') patch.secondarySecret = input.secondarySecret
      if (typeof input?.appId === 'string') patch.appId = input.appId
      if (typeof input?.whitelist === 'string') patch.whitelist = input.whitelist
      if (typeof input?.assistantId === 'string') patch.assistantId = input.assistantId
      if (typeof input?.providerId === 'string') patch.providerId = input.providerId
      if (typeof input?.model === 'string') patch.model = input.model
      if (typeof input?.agentMode === 'boolean') patch.agentMode = input.agentMode
      return setChannelConfig(toChannelType(type), patch)
    }
  )
  safeHandle(IPC.CHANNEL_START, async (_e, type: unknown) => {
    await channelService.start(toChannelType(type))
    return { ok: true }
  })
  ipcMain.handle(IPC.CHANNEL_STOP, (_e, type: unknown) => {
    channelService.stop(toChannelType(type))
    return { ok: true }
  })
  ipcMain.handle(IPC.CHANNEL_LIST_STATUS, () => {
    // 返回各网关当前状态（未启动则 stopped）
    const map: Record<string, { status: string; lastError: string | null }> = {}
    for (const [t, gw] of Object.entries({
      telegram: telegramGateway,
      discord: discordGateway,
      slack: slackGateway,
      feishu: feishuGateway,
      dingtalk: dingtalkGateway
    })) {
      map[t] = {
        status: gw.isRunning() ? 'running' : 'stopped',
        lastError: null
      }
    }
    return map
  })
}

/**
 * Channels 运行时接线：必须在数据库打开后调用。
 * registerIpcHandlers() 只做通道注册（窗口创建前），
 * autoStart() 会读取 app_config，DB 未就绪时调用会抛 “Database not opened”。
 */
export function initChannelRuntime(): void {
  channelService.init()
  channelService.onStatus((evt) => broadcast(IPC.CHANNEL_STATUS_EVENT, evt))
  void channelService.autoStart()
}
