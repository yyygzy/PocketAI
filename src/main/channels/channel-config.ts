// Channels 网关配置（app_config KV，前缀 channel.tg_）
//
// - Token 为字段级密文（secret-store），明文仅主进程可读（getChannelSecret），渲染端只拿 hasToken 标记
// - 白名单为逗号分隔的 TG 数字 userId，空=拒绝所有（fail closed）
// - offset 持久化：重启后不重复处理旧消息
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { getSecret, setSecret, hasSecret, SECRET_KV_KEYS } from '../crypto/secret-store'
import type { ChannelConfig } from '../../shared/types'

const KEY_ENABLED = 'channel.tg_enabled'
const KEY_TOKEN = SECRET_KV_KEYS.TELEGRAM_TOKEN
const KEY_WHITELIST = 'channel.tg_whitelist'
const KEY_ASSISTANT = 'channel.tg_assistant_id'
const KEY_PROVIDER = 'channel.tg_provider_id'
const KEY_MODEL = 'channel.tg_model'
const KEY_AGENT_MODE = 'channel.tg_agent_mode'
const KEY_OFFSET = 'channel.tg_offset'

/** 读取网关配置（Token 恒为空串，明文走 getChannelSecret） */
export function getChannelConfig(): ChannelConfig {
  return {
    enabled: appConfigRepo.get(KEY_ENABLED) === '1',
    token: '',
    hasToken: hasSecret(KEY_TOKEN),
    whitelist: appConfigRepo.get(KEY_WHITELIST) ?? '',
    assistantId: appConfigRepo.get(KEY_ASSISTANT) ?? '',
    providerId: appConfigRepo.get(KEY_PROVIDER) ?? '',
    model: appConfigRepo.get(KEY_MODEL) ?? '',
    agentMode: appConfigRepo.get(KEY_AGENT_MODE) === '1'
  }
}

/** 保存网关配置（字段白名单；token：undefined=不动、''=清除、非空覆盖） */
export function setChannelConfig(
  input: Partial<Omit<ChannelConfig, 'token' | 'hasToken'>> & { token?: string }
): ChannelConfig {
  if (typeof input.enabled === 'boolean') {
    appConfigRepo.set(KEY_ENABLED, input.enabled ? '1' : '0')
  }
  if (input.token === '') {
    setSecret(KEY_TOKEN, '')
  } else if (typeof input.token === 'string' && input.token.trim()) {
    const t = input.token.trim()
    if (t.length > 256) {
      // 不静默丢弃：明确拒绝，由渲染端提示用户
      throw new Error('Bot Token 过长（上限 256 字符），请检查后重试')
    }
    setSecret(KEY_TOKEN, t)
  }
  if (typeof input.whitelist === 'string') {
    // 只保留数字与逗号（数字 ID 白名单），清理重复/首尾逗号
    const cleaned = input.whitelist
      .replace(/[^\d,]/g, '')
      .replace(/,{2,}/g, ',')
      .replace(/^,+|,+$/g, '')
    appConfigRepo.set(KEY_WHITELIST, cleaned)
  }
  if (typeof input.assistantId === 'string') appConfigRepo.set(KEY_ASSISTANT, input.assistantId)
  if (typeof input.providerId === 'string') appConfigRepo.set(KEY_PROVIDER, input.providerId)
  if (typeof input.model === 'string') appConfigRepo.set(KEY_MODEL, input.model)
  if (typeof input.agentMode === 'boolean') {
    appConfigRepo.set(KEY_AGENT_MODE, input.agentMode ? '1' : '0')
  }
  return getChannelConfig()
}

/** 主进程内部读取敏感信息（telegram-gateway / channel-service 专用，不得外传） */
export function getChannelSecret(): { token: string; whitelist: number[] } {
  const token = getSecret(KEY_TOKEN)
  const whitelist = (appConfigRepo.get(KEY_WHITELIST) ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return { token, whitelist }
}

export function getTgOffset(): number {
  const n = Number(appConfigRepo.get(KEY_OFFSET))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function setTgOffset(offset: number): void {
  if (Number.isFinite(offset) && offset > 0) {
    appConfigRepo.set(KEY_OFFSET, String(Math.floor(offset)))
  }
}
