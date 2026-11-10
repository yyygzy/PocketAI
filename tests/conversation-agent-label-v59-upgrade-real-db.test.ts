// v59 真实升级路径（普通库）：v58 老库（含 `agent:` 前缀行、混合 `agent_mode`）→ v59。
//
// 为什么用真库：v59 是**数据回填**，只有真跑一遍 SQL 才能证明「前缀剥了、位脸对了、
// 其他列没被动过」。MIGRATIONS 未导出，无法在 v58 原地停住；v59 只改数据，所以
// 「跑完全链后插入 v58 状态的行 + 删掉 v59 的记录」即等价于 v58 库。
//
// 判据：前缀行剥成 `provider:model` 且 `agent_mode=1`；非前缀行（含混合 0/1）逐字不变；
// 除 `model`/`agent_mode` 外全部列逐字节不变；行不丢不重；integrity_check；
// 版本记录落库；重跑迁移不抛且空操作；启动幂等修复可反复跑、对已修复行空操作、能自愈残留。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conv-agent-v59-upgrade'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'

/** conversations 的全部业务列（顺序与建表/增量 migration 落库顺序一致） */
const ALL_COLS = [
  'id',
  'assistant_id',
  'title',
  'model',
  'params',
  'status',
  'created_at',
  'updated_at',
  'pinned',
  'archived',
  'archived_at',
  'title_default',
  'group_id',
  'note',
  'system_prompt_override',
  'parent_conversation_id',
  'role_key',
  'agent_mode'
] as const

type Cell = string | number | null
type Row = Record<(typeof ALL_COLS)[number], Cell>

/** v59 只许改这两列；其余列逐字节比对 */
const UNTOUCHED_COLS = ALL_COLS.filter((c) => c !== 'model' && c !== 'agent_mode')

function db() {
  return dbService.getHandle()
}

function integrity(): string[] {
  const rows = db().prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  return rows.map((r) => r.integrity_check)
}

function versionName(version: number): string | undefined {
  return (
    db().prepare('SELECT name FROM schema_migrations WHERE version=?').get(version) as
      | { name: string }
      | undefined
  )?.name
}

function selectAll(): Row[] {
  return db().prepare(`SELECT ${ALL_COLS.join(', ')} FROM conversations ORDER BY id`).all() as Row[]
}

function selectUntouched(): Array<Record<string, Cell>> {
  return db()
    .prepare(`SELECT ${UNTOUCHED_COLS.join(', ')} FROM conversations ORDER BY id`)
    .all() as Array<Record<string, Cell>>
}

function seedRows(): Row[] {
  return [
    {
      id: 'v59-a',
      assistant_id: null,
      title: '前缀·关闭',
      model: 'agent:prov-a:model-a',
      params: null,
      status: 'idle',
      created_at: 1_700_000_000_001,
      updated_at: 1_700_000_000_101,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: '备注 A',
      system_prompt_override: '覆盖提示词',
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 0
    },
    {
      id: 'v59-b',
      assistant_id: 'asst-x',
      title: '前缀·开启',
      model: 'agent:prov-b:model-b',
      params: '{"temperature":0.7}',
      status: 'done',
      created_at: 1_700_000_000_002,
      updated_at: 1_700_000_000_102,
      pinned: 1,
      archived: 0,
      archived_at: null,
      title_default: 1,
      group_id: 'grp-1',
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: 'writer',
      agent_mode: 1
    },
    {
      id: 'v59-c',
      assistant_id: null,
      title: '正常·关闭',
      model: 'prov-c:model-c',
      params: null,
      status: 'idle',
      created_at: 1_700_000_000_003,
      updated_at: 1_700_000_000_103,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 0
    },
    {
      id: 'v59-d',
      assistant_id: null,
      title: '正常·开启',
      model: 'prov-d:model-d',
      params: null,
      status: 'streaming',
      created_at: 1_700_000_000_004,
      updated_at: 1_700_000_000_104,
      pinned: 0,
      archived: 1,
      archived_at: 1_700_000_000_204,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 1
    },
    {
      id: 'v59-e',
      assistant_id: null,
      title: '空模型',
      model: null,
      params: null,
      status: 'idle',
      created_at: 1_700_000_000_005,
      updated_at: 1_700_000_000_105,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 0
    },
    {
      id: 'v59-f',
      assistant_id: null,
      title: '只有前缀',
      model: 'agent:',
      params: null,
      status: 'idle',
      created_at: 1_700_000_000_006,
      updated_at: 1_700_000_000_106,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 0
    },
    {
      id: 'v59-g',
      assistant_id: null,
      title: '相似前缀',
      model: 'agentic:model-g',
      params: null,
      status: 'idle',
      created_at: 1_700_000_000_007,
      updated_at: 1_700_000_000_107,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 0
    },
    {
      id: 'v59-h',
      assistant_id: null,
      title: '子会话前缀',
      model: 'agent:prov-h:model-h',
      params: null,
      status: 'idle',
      created_at: 1_700_000_000_008,
      updated_at: 1_700_000_000_108,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: 'v59-a',
      role_key: 'researcher',
      agent_mode: 0
    }
  ]
}

