// Provider 数据访问 — 透明字段加密
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import { encryptApiKeys, decryptApiKeys, isCipherText, hasUndecryptableCipher } from '../../crypto/field-encrypt'
import { isNoneMode, newSecretValues, NONE_MODE_HINT } from '../../crypto/none-mode-gate'
import { restoreMaskedList } from '../../../shared/secret-mask'
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
    // 命中方式必须分清（151）：带 id 命中 = 调用方就是在改这一条；只有 (type, baseUrl) 命中 =
    // 调用方以为自己在"新建"（向导/设置页都是发空 id 走这条去重）。
    let foundByDedupe = false
    // 新建（空 id）时按 (type, baseUrl) 去重：已存在同类型+同地址的 provider 则更新它，
    // 避免向导/设置多次保存同一 baseUrl 产生重复条目（如多个 Ollama localhost:11434）。
    if (!existing) {
      const dup = db
        .prepare('SELECT * FROM providers WHERE type=? AND base_url=? LIMIT 1')
        .get(input.type, input.baseUrl) as ProviderRow | undefined
      if (dup) {
        existing = rowToRecord(dup)
        foundByDedupe = true
      }
    }
    const id = existing?.id ?? (input.id || randomUUID())
    const createdAt = existing?.createdAt ?? input.createdAt ?? Date.now()

    // 字段加密：apiKeys → 密文
    // 渲染层传来的是掩码视图（PROVIDER_LIST 不回明文），占位项按原值回填，
    // 使「只改名称/模型列表」的保存不会把 ••••abcd 当真密钥写库。
    // §328：回填之后去重。首启向导那条「已有同 baseUrl 就追加这把 Key」在中途失败后会被再点一次，
    // 而界面上看得见的是掩码串，追加的那把是明文 ⇒ 调用处 `includes` 永远对不上（掩码 ≠ 明文），
    // 只有还原成真实值这一刻才判得出"这把已经在库里"。同一把 Key 存两遍没有任何合法含义。
    const apiKeys = [...new Set(restoreMaskedList(input.apiKeys, existing?.apiKeys))]
    // B1：明文模式的字段密钥是源码公开的固定密钥 ⇒ 新 Key 一律拒存（沿用掩码原值、删 Key 不触发）。
    // 只报数量不回显 Key。
    if (isNoneMode()) {
      const gained = newSecretValues(apiKeys, existing?.apiKeys ?? [])
      if (gained.length > 0) {
        throw new Error(
          `未设置主密码，API Key 不会被保存（本次新增或改动 ${gained.length} 个）。${NONE_MODE_HINT}`
        )
      }
    }
    const apiKeysCipher = encryptApiKeys(apiKeys)
    // models 的两种"空"必须分开（V4-Iter-151，向导里真撞出来的）：
    //  · 带 id 的保存里 `[]` 是**用户自己删到零**（设置页逐个 ✕，V4-Iter-115 那条合法路径）⇒ 照写；
    //  · 不带 id 的保存靠 (type,baseUrl) 命中旧行时，调用方**以为自己在新建**，那份 `[]` 只是表单默认值，
    //    它不代表"把这台已缓存的模型清单清空"⇒ 保留旧值。
    //  真覆盖成"没模型"是危险的：对话页会因挑不到有模型的 provider 而整栏空掉。
    //  判据只有一条、不看长度以外的事：见上面 `foundByDedupe` 的注释。要清空请带 id。
    const models = JSON.stringify(
      foundByDedupe && input.models.length === 0 ? existing!.models : input.models
    )
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
   * §375：解不开的行（有密文却解出空＝旧字段密钥不匹配／密文损坏）不能进快照——
   * 若也按旧口径「空数组=没配过」悄悄略过，restore 阶段根本不遍历它、旧钥密文原地留在被换掉的密钥下 ⇒ 永久解不开。
   * 所以把它们单列进 undecryptable（跳过重写、保持原密文，交给调用方如实上报），与「真没配密钥」分两栏。
   */
  exportAllApiKeys(): { snapshot: Record<string, string[]>; undecryptable: string[] } {
    const snapshot: Record<string, string[]> = {}
    const undecryptable: string[] = []
    const rows = dbService
      .getHandle()
      .prepare('SELECT id, api_key_encrypted FROM providers')
      .all() as { id: string; api_key_encrypted: string | null }[]
    for (const row of rows) {
      const keys = decryptApiKeys(row.api_key_encrypted)
      if (keys.length > 0) snapshot[row.id] = keys
      else if (hasUndecryptableCipher(row.api_key_encrypted)) undecryptable.push(row.id)
    }
    return { snapshot, undecryptable }
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
