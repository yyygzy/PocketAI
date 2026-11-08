// P2（V4-Iter-459）：`agentTraceRepo.listRuns` 的真库用例。
//
// 为什么必须用真库：这条只读查询的价值全在「`agent_traces` 的真实形状 + 真实迁移链」上——
// 聚合口径（主干步数/耗时、token 含子 run、message_id 多值列、change_set 三态）只要有一处
// 用内存假数据替代，就会把「按 request_id 分组」的真实 SQL 行为测丢。因此照 v59 那套做法：
// 真 `dbService.open()` + 真 `runMigrations()` + 真 `agentTraceRepo`。
//
// 验收点（对应台账 V4-Iter-459 的第 1、4 条）：
// · 50 个 Agent 轮次的长会话：全部列出、顺序正确、limit 生效、总数/步数/耗时/token 对得上；
// · 子 run：token 计入父 run、步数/耗时不计入、childRuns 只在 >0 时给；
//   子会话 id 同时从子 trace 行聚合出来（检查器的「进子会话」入口）；
// · message_id 多值（换行分隔）拆开去重；change_set 只认 status='ok'（NULL/degraded ≠ 无变更）；
// · 读取耗时留一条宽松上限（1000 行真库查询，不做 N+1）。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-agent-list-runs-459'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'

function db() {
  return dbService.getHandle()
}

const CONV = 'conv-459-parent'
const CHILD_CONV = 'conv-459-child'

/** 50 轮 × 4 步；第 i 轮的首条 trace 时间依次递增，便于断言顺序 */
function seedMainRuns(): void {
  const insert = db().prepare(
    `INSERT INTO agent_traces
       (id, request_id, conversation_id, step_index, step_type, duration_ms, token_usage, status,
        error, message_id, change_set, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (let run = 1; run <= 50; run += 1) {
    const requestId = `run-${String(run).padStart(2, '0')}`
    for (let step = 1; step <= 4; step += 1) {
      const error = run === 7 && step === 3 ? '工具失败' : null
      insert.run(
        `${requestId}-s${step}`,
        requestId,
        CONV,
        step,
        step === 4 ? 'final' : 'llm',
        100,
        run, // 每步 token = 轮次号，便于断言 SUM
        error ? 'error' : 'success',
        error,
        null,
        null,
        run * 10_000 + step // 同一轮内递增，跨轮严格递增
      )
    }
  }
  // message_id 多值一列（换行分隔）：run-50 第 1 步留了两条回放引用
  db().prepare(
    `UPDATE agent_traces SET message_id = ? WHERE id = 'run-50-s1'`
  ).run('msg-50-a\nmsg-50-b')
  // 重复引用（另一行也指向 msg-50-a）：去重后仍只算一次
  db().prepare(`UPDATE agent_traces SET message_id = 'msg-50-a' WHERE id = 'run-50-s2'`).run()
  // change_set：run-03 记了一份 ok（2 增 1 改 = 3 条）；run-02 是 degraded（不该算）
  db().prepare(`UPDATE agent_traces SET change_set = ? WHERE id = 'run-03-s2'`).run(
    JSON.stringify({ status: 'ok', entries: [], counts: { added: 2, modified: 1, deleted: 0 } })
  )
  db().prepare(`UPDATE agent_traces SET change_set = ? WHERE id = 'run-02-s2'`).run(
    JSON.stringify({ status: 'degraded', entries: [], counts: { added: 9, modified: 0, deleted: 0 } })
  )
}

/** run-50 挂一趟子运行：2 步 × 5 token；它的会话不是父会话，只能靠 parent_request_id 归回 */
function seedChildRun(): void {
  const insert = db().prepare(
    `INSERT INTO agent_traces
       (id, request_id, conversation_id, parent_request_id, step_index, step_type, duration_ms,
        token_usage, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (let step = 1; step <= 2; step += 1) {
    insert.run(
      `child-50-s${step}`,
      'child-run-50',
      CHILD_CONV,
      'run-50',
      step,
      'llm',
      500, // 子 run 耗时不计入父 run
      5,
      'success',
      500_000 + step
    )
  }
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  db()
    .prepare(
      `INSERT INTO conversations (id, assistant_id, title, model, status, created_at, updated_at, title_default, agent_mode)
       VALUES (?, NULL, '长会话', 'prov:model', 'done', 1, 2, 0, 1)`
    )
    .run(CONV)
  db()
    .prepare(
      `INSERT INTO conversations (id, assistant_id, title, model, status, created_at, updated_at, title_default, agent_mode, parent_conversation_id)
       VALUES (?, NULL, '子会话', 'prov:model', 'done', 1, 2, 0, 1, ?)`
    )
    .run(CHILD_CONV, CONV)
  seedMainRuns()
  seedChildRun()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 关不掉的结论不掩盖 */
  }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch {
    /* 临时目录兜底 */
  }
})