/** v59 执行后的期望（只列 model / agent_mode；其余列必须逐字不变） */
const EXPECTED: Record<string, { model: Cell; agent_mode: Cell }> = {
  'v59-a': { model: 'prov-a:model-a', agent_mode: 1 },
  'v59-b': { model: 'prov-b:model-b', agent_mode: 1 },
  'v59-c': { model: 'prov-c:model-c', agent_mode: 0 },
  'v59-d': { model: 'prov-d:model-d', agent_mode: 1 },
  'v59-e': { model: null, agent_mode: 0 },
  // 只有前缀（长度 6）：按方案保留原样，不写成空串
  'v59-f': { model: 'agent:', agent_mode: 0 },
  'v59-g': { model: 'agentic:model-g', agent_mode: 0 },
  'v59-h': { model: 'prov-h:model-h', agent_mode: 1 }
}

let SEED: Row[] = []

function insertRows(rows: Row[]): void {
  const sql = `INSERT INTO conversations (${ALL_COLS.join(', ')})
               VALUES (${ALL_COLS.map(() => '?').join(', ')})`
  const insert = db().prepare(sql)
  for (const r of rows) insert.run(...ALL_COLS.map((c) => r[c]))
}

/** 把库还原成 v58 状态：删掉 v59 的迁移记录（v59 只改数据，删记录即"还没跑过"） */
function restoreV58State(rows: Row[]): void {
  db().prepare('DELETE FROM schema_migrations WHERE version=59').run()
  insertRows(rows)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  SEED = seedRows()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 关不掉不掩盖结论 */
  }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch {
    /* scratch 残留由临时目录承担 */
  }
})

describe('v58 → v59 真实升级（含 agent: 前缀与混合 agent_mode）', () => {
  it('造出 v58 状态：前缀行原样在库、两组 agent_mode 都有行', () => {
    restoreV58State(SEED)
    const rows = selectAll()
    expect(rows).toHaveLength(SEED.length)
    expect(rows.filter((r) => (r.model as string | null)?.startsWith('agent:')).length).toBe(4)
    expect(rows.filter((r) => r.agent_mode === 0)).toHaveLength(6)
    expect(rows.filter((r) => r.agent_mode === 1)).toHaveLength(2)
    expect(integrity()).toEqual(['ok'])
  })

  it('跑 v59 后：前缀剥掉、位脸正确、行不丢不重、其余列逐字节不变', () => {
    const before = selectAll()
    const beforeUntouched = selectUntouched()

    expect(() => dbService.runMigrations()).not.toThrow()

    const after = selectAll()
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length)

    for (const r of after) {
      const exp = EXPECTED[r.id as string]!
      expect(r.model, `${r.id}.model 迁移结果不对`).toBe(exp.model)
      expect(r.agent_mode, `${r.id}.agent_mode 迁移结果不对`).toBe(exp.agent_mode)
    }

    // 除 model / agent_mode 外的 16 列逐字节比对
    expect(selectUntouched()).toEqual(beforeUntouched)
    expect(integrity()).toEqual(['ok'])
    expect(versionName(59)).toBe('strip_agent_model_label')
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(62)
  })

  it('重复跑迁移不抛且空操作：删掉 v59 记录再跑，行完全不变', () => {
    const before = selectAll()
    db().prepare('DELETE FROM schema_migrations WHERE version=59').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(selectAll()).toEqual(before)
    expect(versionName(59)).toBe('strip_agent_model_label')
    expect(integrity()).toEqual(['ok'])
  })

  it('启动幂等修复：对已修复行空操作、反复跑不抛、能自愈降级期写回的残留前缀', () => {
    expect(dbService.repairLegacyAgentLabels(), '已修复行上不该再命中').toBe(0)
    expect(dbService.repairLegacyAgentLabels(), '反复跑不抛').toBe(0)

    // 模拟旧版本降级期间又写回前缀（同时 agent_mode 仍是关闭）
    db()
      .prepare(
        `INSERT INTO conversations (id, assistant_id, title, model, status, created_at, updated_at, title_default, agent_mode)
         VALUES ('v59-residual', NULL, '降级残留', 'agent:prov-r:model-r', 'idle', ?, ?, 0, 0)`
      )
      .run(1_700_000_000_009, 1_700_000_000_109)

    expect(dbService.repairLegacyAgentLabels(), '残留前缀应被启动修复命中').toBe(1)
    const fixed = db()
      .prepare("SELECT model, agent_mode FROM conversations WHERE id='v59-residual'")
      .get() as { model: string; agent_mode: number }
    expect(fixed).toEqual({ model: 'prov-r:model-r', agent_mode: 1 })
    expect(dbService.repairLegacyAgentLabels(), '修复后再跑还是空操作').toBe(0)
    expect(integrity()).toEqual(['ok'])
  })
})
