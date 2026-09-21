// Channels 网关配置（多网关：Telegram / 飞书 / 钉钉 / Slack / Discord）
//
// - 凭据为字段级密文（secret-store），明文仅主进程可读（getChannelSecrets），渲染端只拿 hasXxx 标记
// - 白名单为逗号分隔的字符串 ID（飞书 open_id / 钉钉 unionId / Slack user_id / Discord user_id 等），空=拒绝所有（fail closed）
// - 偏好类配置按网关类型分 KV key（`channel.{type}_*`），互不串扰
// - Telegram 沿用旧 `channel.tg_*` 前缀（向后兼容历史用户数据）
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { getSecret, setSecret, hasSecret, SECRET_KV_KEYS } from '../crypto/secret-store'
import type { ChannelConfig, ChannelType } from '../../shared/types'

/** type → KV 前缀（telegram 保留旧前缀以兼容历史数据） */
function prefixFor(type: ChannelType): string {
  return type === 'telegram' ? 'channel.tg_' : `channel.${type}_`
}

const FIELD_ENABLED = 'enabled'
const FIELD_WHITELIST = 'whitelist'
const FIELD_ASSISTANT = 'assistant_id'
const FIELD_PROVIDER = 'provider_id'
const FIELD_MODEL = 'model'
const FIELD_AGENT_MODE = 'agent_mode'
const FIELD_APP_ID = 'app_id' // 飞书 App ID / 钉钉 App Key（非密钥）
const FIELD_CONV_MAP = 'conv_map'
const FIELD_OFFSET = 'offset' // Telegram update offset / Discord session_id 等

/** type → 主凭据 secret-store key（无则 null） */
function primarySecretKey(type: ChannelType): string | null {
  switch (type) {
    case 'telegram':
      return SECRET_KV_KEYS.TELEGRAM_TOKEN
    case 'slack':
      return SECRET_KV_KEYS.SLACK_BOT_TOKEN
    case 'discord':
      return SECRET_KV_KEYS.DISCORD_BOT_TOKEN
    case 'feishu':
    case 'dingtalk':
      return null
  }
}

/** type → 次凭据 secret-store key（无则 null） */
function secondarySecretKey(type: ChannelType): string | null {
  switch (type) {
    case 'feishu':
      return SECRET_KV_KEYS.FEISHU_APP_SECRET
    case 'dingtalk':
      return SECRET_KV_KEYS.DINGTALK_APP_SECRET
    case 'slack':
      return SECRET_KV_KEYS.SLACK_APP_TOKEN
    case 'telegram':
    case 'discord':
      return null
  }
}

function bool(b: unknown): boolean {
  return b === '1'
}

/** 读取网关配置（密钥恒为不回显，仅返回是否已配置的布尔标记） */
export function getChannelConfig(type: ChannelType): ChannelConfig {
  const p = prefixFor(type)
  const pk = primarySecretKey(type)
  const sk = secondarySecretKey(type)
  return {
    type,
    enabled: bool(appConfigRepo.get(`${p}${FIELD_ENABLED}`)),
    hasPrimarySecret: pk ? hasSecret(pk) : false,
    hasSecondarySecret: sk ? hasSecret(sk) : false,
    appId: appConfigRepo.get(`${p}${FIELD_APP_ID}`) ?? '',
    whitelist: appConfigRepo.get(`${p}${FIELD_WHITELIST}`) ?? '',
    assistantId: appConfigRepo.get(`${p}${FIELD_ASSISTANT}`) ?? '',
    providerId: appConfigRepo.get(`${p}${FIELD_PROVIDER}`) ?? '',
    model: appConfigRepo.get(`${p}${FIELD_MODEL}`) ?? '',
    agentMode: bool(appConfigRepo.get(`${p}${FIELD_AGENT_MODE}`))
  }
}

