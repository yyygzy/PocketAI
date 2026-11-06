// 内置助手的初始技能绑定（v56）与受限写方法
//
// 为什么要有这张常量表：`extensions/assistants/*.json` 是**新装机首次插入**的数据源
// （`assistantRepo.upsertBuiltin` 首次插入读它），而迁移 v56 要补的是**老库里已经存在**的内置行——
// 那时 json 已经同步过、`upsertBuiltin` 对已有行故意不写 `skill_ids`（保留用户改动）。
// 迁移跑在文件同步之前/之外，不读文件系统，所以这份映射在这里落成代码常量；
// 与 json 的一致性由 `tests/builtin-assistant-skill-bindings-v56.test.ts` 逐条对账。
//
// 口径（用户已拍板）：每个内置助手只给 1–2 条语义直接对口的技能；
// `skill-concise` 与 `skill-prompt-engineer` 不绑任何内置助手；通用问答保持空（默认助手要中性）。
import type Database from 'better-sqlite3-multiple-ciphers'

export const BUILTIN_ASSISTANT_SKILL_IDS: Readonly<Record<string, readonly string[]>> = {
  'asst-coder': ['skill-bug-diagnostician', 'skill-code-review'],
  'asst-analyst': ['skill-data-analyst', 'skill-structured-output'],
  'asst-writer': ['skill-writer', 'skill-polish'],
  'asst-translator': ['skill-translator'],
  'asst-academic': ['skill-deep-think', 'skill-structured-output'],
  'asst-tutor': ['skill-deep-think', 'skill-structured-output'],
  'asst-pm': ['skill-solution-design'],
  'asst-default': []
}

function parseIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * 受限写方法：把给定的技能 id **并集**进某条内置助手的 `skill_ids`。
 *
 * 它为什么存在：`assistantRepo.save()` 遇到 `is_builtin=1` 的行会直接抛
 * 「内置助手不可编辑，请先复制为我的助手」——这是对的（内置助手整体不可编辑），
 * 但 v56 需要给**已存在**的内置行补初始绑定，属于"只动这一列"的迁移写入，
 * 不该为了它放开整个 save() 的闸门。
 *
 * 允许写什么：**只有 `skill_ids` 一列**，且 SQL 条件带 `is_builtin=1`。
 * 不允许写什么：`enabled`（技能开关是另一张表的事、本方法压根不碰）、助手的其它任何列、
 * `is_builtin=0` 的用户助手。也不覆盖：原有 id 全部保留在原顺序，新 id 只追加缺失的。
 *
 * 幂等：并集后长度没变就不落盘；连跑两次结果相同。返回本次新增的 id 数。
 */
export function mergeBuiltinSkillIds(
  db: Database.Database,
  id: string,
  addIds: readonly string[]
): number {
  const row = db
    .prepare('SELECT skill_ids FROM assistants WHERE id=? AND is_builtin=1')
    .get(id) as { skill_ids: string | null } | undefined
  if (!row) return 0

  const prev = parseIds(row.skill_ids)
  const next = [...prev]
  for (const skillId of addIds) {
    if (!next.includes(skillId)) next.push(skillId)
  }
  if (next.length === prev.length) return 0

  db.prepare('UPDATE assistants SET skill_ids=? WHERE id=? AND is_builtin=1').run(
    JSON.stringify(next),
    id
  )
  return next.length - prev.length
}
