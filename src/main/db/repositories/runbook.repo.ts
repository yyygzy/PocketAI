// v74：流程模板（agent_runbooks）数据访问。
//
// 一行一个模板；`steps` / `refs` / `tool_permissions` 都是 JSON 文本。
// 解析失败一律降级成空数组而不是抛错：模板是旁路资产，坏一行不该让整个面板打不开；
// 但空数组会让「缺引用」看起来像「没有引用」，所以主进程的校验与生成都只走写入口，
// 读取端不猜修复（见 runbook-service 的注释）。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { RunbookRecord, RunbookRef, RunbookStep } from '../../../shared/runbook'

interface RunbookRow {
  id: string
  name: string
  prompt_summary: string
  steps: string
  refs: string
  tool_permissions: string
  created_at: number
  updated_at: number
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToRecord(row: RunbookRow): RunbookRecord {
  return {
    id: row.id,
    name: row.name,
    promptSummary: row.prompt_summary,
    steps: parseArray<RunbookStep>(row.steps),
    refs: parseArray<RunbookRef>(row.refs),
    toolPermissions: parseArray<string>(row.tool_permissions).filter((x) => typeof x === 'string'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface RunbookInsert {
  name: string
  promptSummary: string
  steps: RunbookStep[]
  refs: RunbookRef[]
  toolPermissions?: string[]
}

export interface RunbookPatch {
  name?: string
  toolPermissions?: string[]
}

export const runbookRepo = {
  /** 全部模板（最近更新的在前） */
  list(): RunbookRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM agent_runbooks ORDER BY updated_at DESC, rowid DESC')
      .all() as RunbookRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): RunbookRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM agent_runbooks WHERE id=?')
      .get(id) as RunbookRow | undefined
    return row ? rowToRecord(row) : null
  },

  insert(input: RunbookInsert): RunbookRecord {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO agent_runbooks
           (id, name, prompt_summary, steps, refs, tool_permissions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.promptSummary,
        JSON.stringify(input.steps),
        JSON.stringify(input.refs),
        JSON.stringify(input.toolPermissions ?? []),
        now,
        now
      )
    return {
      id,
      name: input.name,
      promptSummary: input.promptSummary,
      steps: input.steps,
      refs: input.refs,
      toolPermissions: input.toolPermissions ?? [],
      createdAt: now,
      updatedAt: now
    }
  },

  /** 只改名字与本地授权；流程形状（步骤/引用）从模板生成后不再改写 */
  update(id: string, patch: RunbookPatch): RunbookRecord | null {
    const existing = this.get(id)
    if (!existing) return null
    const name = patch.name?.trim() ? patch.name.trim().slice(0, 100) : existing.name
    const toolPermissions = patch.toolPermissions
      ? patch.toolPermissions.filter((t) => typeof t === 'string' && t.length > 0)
      : existing.toolPermissions
    const now = Date.now()
    dbService
      .getHandle()
      .prepare('UPDATE agent_runbooks SET name=?, tool_permissions=?, updated_at=? WHERE id=?')
      .run(name, JSON.stringify(toolPermissions), now, id)
    return { ...existing, name, toolPermissions, updatedAt: now }
  },

  delete(id: string): boolean {
    const res = dbService.getHandle().prepare('DELETE FROM agent_runbooks WHERE id=?').run(id)
    return res.changes > 0
  }
}
