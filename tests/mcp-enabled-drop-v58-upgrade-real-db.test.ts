// v58 真实升级路径：v57 老库（带 enabled 列）→ v58（删列）。
//
// 已有的 mcp-enabled-column-drop-v58-real-db.test.ts 验的是"新建库跑全链"；
// 这一份专门模拟用户从 v57 升上来的库：先跑全链，再把 v58 的产物还原成 v57 形状
// （DELETE schema_migrations v58 + ADD COLUMN enabled 回来），因为 MIGRATIONS 数组未导出，
// 无法在 v57 原地停住；v58 唯一作用就是删这一列，所以还原列即等价于 v57 schema。
//
// 判据：行不丢/不重、12 列值逐字节不变（env/headers 是真实字段密文）、
// enabled=0 与 1 两组除少一列外无差别、版本号落库、列不存在、重跑不抛、
// 迁移前后全库 integrity_check、mcp_call_log 里指向这些 server 的记录不受影响。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-v58-upgrade'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { masterKeyManager } from '../src/main/crypto/master-key'
import { encryptSecretMap, isCipherText } from '../src/main/crypto/field-encrypt'

/** v57 的 mcp_servers 列（enabled 之外的全部业务列），顺序与 v4 DDL 一致 */
const VALUE_COLS = [
  'id',
  'name',
  'transport',
  'runtime',
  'command',
  'args',
  'env',
  'url',
  'created_at',
  'python_packages',
  'headers',
  'trust_read_only'
] as const

type Cell = string | number | null
type Row = Record<(typeof VALUE_COLS)[number], Cell>
type SeedRow = Row & { enabled: number }

function colsOf(table: string): string[] {
  return (
    dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name)
}

function selectRows(): Row[] {
  return dbService
    .getHandle()
    .prepare(`SELECT ${VALUE_COLS.join(', ')} FROM mcp_servers ORDER BY id`)
    .all() as Row[]
}

function selectRowsWithEnabled(): SeedRow[] {
  return dbService
    .getHandle()
    .prepare(`SELECT ${VALUE_COLS.join(', ')}, enabled FROM mcp_servers ORDER BY id`)
    .all() as SeedRow[]
}

function selectLogs(): Array<Record<string, Cell>> {
  return dbService
    .getHandle()
    .prepare('SELECT * FROM mcp_call_log ORDER BY id')
    .all() as Array<Record<string, Cell>>
}

function integrity(): string[] {
  const rows = dbService.getHandle().prepare('PRAGMA integrity_check').all() as Array<{
    integrity_check: string
  }>
  return rows.map((r) => r.integrity_check)
}

function versionName(version: number): string | undefined {
  return (
    dbService
      .getHandle()
      .prepare('SELECT name FROM schema_migrations WHERE version=?')
      .get(version) as { name: string } | undefined
  )?.name
}

/** 去掉 enabled 的那 12 列，用于逐字段比较 */
function valueOf(row: SeedRow | Row): Row {
  const out: Partial<Row> = {}
  for (const c of VALUE_COLS) out[c] = row[c]
  return out as Row
}

/** 有 enabled 列的 v57 形状快照；env/headers 用真实字段密文，不是明文 JSON。
 *  必须在 dbService.open() 之后再调用：字段密钥此时才可用。 */
function seedRows(): SeedRow[] {
  const rows: SeedRow[] = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'stdio-off',
      transport: 'stdio',
      runtime: 'binary',
      command: 'npx',
      args: '["-y","pkg-one","--flag","a b"]',
      env: encryptSecretMap({ API_KEY: 'sk-v57-off-1' }),
      url: null,
      created_at: 1_700_000_000_001,
      python_packages: '[]',
      headers: null,
      trust_read_only: 0,
      enabled: 0
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'stdio-on',
      transport: 'stdio',
      runtime: 'python',
      command: 'python',
      args: '[]',
      env: encryptSecretMap({ TOKEN: 'tok-v57-on-2' }),
      url: null,
      created_at: 1_700_000_000_002,
      python_packages: '["requests","numpy"]',
      headers: null,
      trust_read_only: 1,
      enabled: 1
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'http-off',
      transport: 'http',
      runtime: 'binary',
      command: null,
      args: null,
      env: null,
      url: 'https://off.example.com/mcp',
      created_at: 1_700_000_000_003,
      python_packages: '[]',
      headers: encryptSecretMap({ Authorization: 'Bearer v57-off-3' }),
      trust_read_only: 0,
      enabled: 0
    },
    {
      id: '00000000-0000-4000-8000-000000000004',
      name: 'http-on',
      transport: 'http',
      runtime: 'binary',
      command: null,
      args: null,
      env: encryptSecretMap({ QUERY_KEY: 'q-v57-on-4' }),
      url: 'https://on.example.com/mcp',
      created_at: 1_700_000_000_004,
      python_packages: '[]',
      headers: encryptSecretMap({ 'X-Api-Key': 'k-v57-on-4' }),
      trust_read_only: 1,
      enabled: 1
    },
    {
      id: '00000000-0000-4000-8000-000000000005',
      name: 'MCP 旧服务（离线）',
      transport: 'stdio',
      runtime: 'binary',
      command: 'node',
      args: '["server.js"]',
      env: encryptSecretMap({ PASS: 'p-v57-off-5' }),
      url: null,
      created_at: 1_700_000_000_005,
      python_packages: '[]',
      headers: null,
      trust_read_only: 0,
      enabled: 0
    },
    {
      id: '00000000-0000-4000-8000-000000000006',
      name: '空凭据-on',
      transport: 'stdio',
      runtime: 'binary',
      command: 'uvx',
      args: '["tool"]',
      env: '',
      url: null,
      created_at: 1_700_000_000_006,
      python_packages: '[]',
      headers: null,
      trust_read_only: 1,
      enabled: 1
    }
  ]
  return rows
}

