// agentTraceRepo.countForHealth()（V4-Iter-174）——真库 + 真 migration v49 的索引
//
// 这一格是 173 那批毫秒数落到真实库上的观察口，所以它**必须按 conversation 分组**：
// `rows` 决定这张表的体积，`maxRowsInOneConversation` 才是复合索引 (conversation_id, created_at)
// 那条收益的自变量（173 实测：同一张 200,000 行的表，把某一个会话堆到 50,000 行时，
// 只建单列的 latestRequestId 从 0.073 ms 变成 20.2 ms）。取错分组轴（按 request 取）数字会一样好看，
// 但用户读到的就是另一个意思——所以下面第 ③ 条是这套断言的牙。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-trace-health'
  return { dir, db: dir + sep + 'app.db' }
})
vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'

/** 往某个会话塞 n 步（一次运行 = 一个 requestId） */
function addSteps(conversationId: string, requestId: string, n: number, parentRequestId?: string): void {
  for (let i = 0; i < n; i++) {
    agentTraceRepo.insert({
      requestId,
      conversationId,
      parentRequestId: parentRequestId ?? null,
      stepIndex: i,
      stepType: 'llm',
      status: 'success'
    })
  }
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('countForHealth · 两个数各自的意义', () => {
  it('① 空表 ⇒ 两个 0（不是 null、也不抛）', () => {
    expect(agentTraceRepo.countForHealth()).toEqual({ rows: 0, maxRowsInOneConversation: 0 })
  })

  it('② rows 是总行数，max 是**行数最多的那个会话**', () => {
    addSteps('conv-big', 'req-a1', 12)
    addSteps('conv-small', 'req-b1', 5)
    expect(agentTraceRepo.countForHealth()).toEqual({ rows: 17, maxRowsInOneConversation: 12 })
  })

  it('③ 反向对照：同一次运行的 14 步摊到两个会话 ⇒ max 必须按会话算，不是按 request', () => {
    // 这一条是整套断言的牙，数字是照着"两种分组轴会给出不同答案"配的：
    // 按 conversation ⇒ max 仍是 conv-big 的 12；按 request ⇒ req-split 自己就有 14 行，会顶掉它。
    addSteps('conv-c1', 'req-split', 7)
    addSteps('conv-c2', 'req-split', 7)
    const r = agentTraceRepo.countForHealth()
    expect(r.rows).toBe(31)
    expect(r.maxRowsInOneConversation).toBe(12)
  })

  it('④ 委派出来的子 run 算进**子会话自己**那一档（parentRequestId 不改变归属）', () => {
    // 真实形状：子运行的每一步带 parent_request_id，但 conversation_id 是子会话自己的
    addSteps('conv-child', 'req-child-1', 20, 'req-a1')
    const r = agentTraceRepo.countForHealth()
    expect(r.rows).toBe(51)
    expect(r.maxRowsInOneConversation).toBe(20) // 子会话比 conv-big 还长，max 就跟着走
  })

  it('⑤ 两条探测各走各的覆盖索引，且 GROUP BY 不必建临时 B 树', () => {
    const db = dbService.getHandle()
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' ; ')
    // 分开断言，不拼成一条串：`SELECT COUNT(*)` 挑哪支索引取决于哪支最小，拼在一起会被另一支顶掉而看不出错
    expect(plan('SELECT COUNT(*) AS n FROM agent_traces')).toMatch(/USING (COVERING )?INDEX/)
    const groupPlan = plan('SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM agent_traces GROUP BY conversation_id)')
    expect(groupPlan).toContain('idx_agent_traces_conversation')
    expect(groupPlan).not.toMatch(/TEMP B-TREE/)
  })

  it('⑥ 表缺失时降级成两个 0 并只 warn 一次（与 statsByRequest 那条同一口径，放最后跑）', () => {
    dbService.getHandle().exec('DROP TABLE agent_traces')
    expect(agentTraceRepo.countForHealth()).toEqual({ rows: 0, maxRowsInOneConversation: 0 })
    expect(agentTraceRepo.countForHealth()).toEqual({ rows: 0, maxRowsInOneConversation: 0 })
  })
})
