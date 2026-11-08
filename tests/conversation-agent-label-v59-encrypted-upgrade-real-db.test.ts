// v59 真实升级路径 · 加密库版：v58 老库（含 `agent:` 前缀行、混合 `agent_mode`）→ v59，
// 全程跑在 SQLite3MultipleCiphers 加密库上（页级 AES-256-GCM，文件头不是 "SQLite format 3"）。
//
// 为什么另起一份：普通 SQLite 上 UPDATE 安全，不等于加密库上安全；产品真实库是加密库，
// 这里用测试口令（不是真实主密码）走 dbService.open(masterKey) 的同一 opening 路径。
// 造 v58 库：跑全链后 DELETE schema_migrations v59 + 插入 v58 状态行（v59 只改数据）。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conv-agent-v59-encrypted-upgrade'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { masterKeyManager } from '../src/main/crypto/master-key'

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

const UNTOUCHED_COLS = ALL_COLS.filter((c) => c !== 'model' && c !== 'agent_mode')

/** 测试口令派生的库密钥；与产品一样只存在内存里，不写真实 key 文件 */
let DB_KEY: Buffer | null = null

function db(): Database.Database {
  return dbService.getHandle()
}

function integrity(): string[] {
  const rows = db().prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  return rows.map((r) => r.integrity_check)
}

function journalMode(): string {
  return db().pragma('journal_mode', { simple: true }) as string
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
      id: 'enc-v59-a',
      assistant_id: null,
      title: '加密库·前缀·关闭',
      model: 'agent:prov-a:model-a',
      params: null,
      status: 'idle',
      created_at: 1_700_000_200_001,
      updated_at: 1_700_000_200_101,
      pinned: 0,
      archived: 0,
      archived_at: null,
      title_default: 0,
      group_id: null,
      note: '加密备注',
      system_prompt_override: '加密覆盖提示',
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 0
    },
    {
      id: 'enc-v59-b',
      assistant_id: 'asst-enc',
      title: '加密库·前缀·开启',
      model: 'agent:prov-b:model-b',
      params: '{"top_p":0.9}',
      status: 'done',
      created_at: 1_700_000_200_002,
      updated_at: 1_700_000_200_102,
      pinned: 1,
      archived: 0,
      archived_at: null,
      title_default: 1,
      group_id: 'grp-enc',
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: 'reviewer',
      agent_mode: 1
    },
    {
      id: 'enc-v59-c',
      assistant_id: null,
      title: '加密库·正常·关闭',
      model: 'prov-c:model-c',
      params: null,
      status: 'idle',
      created_at: 1_700_000_200_003,
      updated_at: 1_700_000_200_103,
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
      id: 'enc-v59-d',
      assistant_id: null,
      title: '加密库·正常·开启',
      model: 'prov-d:model-d',
      params: null,
      status: 'streaming',
      created_at: 1_700_000_200_004,
      updated_at: 1_700_000_200_104,
      pinned: 0,
      archived: 1,
      archived_at: 1_700_000_200_204,
      title_default: 0,
      group_id: null,
      note: null,
      system_prompt_override: null,
      parent_conversation_id: null,
      role_key: null,
      agent_mode: 1
    },
    {
      id: 'enc-v59-e',
      assistant_id: null,
      title: '加密库·空模型',
      model: null,
      params: null,
      status: 'idle',
      created_at: 1_700_000_200_005,
      updated_at: 1_700_000_200_105,
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
      id: 'enc-v59-f',
      assistant_id: null,
      title: '加密库·只有前缀',
      model: 'agent:',
      params: null,
      status: 'idle',
      created_at: 1_700_000_200_006,
      updated_at: 1_700_000_200_106,
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
    }
  ]
}

const EXPECTED: Record<string, { model: Cell; agent_mode: Cell }> = {
  'enc-v59-a': { model: 'prov-a:model-a', agent_mode: 1 },
  'enc-v59-b': { model: 'prov-b:model-b', agent_mode: 1 },
  'enc-v59-c': { model: 'prov-c:model-c', agent_mode: 0 },
  'enc-v59-d': { model: 'prov-d:model-d', agent_mode: 1 },
  'enc-v59-e': { model: null, agent_mode: 0 },
  'enc-v59-f': { model: 'agent:', agent_mode: 0 }
}

