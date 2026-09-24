// Provider 数据访问 — 透明字段加密
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import { encryptApiKeys, decryptApiKeys, isCipherText } from '../../crypto/field-encrypt'
import type { ProviderRecord, ProviderType } from '../../../shared/types'
import { createLogger } from '../../logger'
import { errMsg } from '../../error'

const log = createLogger('crypto')

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
    let existing = input.id ? this.get(input.id) : null
    // 新建（空 id）时按 (type, baseUrl) 去重：已存在同类型+同地址的 provider 则更新它，
    // 避免向导/设置多次保存同一 baseUrl 产生重复条目（如多个 Ollama localhost:11434）。
    if (!existing) {
      const dup = db
        .prepare('SELECT * FROM providers WHERE type=? AND base_url=? LIMIT 1')
        .get(input.type, input.baseUrl) as ProviderRow | undefined
      if (dup) existing = rowToRecord(dup)
    }
    const id = existing?.id ?? (input.id || randomUUID())
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
    return mustGet(() => this.get(id), 'Provider')
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM providers WHERE id = ?').run(id)
  },

  /**
   * 合并同 (type, baseUrl) 的重复 provider（历史脏数据清理）。
   * 保留 created_at 最早的一条，把其余条目的 models / apiKeys 合并进去后删除。
   * 幂等：无重复时直接返回。
   */
  deduplicate(): void {
    const db = dbService.getHandle()
    const rows = db
      .prepare('SELECT id, type, base_url, models, api_key_encrypted FROM providers ORDER BY created_at ASC')
      .all() as { id: string; type: string; base_url: string | null; models: string | null; api_key_encrypted: string | null }[]

    const rowById = new Map(rows.map((r) => [r.id, r]))
    const seen = new Map<string, string>() // key: `${type}|${baseUrl}` → survivor id
    const toDelete: string[] = []

    for (const row of rows) {
      const key = `${row.type}|${row.base_url ?? ''}`
      const survivorId = seen.get(key)
      if (!survivorId) {
        seen.set(key, row.id)
        continue
      }
      // 合并 models 到 survivor（survivorId 来自 seen，必然存在于 rowById）
      const survivorRow = rowById.get(survivorId)
      if (!survivorRow) continue
      const survivorModels = safeJsonArray(survivorRow.models)
      const dupModels = safeJsonArray(row.models)
      const merged = [...new Set([...survivorModels, ...dupModels])]
      db.prepare('UPDATE providers SET models=? WHERE id=?').run(JSON.stringify(merged), survivorId)
      survivorRow.models = JSON.stringify(merged)
      toDelete.push(row.id)
    }

    const delStmt = db.prepare('DELETE FROM providers WHERE id=?')
    for (const id of toDelete) delStmt.run(id)
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
        log.info(`Provider 凭据已升级为字段加密: ${row.id}`)
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
        log.warn(`Provider 凭据轮换恢复失败 ${id}:`, errMsg(e))
      }
    }
  }
}
