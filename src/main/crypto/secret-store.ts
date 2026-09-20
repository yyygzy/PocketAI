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

/** 受管 KV 键（唯一登记处；新增密钥类配置在此注册） */
export const SECRET_KV_KEYS = {
  TELEGRAM_TOKEN: 'channel.tg_token',
  WEBSEARCH_API_KEY: 'agent.websearch_api_key'
} as const

/** 加密写入；空串/纯空白 = 删除凭据 */
export function setSecret(key: string, value: string): void {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) {
    appConfigRepo.delete(key)
    return
  }
  appConfigRepo.set(key, encryptSecret(v))
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
      console.log(`[crypto] KV 凭据已升级为字段加密: ${key}`)
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
      console.warn(`[crypto] 轮换导出失败 ${key}:`, e)
    }
  }
  return snapshot
}

/** 密钥轮换后：用「新字段密钥」重新加密落盘；空快照对应键保持删除态 */
export function restoreSecrets(snapshot: Record<string, string>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    try {
      setSecret(key, value)
    } catch (e) {
      console.warn(`[crypto] 轮换恢复失败 ${key}:`, e)
    }
  }
}