/** 保存网关配置（字段白名单；密钥：undefined=不动、''=清除、非空覆盖） */
export function setChannelConfig(
  type: ChannelType,
  input: Partial<Omit<ChannelConfig, 'type' | 'hasPrimarySecret' | 'hasSecondarySecret'>> & {
    primarySecret?: string
    secondarySecret?: string
  }
): ChannelConfig {
  const p = prefixFor(type)
  const pk = primarySecretKey(type)
  const sk = secondarySecretKey(type)

  if (typeof input.enabled === 'boolean') {
    appConfigRepo.set(`${p}${FIELD_ENABLED}`, input.enabled ? '1' : '0')
  }

  // 主凭据
  if (pk) {
    if (input.primarySecret === '') {
      setSecret(pk, '')
    } else if (typeof input.primarySecret === 'string' && input.primarySecret.trim()) {
      const v = input.primarySecret.trim()
      if (v.length > 512) {
        throw new Error('主凭据过长（上限 512 字符），请检查后重试')
      }
      setSecret(pk, v)
    }
  }

  // 次凭据
  if (sk) {
    if (input.secondarySecret === '') {
      setSecret(sk, '')
    } else if (typeof input.secondarySecret === 'string' && input.secondarySecret.trim()) {
      const v = input.secondarySecret.trim()
      if (v.length > 512) {
        throw new Error('次凭据过长（上限 512 字符），请检查后重试')
      }
      setSecret(sk, v)
    }
  }

  if (typeof input.appId === 'string') {
    // 飞书 App ID / 钉钉 App Key 一般为字母数字与下划线，做温和清理
    const cleaned = input.appId.replace(/[^\w-]/g, '').slice(0, 64)
    appConfigRepo.set(`${p}${FIELD_APP_ID}`, cleaned)
  }
  if (typeof input.whitelist === 'string') {
    // 统一字符串 ID（含字母），保留字母数字、逗号、点号（飞书 open_id 含点）下划线减号
    const cleaned = input.whitelist
      .replace(/[^\w,.\-]/g, '')
      .replace(/,{2,}/g, ',')
      .replace(/^,+|,+$/g, '')
    appConfigRepo.set(`${p}${FIELD_WHITELIST}`, cleaned)
  }
  if (typeof input.assistantId === 'string') appConfigRepo.set(`${p}${FIELD_ASSISTANT}`, input.assistantId)
  if (typeof input.providerId === 'string') appConfigRepo.set(`${p}${FIELD_PROVIDER}`, input.providerId)
  if (typeof input.model === 'string') appConfigRepo.set(`${p}${FIELD_MODEL}`, input.model)
  if (typeof input.agentMode === 'boolean') {
    appConfigRepo.set(`${p}${FIELD_AGENT_MODE}`, input.agentMode ? '1' : '0')
  }
  return getChannelConfig(type)
}

/** 主进程内部读取所有密钥明文（gateway / channel-service 专用，不得外传） */
export interface ChannelSecrets {
  primary: string
  secondary: string
  appId: string
  whitelist: string[]
}

export function getChannelSecrets(type: ChannelType): ChannelSecrets {
  const p = prefixFor(type)
  const pk = primarySecretKey(type)
  const sk = secondarySecretKey(type)
  const primary = pk ? getSecret(pk) : ''
  const secondary = sk ? getSecret(sk) : ''
  const appId = appConfigRepo.get(`${p}${FIELD_APP_ID}`) ?? ''
  const whitelistRaw = appConfigRepo.get(`${p}${FIELD_WHITELIST}`) ?? ''
  const whitelist = whitelistRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return { primary, secondary, appId, whitelist }
}

/** 持久化字段（通用 KV 读写，按 type 分前缀） */
export function getChannelField(type: ChannelType, field: string): string | null {
  return appConfigRepo.get(`${prefixFor(type)}${field}`)
}

export function setChannelField(type: ChannelType, field: string, value: string): void {
  appConfigRepo.set(`${prefixFor(type)}${field}`, value)
}

/** Telegram offset 兼容包装（旧 API 保留） */
export function getTgOffset(): number {
  const n = Number(appConfigRepo.get(`channel.tg_${FIELD_OFFSET}`))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function setTgOffset(offset: number): void {
  if (Number.isFinite(offset) && offset > 0) {
    appConfigRepo.set(`channel.tg_${FIELD_OFFSET}`, String(Math.floor(offset)))
  }
}

/** 会话映射 KV key（按 type 分开） */
export function convMapKey(type: ChannelType): string {
  return `${prefixFor(type)}${FIELD_CONV_MAP}`
}
