// 用户记忆数据访问（长期记忆条目：Agent 经 memory_save 主动保存，或用户在设置页手动维护）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import { memoryContentSchema, memoryIdSchema } from '../../../shared/schemas/memory'
import type { UserMemoryRecord } from '../../../shared/types'

interface UserMemoryRow {
  id: string
  content: string | null
  created_at: number
  updated_at: number
}

export function rowToRecord(row: UserMemoryRow): UserMemoryRecord {
  return {
    id: row.id,
    content: row.content ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const userMemoryRepo = {
  list(): UserMemoryRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM user_memory ORDER BY updated_at DESC')
      .all() as UserMemoryRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): UserMemoryRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM user_memory WHERE id=?')
      .get(id) as UserMemoryRow | undefined
    return row ? rowToRecord(row) : null
  },

  add(content: string): UserMemoryRecord {
    // 二道防线：绕过 IPC 的内部调用（如 memory_save 工具）同样走 zod 校验
    const text = memoryContentSchema.parse(content)
    const now = Date.now()
    const id = randomUUID()
    dbService
      .getHandle()
      .prepare('INSERT INTO user_memory (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, text, now, now)
    return mustGet(() => this.get(id), '用户记忆')
  },

  update(id: string, content: string): UserMemoryRecord {
    const parsedId = memoryIdSchema.parse(id)
    const text = memoryContentSchema.parse(content)
    const info = dbService
      .getHandle()
      .prepare('UPDATE user_memory SET content=?, updated_at=? WHERE id=?')
      .run(text, Date.now(), parsedId)
    if (info.changes === 0) throw new Error('记忆条目不存在')
    return mustGet(() => this.get(parsedId), '用户记忆')
  },

  remove(id: string): void {
    dbService.getHandle().prepare('DELETE FROM user_memory WHERE id=?').run(memoryIdSchema.parse(id))
  },

  count(): number {
    const row = dbService
      .getHandle()
      .prepare('SELECT COUNT(*) AS n FROM user_memory')
      .get() as { n: number } | undefined
    return row?.n ?? 0
  }
}