describe('agentTraceRepo.listRuns（P2 只读 run 索引）', () => {
  it('50 轮长会话：全部列出、最新在前、步数/耗时/token 逐轮自洽', () => {
    const runs = agentTraceRepo.listRuns(CONV)
    expect(runs).toHaveLength(50)
    expect(runs[0]!.requestId).toBe('run-50')
    expect(runs[49]!.requestId).toBe('run-01')
    for (const run of runs) {
      expect(run.conversationId).toBe(CONV)
      expect(run.stepCount).toBe(4)
      expect(run.totalDurationMs).toBe(400)
    }
    // run-01..run-49 没有子 run：token = 4 步 × 轮次号
    const run49 = runs.find((r) => r.requestId === 'run-49')!
    expect(run49.totalTokens).toBe(4 * 49)
    expect(run49.childRuns).toBeUndefined()
  })

  it('子 run：token 计入父 run、步数/耗时不计入、childRuns=1，且给出子会话入口', () => {
    const runs = agentTraceRepo.listRuns(CONV)
    const run50 = runs.find((r) => r.requestId === 'run-50')!
    expect(run50.stepCount).toBe(4)
    expect(run50.totalDurationMs).toBe(400)
    expect(run50.totalTokens).toBe(4 * 50 + 2 * 5)
    expect(run50.childRuns).toBe(1)
    // P2 余下四块：检查器要能从轮次里的子 run 进对应子会话，子会话 id 来自子 run 的 trace 行
    expect(run50.childConversationIds).toEqual([CHILD_CONV])
    const run49 = runs.find((r) => r.requestId === 'run-49')!
    expect(run49.childConversationIds).toBeUndefined()
    // 子会话自己读时是「它自己的 run」，parent_request_id 不参与归属
    const childRuns = agentTraceRepo.listRuns(CHILD_CONV)
    expect(childRuns).toHaveLength(1)
    expect(childRuns[0]!.requestId).toBe('child-run-50')
    expect(childRuns[0]!.conversationId).toBe(CHILD_CONV)
    expect(childRuns[0]!.stepCount).toBe(2)
    expect(childRuns[0]!.totalTokens).toBe(10)
    expect(childRuns[0]!.childConversationIds).toBeUndefined()
  })

  it('message_id 多值拆分去重；change_set 只认 ok，NULL/degraded 不写 0', () => {
    const runs = agentTraceRepo.listRuns(CONV)
    const run50 = runs.find((r) => r.requestId === 'run-50')!
    expect(run50.messageIds).toEqual(['msg-50-a', 'msg-50-b'])
    const run03 = runs.find((r) => r.requestId === 'run-03')!
    expect(run03.changeCount).toBe(3)
    const run02 = runs.find((r) => r.requestId === 'run-02')!
    expect(run02.changeCount).toBeUndefined()
    // error 步数只算主干：run-07 第 3 步失败
    const run07 = runs.find((r) => r.requestId === 'run-07')!
    expect(run07.errorSteps).toBe(1)
    expect(runs.find((r) => r.requestId === 'run-01')!.errorSteps).toBe(0)
  })

  it('limit：只取最新 N 轮，不把 50 轮全扫给渲染层', () => {
    const runs = agentTraceRepo.listRuns(CONV, 3)
    expect(runs.map((r) => r.requestId)).toEqual(['run-50', 'run-49', 'run-48'])
    expect(agentTraceRepo.listRuns(CONV, 0)).toHaveLength(1)
  })

  it('性能：1000 行真库聚合不是 N+1，留一条宽松上限', () => {
    const start = performance.now()
    for (let i = 0; i < 10; i += 1) agentTraceRepo.listRuns(CONV)
    const elapsed = (performance.now() - start) / 10
    // 本机 1000 行 × 10 次远低于 100ms；200ms 是给 CI 噪声的余量，不是性能目标
    expect(elapsed).toBeLessThan(200)
  })

  it('读不到会话：返回空数组（不是失败信封）', () => {
    expect(agentTraceRepo.listRuns('conv-not-exist')).toEqual([])
  })
})
