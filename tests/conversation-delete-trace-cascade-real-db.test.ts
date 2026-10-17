// 删会话要连带分步明细（V4-Iter-166）——真库，不桩 DB
//
// 撞出方式很不体面：162 那趟 B88 自测之后我把测试会话删掉，读回来核对时发现
// 会话没了、消息没了，**`agent_traces` 那 4 行还在**，`getLatestRunTraces(已删会话 id)` 照样原样读得出来。
// `conversationRepo.delete()` 的级联清单是 messages / messages_fts / conversation_drafts / conversations，
// 表上也没有指向 conversations 的外键（`PRAGMA foreign_keys` 是开的，只是没声明）；
// 而那个方法的注释本身就是为了防"看不见却占着库"的孤儿——当时只数了子会话，没数到 trace 这一层。
//
// 三条要钉住的语义：
//  · 删父会话连带**子会话的 trace**（子树整体，不是只删根那一行）；
//  · 无关会话的 trace 一行不许动（防我把 DELETE 写成没条件的）；
//  · 两条"空会话自动清扫"路径**不碰有 trace 的会话**——它们没有 doomed 列表可级联，
//    顺手删就会又造出同一批孤儿；有编排历史的交给显式删除。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-trace-cascade'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'

const traceCount = (conversationId: string): number =>
  (dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM agent_traces WHERE conversation_id = ?').get(conversationId) as { n: number }).n

function trace(conv: string, req: string, parentReq: string | null = null): void {
  agentTraceRepo.insert({ requestId: req, conversationId: conv, parentRequestId: parentReq, stepIndex: 1, stepType: 'llm', durationMs: 10, tokenUsage: 100, status: 'success' })
}

let parent = ''
let child = ''
let other = ''

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

describe('删会话连带分步明细', () => {
  it('父 + 子会话的 trace 一起消失，无关会话的一行不动', () => {
    parent = conversationRepo.create({ title: '编排父', titleDefault: false }).id
    child = conversationRepo.create({ title: '子会话：审校', titleDefault: false, parentConversationId: parent, roleKey: 'reviewer' }).id
    other = conversationRepo.create({ title: '别人的会话', titleDefault: false }).id
    trace(parent, 'r-parent')
    trace(parent, 'r-parent')
    trace(child, 'r-child', 'r-parent')
    trace(other, 'r-other')
    expect([traceCount(parent), traceCount(child), traceCount(other)]).toEqual([2, 1, 1])

    conversationRepo.delete(parent)

    expect(conversationRepo.get(parent)).toBeNull()
    expect(conversationRepo.get(child)).toBeNull()
    expect(traceCount(parent), '删完还能从 trace 表读出已删会话的步，就是这次要修的残留').toBe(0)
    expect(traceCount(child), '子会话的 trace 也要跟着走（子树整体）').toBe(0)
    expect(traceCount(other), '无关会话的 trace 不许被牵连').toBe(1)
  })

  it('关库重开仍然没有（真落盘，不是内存态）', () => {
    dbService.close()
    dbService.open()
    expect(traceCount(parent)).toBe(0)
    expect(traceCount(child)).toBe(0)
    expect(traceCount(other)).toBe(1)
  })

  it('反向对照：会话还在时 trace 也必须在（防我把读路径一起删坏）', () => {
    expect(conversationRepo.get(other)).toBeTruthy()
    expect(agentTraceRepo.latestTracesByConversation(other).length).toBe(1)
  })
})

describe('两条"空会话自动清扫"不碰有编排历史的会话', () => {
  it('deleteIfEmpty：真空壳照删，0 消息但有 trace 的不删', () => {
    const shell = conversationRepo.create({ assistantId: null }).id // titleDefault=1、0 消息、0 草稿
    const ranThenEmptied = conversationRepo.create({ assistantId: null }).id
    trace(ranThenEmptied, 'r-empty-with-trace')

    expect(conversationRepo.deleteIfEmpty(ranThenEmptied), '有分步明细的会话不算"空壳"').toBe(false)
    expect(conversationRepo.get(ranThenEmptied)).toBeTruthy()
    expect(traceCount(ranThenEmptied)).toBe(1)

    expect(conversationRepo.deleteIfEmpty(shell)).toBe(true)
    expect(conversationRepo.get(shell)).toBeNull()
    conversationRepo.delete(ranThenEmptied) // 收尾：显式删除要连带 trace
    expect(traceCount(ranThenEmptied)).toBe(0)
  })

  it('cleanupEmptyConversations：只清真空壳，计数不含带 trace 的那条', () => {
    const shellA = conversationRepo.create({ assistantId: null }).id
    const shellB = conversationRepo.create({ assistantId: null }).id
    const withTrace = conversationRepo.create({ assistantId: null }).id
    trace(withTrace, 'r-cleanup-trace')

    const removed = conversationRepo.cleanupEmptyConversations()
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(conversationRepo.get(shellA)).toBeNull()
    expect(conversationRepo.get(shellB)).toBeNull()
    expect(conversationRepo.get(withTrace), '自动清扫没有级联可走，所以它根本不该碰这条').toBeTruthy()
    expect(traceCount(withTrace)).toBe(1)
    conversationRepo.delete(withTrace)
    expect(traceCount(withTrace)).toBe(0)
  })
})
