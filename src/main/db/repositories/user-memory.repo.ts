// 用户记忆数据访问（长期记忆条目：Agent 经 memory_save 主动保存，或用户在设置页手动维护）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import {
  MEMORY_MAX_ROWS,
  memoryContentSchema,
  memoryIdSchema
} from '../../../shared/schemas/memory'
import type { UserMemoryRecord, UserMemorySource } from '../../../shared/types'

interface UserMemoryRow {
  id: string
  content: string | null
  source: UserMemorySource
  conversation_id: string | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

/** 写入来源（缺省=设置页手写；memory_save 显式传 agent） */
export interface AddMemoryMeta {
  source?: UserMemorySource
  conversationId?: string | null
}

export function rowToRecord(row: UserMemoryRow): UserMemoryRecord {
  return {
    id: row.id,
    content: row.content ?? '',
    source: row.source,
    conversationId: row.conversation_id,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 到上限后拒绝写入，不清理最旧——静默删用户数据不可接受（见 shared/schemas/memory.ts） */
function assertUnderLimit(activeCount: number): void {
  if (activeCount >= MEMORY_MAX_ROWS) {
    throw new Error(`记忆条目已达上限（${MEMORY_MAX_ROWS} 条），请先删除旧记忆`)
  }
}

export const userMemoryRepo = {
  /** 召回与设置页列表都只取未删除行，按最近更新倒序 */
  list(): UserMemoryRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM user_memory WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all() as UserMemoryRow[]
    return rows.map(rowToRecord)
  },

  /** 含已软删除行；恢复/内部判重之外的调用方应使用 list() */
  get(id: string): UserMemoryRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM user_memory WHERE id=?')
      .get(id) as UserMemoryRow | undefined
    return row ? rowToRecord(row) : null
  },

  /** 已删除条目（设置页「已删除」视图），最近删除的在前 */
  listDeleted(): UserMemoryRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM user_memory WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all() as UserMemoryRow[]
    return rows.map(rowToRecord)
  },

  add(content: string, meta: AddMemoryMeta = {}): UserMemoryRecord {
    // 二道防线：绕过 IPC 的内部调用（如 memory_save 工具）同样走 zod 校验
    const text = memoryContentSchema.parse(content)
    assertUnderLimit(this.count())
    const now = Date.now()
    const id = randomUUID()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO user_memory
           (id, content, source, conversation_id, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(id, text, meta.source ?? 'user', meta.conversationId ?? null, now, now)
    return mustGet(() => this.get(id), '用户记忆')
  },

  update(id: string, content: string): UserMemoryRecord {
    const parsedId = memoryIdSchema.parse(id)
    const text = memoryContentSchema.parse(content)
    const info = dbService
      .getHandle()
      .prepare('UPDATE user_memory SET content=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(text, Date.now(), parsedId)
    if (info.changes === 0) throw new Error('记忆条目不存在')
    return mustGet(() => this.get(parsedId), '用户记忆')
  },

  /** 软删除：只打删除时间，行仍在库中，可经 restore 撤销 */
  remove(id: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE user_memory SET deleted_at=? WHERE id=? AND deleted_at IS NULL')
      .run(Date.now(), memoryIdSchema.parse(id))
  },

  /** 撤销软删除；活跃行数已达上限时拒绝，避免用恢复绕过行数上限 */
  restore(id: string): UserMemoryRecord {
    const parsedId = memoryIdSchema.parse(id)
    assertUnderLimit(this.count())
    const info = dbService
      .getHandle()
      .prepare('UPDATE user_memory SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL')
      .run(parsedId)
    if (info.changes === 0) throw new Error('记忆条目不存在或未被删除')
    return mustGet(() => this.get(parsedId), '用户记忆')
  },

  /** 物理删除：只给明确的清理动作使用，普通「删除」一律走 remove 软删除 */
  purge(id: string): void {
    dbService.getHandle().prepare('DELETE FROM user_memory WHERE id=?').run(memoryIdSchema.parse(id))
  },

  /** 批量物理删除（设置页二次确认后的清理动作），按 500 条分片避免超出 SQLite 绑定参数上限 */
  purgeMany(ids: string[]): number {
    if (ids.length === 0) return 0
    let deleted = 0
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const placeholders = chunk.map(() => '?').join(',')
      const info = dbService
        .getHandle()
        .prepare(`DELETE FROM user_memory WHERE id IN (${placeholders})`)
        .run(...chunk)
      deleted += info.changes
    }
    return deleted
  },

  /** 活跃行数（软删除行不计入上限） */
  count(): number {
    const row = dbService
      .getHandle()
      .prepare('SELECT COUNT(*) AS n FROM user_memory WHERE deleted_at IS NULL')
      .get() as { n: number } | undefined
    return row?.n ?? 0
  }
}
