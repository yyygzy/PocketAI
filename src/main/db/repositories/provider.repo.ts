// Provider 数据访问 — 透明字段加密
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { encryptApiKeys, decryptApiKeys, isCipherText } from '../../crypto/field-encrypt'
import type { ProviderRecord, ProviderType } from '../../../shared/types'

interface ProviderRow {
  id: string
  type: string
  name: string
  base_url: string | null
  api_key_encrypted: string | null
  models: string | null
  enabled: number
  created_at: number
}

function rowToRecord(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    type: row.type as ProviderType,
    name: row.name,
    baseUrl: row.base_url ?? '',
    apiKeys: decryptApiKeys(row.api_key_encrypted),
    models: safeJsonArray(row.models),
    enabled: row.enabled === 1,
    createdAt: row.created_at
  }
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export const providerRepo = {
  list(): ProviderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM providers ORDER BY created_at ASC')
      .all() as ProviderRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): ProviderRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM providers WHERE id = ?')
      .get(id) as ProviderRow | undefined
    return row ? rowToRecord(row) : null
  },

  save(input: Omit<ProviderRecord, 'createdAt'> & { createdAt?: number }): ProviderRecord {
    const db = dbService.getHandle()
    const existing = input.id ? this.get(input.id) : null
    const id = input.id || randomUUID()
    const createdAt = existing?.createdAt ?? input.createdAt ?? Date.now()

    // 字段加密：apiKeys → 密文
    const apiKeysCipher = encryptApiKeys(input.apiKeys)
    const models = JSON.stringify(input.models)
    const enabled = input.enabled ? 1 : 0

    if (existing) {
      db.prepare(
        `UPDATE providers SET type=?, name=?, base_url=?, api_key_encrypted=?, models=?, enabled=? WHERE id=?`
      ).run(input.type, input.name, input.baseUrl, apiKeysCipher, models, enabled, id)
    } else {
      db.prepare(
        `INSERT INTO providers (id, type, name, base_url, api_key_encrypted, models, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input.type, input.name, input.baseUrl, apiKeysCipher, models, enabled, createdAt)
    }
    return this.get(id)!
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM providers WHERE id = ?').run(id)
  },

  updateModels(id: string, models: string[]): void {
    dbService
      .getHandle()
      .prepare('UPDATE providers SET models=? WHERE id=?')
      .run(JSON.stringify(models), id)
  },

  /**
   * 历史明文 apiKeys（明文 JSON、非 v1: 密文）→ 当前字段密钥密文的一次性升级（幂等）。
   * 必须在字段密钥可用时调用（DB 打开且解锁完成后）。
   */
  migratePlaintextKeys(): void {
    const db = dbService.getHandle()
    const rows = db
      .prepare('SELECT id, api_key_encrypted FROM providers WHERE api_key_encrypted IS NOT NULL')
      .all() as Pick<ProviderRow, 'id' | 'api_key_encrypted'>[]
    const stmt = db.prepare('UPDATE providers SET api_key_encrypted=? WHERE id=?')
    for (const row of rows) {
      const stored = row.api_key_encrypted
      if (stored && !isCipherText(stored)) {
        const keys = decryptApiKeys(stored)
        stmt.run(encryptApiKeys(keys), row.id)
        console.log(`[crypto] Provider 凭据已升级为字段加密: ${row.id}`)
      }
    }
  },

  /**
   * 密钥轮换前：用「旧字段密钥」导出全部 provider 的 apiKeys 明文。
   * 解密失败的行（空数组）也保留原值，由恢复阶段决定写回策略。
   */
  exportAllApiKeys(): Record<string, string[]> {
    const snapshot: Record<string, string[]> = {}
    for (const row of this.list()) {
      if (row.apiKeys.length > 0) snapshot[row.id] = row.apiKeys
    }
    return snapshot
  },

  /**
   * 密钥轮换后：用「新字段密钥」重新加密并重写所有 provider 凭据。
   * 仅处理快照中存在且行仍存在的 id；新增/删除的 provider 互不影响。
   */
  restoreAllApiKeys(snapshot: Record<string, string[]>): void {
    const db = dbService.getHandle()
    const stmt = db.prepare('UPDATE providers SET api_key_encrypted=? WHERE id=?')
    for (const [id, apiKeys] of Object.entries(snapshot)) {
      try {
        stmt.run(encryptApiKeys(apiKeys), id)
      } catch (e) {
        console.warn(`[crypto] Provider 凭据轮换恢复失败 ${id}:`, e)
      }
    }
  }
}
