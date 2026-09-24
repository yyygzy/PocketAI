// app_config KV 敏感凭据的统一加密存取
//
// 适用：Telegram bot token、联网搜索 API Key 等「单值密钥」类配置。
// 落盘为字段级密文（v1: AES-256-GCM，密钥随加密模式：
// db 模式=主密码派生密钥，none 模式=固定混淆密钥），明文只在主进程内存出现。
//
// 配套机制：
// - migrateKvSecrets()：boot 时一次性把历史明文升级为密文（幂等）
// - exportSecrets()/restoreSecrets()：主密码启用/禁用/轮换时随字段密钥重加密

import { appConfigRepo } from '../db/repositories/app-config.repo'
import { encryptSecret, decryptSecret, isCipherText } from './field-encrypt'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { z } from 'zod'

const log = createLogger('crypto')

/** 受管 KV 键（唯一登记处；新增密钥类配置在此注册） */
export const SECRET_KV_KEYS = {
  TELEGRAM_TOKEN: 'channel.tg_token',
  FEISHU_APP_SECRET: 'channel.feishu_app_secret',
  DINGTALK_APP_SECRET: 'channel.dingtalk_app_secret',
  SLACK_BOT_TOKEN: 'channel.slack_bot_token',
  SLACK_APP_TOKEN: 'channel.slack_app_token',
  DISCORD_BOT_TOKEN: 'channel.discord_bot_token',
  WEBSEARCH_API_KEY: 'agent.websearch_api_key'
} as const

/** key 必须是已注册的受管密钥，防止任意 key 污染 app_config */
const secretKeySchema = z.enum(Object.values(SECRET_KV_KEYS) as [string, ...string[]])
/** 单值密钥长度上限（token/API key 通常远小于此；兜底防巨串写入） */
const secretValueSchema = z.string().max(1024)

/** 加密写入；空串/纯空白 = 删除凭据 */
export function setSecret(key: string, value: string): void {
  const k = secretKeySchema.parse(key)
  const raw = secretValueSchema.parse(value)
  const v = raw.trim()
  if (!v) {
    appConfigRepo.delete(k)
    return
  }
  appConfigRepo.set(k, encryptSecret(v))
}

/** 解密读取（不存在/解密失败 → 空串）；历史明文透明兼容 */
export function getSecret(key: string): string {
  return decryptSecret(appConfigRepo.get(key))
}

/** 是否已配置凭据（只看落盘有无值，不触发解密） */
export function hasSecret(key: string): boolean {
  return !!appConfigRepo.get(key)
}

/**
 * 历史明文 → 密文的一次性升级（幂等）。
 * 必须在字段密钥可用时调用（DB 打开且解锁完成后）。
 */
export function migrateKvSecrets(keys: readonly string[] = Object.values(SECRET_KV_KEYS)): void {
  for (const key of keys) {
    const raw = appConfigRepo.get(key)
    if (raw && !isCipherText(raw)) {
      appConfigRepo.set(key, encryptSecret(raw))
      log.info(`KV 凭据已升级为字段加密: ${key}`)
    }
  }
}

/** 密钥轮换前：用「旧字段密钥」导出明文快照（不含键以外的任何信息） */
export function exportSecrets(
  keys: readonly string[] = Object.values(SECRET_KV_KEYS)
): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const key of keys) {
    try {
      const v = getSecret(key)
      if (v) snapshot[key] = v
    } catch (e) {
      log.warn(`轮换导出失败 ${key}:`, errMsg(e))
    }
  }
  return snapshot
}

/** 密钥轮换后：用「新字段密钥」重新加密落盘；空快照对应键保持删除态 */
export function restoreSecrets(snapshot: Record<string, string>): void {
  // 仅校验值类型（string + 长度上限），key 的合法性由 setSecret 内的 secretKeySchema 兜底；
  // 注意：z.record(secretKeySchema, ...) 在 Zod 4 下会把所有 enum key 视为必填，
  // 而 exportSecrets 只导出有值的 key，故此处不能用 enum 作为 key schema。
  const parsed = z.record(z.string(), secretValueSchema).parse(snapshot)
  for (const [key, value] of Object.entries(parsed)) {
    try {
      setSecret(key, value)
    } catch (e) {
      log.warn(`轮换恢复失败 ${key}:`, errMsg(e))
    }
  }
}