let SEED: Row[] = []

function insertRows(rows: Row[]): void {
  const sql = `INSERT INTO conversations (${ALL_COLS.join(', ')})
               VALUES (${ALL_COLS.map(() => '?').join(', ')})`
  const insert = db().prepare(sql)
  for (const r of rows) insert.run(...ALL_COLS.map((c) => r[c]))
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  // 与产品 db 模式一致：先解锁派生库密钥，再以该密钥打开加密库
  masterKeyManager.init('db')
  DB_KEY = masterKeyManager.setKey('v59-encrypted-upgrade-test-pass')
  dbService.open(DB_KEY)
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

describe('v59 加密库升级（前缀回填 + 能力位置位）', () => {
  it('加密库 + v58 形状：文件头非明文、前缀行与两组 agent_mode 都在', () => {
    const head = fs.readFileSync(P.db).subarray(0, 16).toString('latin1')
    expect(head).not.toBe('SQLite format 3\u0000')
    expect(journalMode()).toBe('wal')

    db().prepare('DELETE FROM schema_migrations WHERE version=59').run()
    insertRows(SEED)

    const rows = selectAll()
    expect(rows).toHaveLength(SEED.length)
    expect(rows.filter((r) => (r.model as string | null)?.startsWith('agent:')).length).toBe(3)
    expect(rows.filter((r) => r.agent_mode === 0)).toHaveLength(4)
    expect(rows.filter((r) => r.agent_mode === 1)).toHaveLength(2)
    expect(integrity()).toEqual(['ok'])
  })

  it('加密库上回填成功：前缀剥掉、位脸正确、行不丢不重、其余列逐字节不变', () => {
    const before = selectAll()
    const beforeUntouched = selectUntouched()

    expect(() => dbService.runMigrations()).not.toThrow()

    const after = selectAll()
    expect(after).toHaveLength(before.length)
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))

    for (const r of after) {
      const exp = EXPECTED[r.id as string]!
      expect(r.model, `${r.id}.model 迁移结果不对`).toBe(exp.model)
      expect(r.agent_mode, `${r.id}.agent_mode 迁移结果不对`).toBe(exp.agent_mode)
    }

    expect(selectUntouched()).toEqual(beforeUntouched)
    expect(integrity()).toEqual(['ok'])
    expect(versionName(59)).toBe('strip_agent_model_label')
    expect(LATEST_SCHEMA_VERSION).toBe(59)
  })

  it('加密库上重复跑迁移不抛且空操作', () => {
    const before = selectAll()
    db().prepare('DELETE FROM schema_migrations WHERE version=59').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(selectAll()).toEqual(before)
    expect(versionName(59)).toBe('strip_agent_model_label')
    expect(integrity()).toEqual(['ok'])
  })

  it('加密库上启动幂等修复：空操作 → 自愈残留 → 再空操作', () => {
    expect(dbService.repairLegacyAgentLabels()).toBe(0)
    expect(dbService.repairLegacyAgentLabels()).toBe(0)

    db()
      .prepare(
        `INSERT INTO conversations (id, assistant_id, title, model, status, created_at, updated_at, title_default, agent_mode)
         VALUES ('enc-v59-residual', NULL, '加密库·降级残留', 'agent:prov-r:model-r', 'idle', ?, ?, 0, 0)`
      )
      .run(1_700_000_200_009, 1_700_000_200_109)

    expect(dbService.repairLegacyAgentLabels()).toBe(1)
    const fixed = db()
      .prepare("SELECT model, agent_mode FROM conversations WHERE id='enc-v59-residual'")
      .get() as { model: string; agent_mode: number }
    expect(fixed).toEqual({ model: 'prov-r:model-r', agent_mode: 1 })
    expect(dbService.repairLegacyAgentLabels()).toBe(0)
    expect(integrity()).toEqual(['ok'])
  })
})
