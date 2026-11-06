// v55（P0-3b 执行后变更清单）——真库 + 真 runMigrations()
//
// 这一批只加一列（`change_set`），风险同样全在"老库升上来"：
//  · ALTER 不可重入 → 必须退回版本号真跑一遍；
//  · 旧行必须是 NULL（＝没记录），不能是空串（空串会被解析层当成一份坏清单）；
//  · 值必须真的经 repo 落库/读回，否则"列在 schema 里、值恒 NULL"也能让测试全绿。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-v55-change-set'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'

const NEW_COL = 'change_set'

function columns(): Array<{ name: string; type: string; notnull: number; dflt_value: string | null }> {
  return dbService.getHandle().prepare('PRAGMA table_info(agent_traces)').all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
  }>
}

/** 退回 v54 形状：从 sqlite_master 的真实建表语句里摘掉 change_set，再删 v55 记录——不手抄 DDL */
function rewindToBeforeV55(): void {
  const db = dbService.getHandle()
  const rows = db.prepare('SELECT * FROM agent_traces').all() as Array<Record<string, unknown>>
  const idx = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_traces' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_traces'").get() as { sql: string }

  const re = new RegExp(`,\\s*"?${NEW_COL}"?\\s+TEXT`, 'i')
  expect(sql, `建表语句里没有 ${NEW_COL}：\n${sql}`).toMatch(re)
  const legacy = sql.replace(re, '')
  expect(legacy).not.toContain(NEW_COL)

  db.exec('DROP TABLE agent_traces')
  db.exec(legacy)
  if (rows.length > 0) {
    const kept = Object.keys(rows[0]!).filter((k) => k !== NEW_COL)
    const stmt = db.prepare(`INSERT INTO agent_traces (${kept.join(', ')}) VALUES (${kept.map(() => '?').join(', ')})`)
    for (const r of rows) stmt.run(...kept.map((k) => r[k] as string | number | null))
  }
  for (const i of idx) db.exec(i.sql)
  db.exec('DELETE FROM schema_migrations WHERE version = 55')
}

let CONV = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  CONV = conversationRepo.create({ title: 'v55', assistantId: 'a1' }).id
})

afterAll(() => {
  try { dbService.close() } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('v55 结构', () => {
  it('全新库：change_set 是可空 TEXT、无默认值', () => {
    const col = columns().find((c) => c.name === NEW_COL)!
    expect(col).toBeTruthy()
    expect(col.type).toBe('TEXT')
    // 旧行必须是 NULL，不能给默认值（"" 与 NULL 语义不同）
    expect(col.notnull).toBe(0)
    expect(col.dflt_value).toBeNull()
    const m = dbService.getHandle()
      .prepare('SELECT name FROM schema_migrations WHERE version = 55')
      .get() as { name: string } | undefined
    expect(m?.name).toBe('agent_trace_change_set')
  })

  it('升级路径：退回 v54 + 塞旧行 ⇒ 迁移补列，旧行 change_set 读成 undefined 且原数据不丢', () => {
    const legacy = agentTraceRepo.insert({
      requestId: 'r-legacy-55',
      conversationId: CONV,
      stepIndex: 0,
      stepType: 'tools',
      status: 'success',
      toolName: 'shell_exec'
    })

    rewindToBeforeV55()
    expect(columns().some((c) => c.name === NEW_COL)).toBe(false)

    dbService.runMigrations()
    expect(columns().some((c) => c.name === NEW_COL)).toBe(true)

    const rows = dbService.getHandle()
      .prepare('SELECT request_id, conversation_id, tool_name, change_set FROM agent_traces WHERE request_id = ?')
      .all('r-legacy-55') as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conversation_id).toBe(CONV)
    expect(rows[0]!.tool_name).toBe('shell_exec')
    expect(rows[0]!.change_set).toBeNull()

    const rec = agentTraceRepo.listByRequest('r-legacy-55')[0]!
    expect(rec.changeSet).toBeUndefined()
    expect(rec.toolName).toBe('shell_exec')
    expect(rec.id).toBe(legacy.id)
  })

  it('幂等：再跑一次 runMigrations 不报错、不重复加列', () => {
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(columns().filter((c) => c.name === NEW_COL)).toHaveLength(1)
  })

  it('真值落库/读回：change_set 能按 request_id / conversation_id 对上', () => {
    const payload = JSON.stringify({
      status: 'ok',
      entries: [{ path: 'src/a.ts', kind: 'modified', size: 12, content: 'hashed', afterSha: 'f'.repeat(64) }],
      counts: { added: 0, modified: 1, deleted: 0 },
      scanMs: 7
    })
    agentTraceRepo.insert({
      requestId: 'r-change-set-55',
      conversationId: CONV,
      stepIndex: 2,
      stepType: 'tools',
      status: 'success',
      toolName: 'shell_exec',
      changeSet: payload
    })
    const rec = agentTraceRepo.listByRequest('r-change-set-55')[0]!
    expect(rec.conversationId).toBe(CONV)
    expect(rec.changeSet).toBe(payload)
  })
})
