// Skill 数据访问（技能 = 可复用提示词片段）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import type { SkillRecord } from '../../../shared/types'

interface SkillRow {
  id: string
  name: string
  description: string | null
  icon: string | null
  content: string | null
  enabled: number
  is_builtin: number
  created_at: number
}

function rowToRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon ?? '⚡',
    content: row.content ?? '',
    enabled: row.enabled === 1,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at
  }
}

/** 内置 JSON 文件载入后的结构 */
export type BuiltinSkill = Omit<SkillRecord, 'isBuiltin' | 'createdAt' | 'enabled'>

export const skillRepo = {
  list(): SkillRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM skills ORDER BY is_builtin DESC, created_at ASC, rowid ASC')
      .all() as SkillRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): SkillRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM skills WHERE id=?')
      .get(id) as SkillRow | undefined
    return row ? rowToRecord(row) : null
  },

  /** 按 id 批量取已启用技能（保持传入顺序，缺失/禁用的自动跳过） */
  listEnabledByIds(ids: string[]): SkillRecord[] {
    if (!ids || ids.length === 0) return []
    const out: SkillRecord[] = []
    for (const id of ids) {
      const s = this.get(id)
      if (s && s.enabled) out.push(s)
    }
    return out
  },

  /** 内置技能同步：以文件为准 upsert（首次插入 / 后续更新内容，保留用户开关状态） */
  upsertBuiltin(s: BuiltinSkill): void {
    const db = dbService.getHandle()
    const existing = this.get(s.id)
    if (existing) {
      db.prepare(
        `UPDATE skills SET name=?, description=?, icon=?, content=?, is_builtin=1 WHERE id=?`
      ).run(s.name, s.description, s.icon, s.content, s.id)
    } else {
      db.prepare(
        `INSERT INTO skills (id, name, description, icon, content, enabled, is_builtin, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?)`
      ).run(s.id, s.name, s.description, s.icon, s.content, Date.now())
    }
  },

  /** 新建（自定义技能）或保存编辑；内置技能仅允许通过 enabled 字段切换开关 */
  save(input: Partial<SkillRecord> & { name: string }): SkillRecord {
    const db = dbService.getHandle()
    const id = input.id && this.get(input.id) ? input.id : randomUUID()
    const existing = this.get(id)
    if (existing?.isBuiltin) {
      // 内置技能内容锁定，只同步开关状态
      if (input.enabled !== undefined && input.enabled !== existing.enabled) {
        this.setEnabled(id, input.enabled)
      }
      return mustGet(() => this.get(id), '技能')
    }

    const record: SkillRecord = {
      id,
      name: input.name,
      description: input.description ?? existing?.description ?? '',
      icon: input.icon ?? existing?.icon ?? '⚡',
      content: input.content ?? existing?.content ?? '',
      enabled: input.enabled ?? existing?.enabled ?? true,
      isBuiltin: false,
      createdAt: existing?.createdAt ?? Date.now()
    }

    if (existing) {
      db.prepare(
        `UPDATE skills SET name=?, description=?, icon=?, content=?, enabled=? WHERE id=?`
      ).run(record.name, record.description, record.icon, record.content, record.enabled ? 1 : 0, id)
    } else {
      db.prepare(
        `INSERT INTO skills (id, name, description, icon, content, enabled, is_builtin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        record.id, record.name, record.description, record.icon, record.content,
        record.enabled ? 1 : 0, record.createdAt
      )
    }
    return mustGet(() => this.get(id), '技能')
  },

  setEnabled(id: string, enabled: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE skills SET enabled=? WHERE id=?')
      .run(enabled ? 1 : 0, id)
  },

  delete(id: string): void {
    const existing = this.get(id)
    if (!existing) return
    if (existing.isBuiltin) throw new Error('内置技能不可删除')
    dbService.getHandle().prepare('DELETE FROM skills WHERE id=?').run(id)
  }
}
