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
  /** v63：作者自由文本分类；缺列（老库）按 '' 读 */
  category?: string | null
  /** v63：作者自由文本标签（JSON 数组文本）；缺列/NULL/损坏都按 [] 读 */
  tags?: string | null
  enabled: number
  /** v51：1=正文常驻 system prompt；0=只留名字与用途，正文靠 load_skill 取。缺列（老库）按 1 读 */
  resident?: number | null
  is_builtin: number
  created_at: number
}

/** 标签列 → 字符串数组。标签是作者自由文本，用 JSON 存（逗号拼接会把含逗号的标签切碎）。 */
export function parseSkillTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 字符串数组 → 标签列；空/无效一律写 '[]'，不写 NULL（"没读到"与"没有"在读取端已经同义） */
function stringifySkillTags(tags: string[] | undefined): string {
  return JSON.stringify((tags ?? []).map((t) => t.trim()).filter(Boolean))
}

export function rowToRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon ?? '⚡',
    content: row.content ?? '',
    // 缺列/NULL 都读成空值：老库升上来不是"作者写了空分类"，界面只按非空渲染
    category: row.category ?? '',
    tags: parseSkillTags(row.tags),
    enabled: row.enabled === 1,
    // 缺列/NULL 都按常驻读：老库升上来行为不变，"没读到"不许演成"用户关过"
    resident: row.resident !== 0,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at
  }
}

/** 内置 JSON 文件载入后的结构 */
export type BuiltinSkill = Omit<SkillRecord, 'isBuiltin' | 'createdAt' | 'enabled' | 'resident'>

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
        `UPDATE skills SET name=?, description=?, icon=?, content=?, category=?, tags=?, is_builtin=1 WHERE id=?`
      ).run(
        s.name, s.description, s.icon, s.content, s.category,
        stringifySkillTags(s.tags), s.id
      )
    } else {
      db.prepare(
        `INSERT INTO skills (id, name, description, icon, content, category, tags, enabled, is_builtin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`
      ).run(
        s.id, s.name, s.description, s.icon, s.content, s.category,
        stringifySkillTags(s.tags), Date.now()
      )
    }
  },

  /** 现存内置技能 id（内置清单同步时用它对比"文件已移除"的行） */
  listBuiltinIds(): string[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT id FROM skills WHERE is_builtin=1')
      .all() as Array<{ id: string }>
    return rows.map((r) => r.id)
  },

  /** 清理已下线的内置技能：**只删 is_builtin=1 的行**（用户导入/自建的行连条件都匹配不上）。
   *  返回 true 表示真的删了一行（被引用时调用方会先走 disableBuiltin，不会到这里）。 */
  deleteBuiltinIfUnused(id: string): boolean {
    const info = dbService
      .getHandle()
      .prepare('DELETE FROM skills WHERE id=? AND is_builtin=1')
      .run(id)
    return info.changes > 0
  },

  /** 被助手仍引用的下线内置技能：保留行与内容、只停用（不进注入面，用户可自行恢复）。
   *  只在 enabled=1 时翻转，重复同步不会重复"清理"。 */
  disableBuiltin(id: string): boolean {
    const info = dbService
      .getHandle()
      .prepare('UPDATE skills SET enabled=0 WHERE id=? AND is_builtin=1 AND enabled=1')
      .run(id)
    return info.changes > 0
  },

  /** 新建（自定义技能）或保存编辑；内置技能仅允许通过 enabled 字段切换开关 */
  save(input: Partial<SkillRecord> & { name: string }): SkillRecord {
    const db = dbService.getHandle()
    const id = input.id && this.get(input.id) ? input.id : randomUUID()
    const existing = this.get(id)
    if (existing?.isBuiltin) {
      // 内置技能内容锁定，只同步两个开关：启不启用、要不要常驻（§236 的常驻是用户偏好，不是内容）
      if (input.enabled !== undefined && input.enabled !== existing.enabled) {
        this.setEnabled(id, input.enabled)
      }
      if (input.resident !== undefined && input.resident !== existing.resident) {
        this.setResident(id, input.resident)
      }
      return mustGet(() => this.get(id), '技能')
    }

    const record: SkillRecord = {
      id,
      name: input.name,
      description: input.description ?? existing?.description ?? '',
      icon: input.icon ?? existing?.icon ?? '⚡',
      content: input.content ?? existing?.content ?? '',
      category: input.category ?? existing?.category ?? '',
      tags: input.tags ?? existing?.tags ?? [],
      enabled: input.enabled ?? existing?.enabled ?? true,
      resident: input.resident ?? existing?.resident ?? true,
      isBuiltin: false,
      createdAt: existing?.createdAt ?? Date.now()
    }

    if (existing) {
      db.prepare(
        `UPDATE skills SET name=?, description=?, icon=?, content=?, category=?, tags=?, enabled=?, resident=? WHERE id=?`
      ).run(
        record.name, record.description, record.icon, record.content,
        record.category, stringifySkillTags(record.tags),
        record.enabled ? 1 : 0, record.resident ? 1 : 0, id
      )
    } else {
      db.prepare(
        `INSERT INTO skills (id, name, description, icon, content, category, tags, enabled, resident, is_builtin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        record.id, record.name, record.description, record.icon, record.content,
        record.category, stringifySkillTags(record.tags),
        record.enabled ? 1 : 0, record.resident ? 1 : 0, record.createdAt
      )
    }
    return mustGet(() => this.get(id), '技能')
  },

  /** 常驻开关（§236）：只动这一列，内容一个字不碰 */
  setResident(id: string, resident: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE skills SET resident=? WHERE id=?')
      .run(resident ? 1 : 0, id)
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