let SEED: SeedRow[] = []

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  // 与产品启动顺序一致：先按 none 模式装上固定字段密钥，再开库；否则 seedRows 造不出真密文
  masterKeyManager.init('none')
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

describe('v57 → v58 真实升级（带 enabled 列的老库）', () => {
  it('造出 v57 形状并落真实数据；两组 enabled 都有行', () => {
    const db = dbService.getHandle()
    expect(colsOf('mcp_servers')).not.toContain('enabled')
    db.exec('ALTER TABLE mcp_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
    expect(colsOf('mcp_servers').slice(-1)).toEqual(['enabled'])

    const insert = db.prepare(
      `INSERT INTO mcp_servers
       (${VALUE_COLS.join(', ')}, enabled)
       VALUES (${VALUE_COLS.map(() => '?').join(', ')}, ?)`
    )
    for (const r of SEED) {
      insert.run(...VALUE_COLS.map((c) => r[c]), r.enabled)
    }
    const logs = db.prepare(
      `INSERT INTO mcp_call_log (server_id, tool, ok, duration_ms, args_preview, result_preview, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const serverId of [SEED[2]!.id, SEED[4]!.id]) {
      for (let i = 0; i < 3; i++) {
        logs.run(
          serverId,
          `tool-${i}`,
          i % 2,
          10 + i,
          '{"q":1}',
          '{"ok":true}',
          null,
          1_700_000_001_000 + i
        )
      }
    }

    const rows = selectRowsWithEnabled()
    expect(rows).toHaveLength(SEED.length)
    expect(rows.filter((r) => r.enabled === 0)).toHaveLength(3)
    expect(rows.filter((r) => r.enabled === 1)).toHaveLength(3)
    let cipherCells = 0
    for (const r of rows) {
      for (const c of ['env', 'headers'] as const) {
        if (r[c]) {
          expect(isCipherText(r[c] as string), `${r.id}.${c} 应是字段密文`).toBe(true)
          cipherCells++
        }
      }
    }
    expect(cipherCells).toBeGreaterThan(0)
    expect(integrity()).toEqual(['ok'])
  })

  it('跑 v58 后：行不丢不重，12 列逐字段/逐字节不变，两组 enabled 只少一列', () => {
    const db = dbService.getHandle()
    const before = selectRowsWithEnabled()
    const beforeLogs = selectLogs()

    db.prepare('DELETE FROM schema_migrations WHERE version=58').run()
    expect(() => dbService.runMigrations()).not.toThrow()

    const after = selectRows()
    expect(after).toHaveLength(before.length)
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))

    const beforeById = new Map(before.map((r) => [r.id, r]))
    for (const r of after) {
      const old = beforeById.get(r.id)!
      expect(r, `行 ${r.id} 的 12 列被迁移改动`).toEqual(valueOf(old))
    }
    // enabled=0 / =1 两组分别比：除少一列外没有差别，也没有被顺手删/去重
    for (const flag of [0, 1]) {
      const oldGroup = before.filter((r) => r.enabled === flag)
      expect(oldGroup.length).toBeGreaterThan(0)
      for (const old of oldGroup) {
        const now = after.find((r) => r.id === old.id)!
        expect(now, `enabled=${flag} 的 ${old.id} 被改动`).toEqual(valueOf(old))
      }
    }
    // env/headers 是密文文本，按原字节再显式对一遍
    for (const old of before) {
      const now = after.find((r) => r.id === old.id)!
      expect(now.env, `${old.id}.env 密文字节变了`).toBe(old.env)
      expect(now.headers, `${old.id}.headers 密文字节变了`).toBe(old.headers)
    }

    expect(selectLogs()).toEqual(beforeLogs)
    expect(integrity()).toEqual(['ok'])
    expect(colsOf('mcp_servers')).not.toContain('enabled')
    expect(versionName(58)).toBe('drop_mcp_servers_enabled')
  })

  it('mcp_call_log 里指向这些 server 的记录仍在、按 server_id 仍查得到', () => {
    const db = dbService.getHandle()
    const byServer = db
      .prepare('SELECT server_id, COUNT(*) AS n FROM mcp_call_log GROUP BY server_id ORDER BY server_id')
      .all() as Array<{ server_id: string; n: number }>
    expect(byServer).toEqual([
      { server_id: SEED[2]!.id, n: 3 },
      { server_id: SEED[4]!.id, n: 3 }
    ])
    const samples = db
      .prepare('SELECT tool, ok, duration_ms FROM mcp_call_log WHERE server_id=? ORDER BY id')
      .all(SEED[4]!.id) as Array<{ tool: string; ok: number; duration_ms: number }>
    expect(samples).toEqual([
      { tool: 'tool-0', ok: 0, duration_ms: 10 },
      { tool: 'tool-1', ok: 1, duration_ms: 11 },
      { tool: 'tool-2', ok: 0, duration_ms: 12 }
    ])
  })

  it('重复跑不抛：守卫挡住第二次 DROP COLUMN', () => {
    const db = dbService.getHandle()
    const before = selectRows()
    db.prepare('DELETE FROM schema_migrations WHERE version=58').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(colsOf('mcp_servers')).not.toContain('enabled')
    expect(versionName(58)).toBe('drop_mcp_servers_enabled')
    expect(selectRows()).toEqual(before)
    expect(integrity()).toEqual(['ok'])
  })
})
