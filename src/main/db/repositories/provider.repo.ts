// Provider 数据访问 — 透明字段加密
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { encryptApiKeys, decryptApiKeys } from '../../crypto/field-encrypt'
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
  }
}
