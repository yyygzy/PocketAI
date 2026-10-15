// 真库往返 + **升级路径**：agent_traces 的输入/输出两列（migration v46）
//
// 为什么不能只靠 agent-trace-repo.test.ts：那份用例的表结构是手抄的 fixture，
// 抄对了它就绿——迁移本身写错（版本号撞车、ALTER 漏一条）它一声不响。
// 这里跑真 `runMigrations()`，并且**先把表退回 v45 的形状、塞一行旧数据**，
// 再让迁移跑一遍，验的是"老用户升上来"这条真实路径：旧行读出来是 undefined
// 而不是崩，新行两个字段能原样读回。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-agent-trace-split'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'

/** v46 之前 agent_traces 的形状（逐字取自 migration v1/v24 的 DDL） */
const LEGACY_DDL = `
  CREATE TABLE agent_traces (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    tool_name TEXT,
    duration_ms INTEGER,
    token_usage INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  )
`

function columns(): string[] {
  return (dbService.getHandle().prepare('PRAGMA table_info(agent_traces)').all() as Array<{ name: string }>).map(
    (c) => c.name
  )
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('agent_traces 输入/输出列（v46）', () => {
  it('全新库跑完迁移后两列都在，且 schema_migrations 记了 v46', () => {
    dbService.open()
    dbService.runMigrations()
    expect(columns()).toEqual(expect.arrayContaining(['prompt_tokens', 'completion_tokens']))
    const row = dbService
      .getHandle()
      .prepare('SELECT name FROM schema_migrations WHERE version = ?')
      .get(46) as { name: string } | undefined
    expect(row?.name).toBe('agent_trace_usage_split')
    // 不再断言 LATEST_SCHEMA_VERSION == 某个号：那等于给下一次加迁移预埋一处必改测试
    //（2026-10-13 加 v47 时真的因此红过；同一条口径已写进 kb-min-score-real-db.test.ts:96）
  })

  it('新行写入后原样读回，关库重开仍在（真的落到了磁盘）', () => {
    agentTraceRepo.insert({
      requestId: 'r-new',
      conversationId: 'c1',
      stepIndex: 0,
      stepType: 'llm',
      durationMs: 6200,
      tokenUsage: 5507,
      promptTokens: 5301,
      completionTokens: 206,
      status: 'success'
    })
    dbService.close()
    dbService.open()
    const tr = agentTraceRepo.latestTracesByConversation('c1')[0]!
    expect(tr).toMatchObject({ promptTokens: 5301, completionTokens: 206, tokenUsage: 5507 })
  })

  it('升级路径：v45 形状的表 + 一行旧数据 → 迁移补列，旧行读成 undefined 而不是崩', () => {
    const db = dbService.getHandle()
    db.exec('DROP TABLE agent_traces')
    db.exec(LEGACY_DDL)
    db.exec(
      `INSERT INTO agent_traces (id, request_id, conversation_id, step_index, step_type, duration_ms, token_usage, status, created_at)
       VALUES ('legacy-1', 'r-old', 'c-legacy', 0, 'llm', 1000, 4321, 'success', 1)`
    )
    // 退回"还没跑过 v46"的状态
    // 只退回**本条被测迁移**（v46）。写成 `>= 46` 会把后面的迁移也退回未执行状态，
    // 而 ALTER TABLE ADD COLUMN 不可重入 ⇒ v47 重跑就撞 duplicate column（2026-10-13 加 min_score 时真炸过一次）。
    db.exec('DELETE FROM schema_migrations WHERE version = 46')

    dbService.runMigrations()

    expect(columns()).toEqual(expect.arrayContaining(['prompt_tokens', 'completion_tokens']))
    const legacy = agentTraceRepo.latestTracesByConversation('c-legacy')[0]!
    expect(legacy).toMatchObject({ id: 'legacy-1', tokenUsage: 4321 })
    expect(legacy.promptTokens).toBeUndefined()
    expect(legacy.completionTokens).toBeUndefined()
    // 渲染层分支依赖这条：旧行没有拆分，但合计仍可用
    expect(legacy.tokenUsage).toBeGreaterThan(0)
  })
})
