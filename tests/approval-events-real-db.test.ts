// 审批审计账本 repo + 迁移 + 会话级联删除（P0-2c-1）——真库，不桩 DB
//
// 钉住四条语义：
//  · 迁移 v53 建表可重复执行（老库升级后再跑一次不炸）；
//  · insert/count/deleteByConversation/clearAll 的读写；
//  · 上限清理按「180 天 或 10 万行」先到先算，且 repeat 调用幂等（第二次删 0 行）；
//  · 删会话级联删除审批记录（含子会话），无关会话一行不动。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import type { ApprovalEventInput } from '../src/shared/types'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-approval-events'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import {
  APPROVAL_AUDIT_MAX_PAGE,
  approvalEventRepo,
  trimToLimits,
  resetApprovalAuditStateForTest
} from '../src/main/db/repositories/approval-event.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'

const DAY = 24 * 60 * 60 * 1000

function event(conv: string, patch: Partial<ApprovalEventInput> = {}): ApprovalEventInput {
  const now = Date.now()
  return {
    requestId: patch.requestId ?? 'req-1',
    conversationId: conv,
    assistantId: null,
    stepIndex: 3,
    toolCallId: 'call-1',
    toolId: 'shell.exec',
    toolName: 'shell.exec',
    decision: 'user_approve',
    reasonCode: 'USER_APPROVE',
    scope: 'once',
    argsDigest: 'sha:abc',
    argsRedacted: '{"command":"ls"}',
    actor: 'local_user',
    requestedAt: now,
    decidedAt: now,
    ...patch
  }
}

const total = (): number =>
  (dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM approval_events').get() as { n: number }).n

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

beforeEach(() => {
  dbService.getHandle().prepare('DELETE FROM approval_events').run()
  resetApprovalAuditStateForTest()
})

describe('迁移 v53', () => {
  it('表与索引都在，且重复跑迁移不报错', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(53)
    const table = dbService
      .getHandle()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_events'")
      .get() as { name: string } | undefined
    expect(table?.name).toBe('approval_events')

    dbService.runMigrations()
    dbService.runMigrations()
    expect(total()).toBe(0)
  })
})

describe('repo 读写', () => {
  it('insert → count；decision/scope 原样落库', () => {
    expect(approvalEventRepo.insert(event('c-1'))).toBe(true)
    expect(approvalEventRepo.insert(event('c-1', { decision: 'auto_allow', scope: 'session', reasonCode: 'SESSION_ALLOW' }))).toBe(true)
    expect(approvalEventRepo.count()).toBe(2)

    const rows = dbService
      .getHandle()
      .prepare('SELECT decision, scope, reason_code FROM approval_events ORDER BY rowid')
      .all() as Array<{ decision: string; scope: string; reason_code: string | null }>
    expect(rows[0]).toEqual({ decision: 'user_approve', scope: 'once', reason_code: 'USER_APPROVE' })
    expect(rows[1]).toEqual({ decision: 'auto_allow', scope: 'session', reason_code: 'SESSION_ALLOW' })
  })

  it('按会话删除只动该会话；clearAll 返回实际删除行数', () => {
    approvalEventRepo.insert(event('c-a'))
    approvalEventRepo.insert(event('c-a'))
    approvalEventRepo.insert(event('c-b'))
    expect(approvalEventRepo.deleteByConversation('c-a')).toBe(2)
    expect(approvalEventRepo.count()).toBe(1)
    expect(approvalEventRepo.clearAll()).toBe(1)
    expect(approvalEventRepo.count()).toBe(0)
  })
})

describe('上限清理（180 天 / 10 万行，先到先算）', () => {
  it('按时间删：超过保留期的行被清掉，未超期的留着；重复调用幂等', () => {
    trimToLimits(Date.now()) // 先把 lastTrimAt 顶住，避免 insert 时的自动清理把老行直接带走
    approvalEventRepo.insert(event('c-old', { decidedAt: Date.now() - 200 * DAY }))
    approvalEventRepo.insert(event('c-new', { decidedAt: Date.now() - 10 * DAY }))

    expect(trimToLimits(Date.now(), { retentionDays: 180 })).toEqual({ byAge: 1, byRows: 0 })
    expect(total()).toBe(1)
    expect(trimToLimits(Date.now(), { retentionDays: 180 })).toEqual({ byAge: 0, byRows: 0 })
  })

  it('按行数删：只保留最新 maxRows 条，老的先走；重复调用幂等', () => {
    trimToLimits(Date.now())
    const t0 = Date.now() - 5000
    for (let i = 0; i < 5; i++) {
      approvalEventRepo.insert(event('c-rows', { requestId: `r-${i}`, decidedAt: t0 + i }))
    }
    expect(total()).toBe(5)

    expect(trimToLimits(Date.now(), { maxRows: 2 })).toEqual({ byAge: 0, byRows: 3 })
    const left = dbService
      .getHandle()
      .prepare('SELECT request_id FROM approval_events ORDER BY created_at DESC')
      .all() as Array<{ request_id: string }>
    expect(left.map((r) => r.request_id)).toEqual(['r-4', 'r-3'])
    expect(trimToLimits(Date.now(), { maxRows: 2 })).toEqual({ byAge: 0, byRows: 0 })
  })
})

describe('删会话级联删除审批记录', () => {
  it('父 + 子会话一起走，无关会话不动', () => {
    const parent = conversationRepo.create({ title: '父', titleDefault: false }).id
    const child = conversationRepo.create({ title: '子', titleDefault: false, parentConversationId: parent, roleKey: 'reviewer' }).id
    const other = conversationRepo.create({ title: '别人', titleDefault: false }).id

    approvalEventRepo.insert(event(parent, { requestId: 'r-p1' }))
    approvalEventRepo.insert(event(parent, { requestId: 'r-p2' }))
    approvalEventRepo.insert(event(child, { requestId: 'r-c1' }))
    approvalEventRepo.insert(event(other, { requestId: 'r-o1' }))

    conversationRepo.delete(parent)

    const rows = dbService
      .getHandle()
      .prepare('SELECT conversation_id FROM approval_events ORDER BY rowid')
      .all() as Array<{ conversation_id: string }>
    expect(rows.map((r) => r.conversation_id)).toEqual([other])
  })
})

// 明细屏只读分页查询（P0-2c-3）：排序 / 分页追加 / 组合筛选 / 字段白名单 / 硬上限。
// `insert()` 的 created_at 取 decidedAt，所以用例用 decidedAt 控制排序与时间范围。
describe('明细屏只读分页查询', () => {
  it('按 created_at 倒序分页：offset 追加不重不漏，多取一行判 hasMore', () => {
    const t0 = Date.now() - 60_000
    for (let i = 0; i < 5; i++) {
      approvalEventRepo.insert(event('c-page', { requestId: `r-${i}`, toolName: `tool-${i}`, decidedAt: t0 + i * 1000 }))
    }

    const p1 = approvalEventRepo.list({ offset: 0, limit: 2 })
    expect(p1.rows.map((r) => r.toolName)).toEqual(['tool-4', 'tool-3'])
    expect(p1.hasMore).toBe(true)

    const p2 = approvalEventRepo.list({ offset: 2, limit: 2 })
    expect(p2.rows.map((r) => r.toolName)).toEqual(['tool-2', 'tool-1'])
    expect(p2.hasMore).toBe(true)

    const p3 = approvalEventRepo.list({ offset: 4, limit: 2 })
    expect(p3.rows.map((r) => r.toolName)).toEqual(['tool-0'])
    expect(p3.hasMore).toBe(false)

    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)
    expect(new Set(ids).size).toBe(5)
  })

  it('会话 + 决定 + 时间范围组合同时生效', () => {
    const base = Date.now() - 100_000
    approvalEventRepo.insert(event('c-a', { requestId: 'r-a1', decision: 'user_approve', reasonCode: 'USER_APPROVE', decidedAt: base + 1000 }))
    approvalEventRepo.insert(event('c-a', { requestId: 'r-a2', decision: 'user_deny', reasonCode: 'USER_DENY', decidedAt: base + 2000 }))
    approvalEventRepo.insert(event('c-a', { requestId: 'r-a3', decision: 'user_approve', reasonCode: 'USER_APPROVE', decidedAt: base + 3000 }))
    approvalEventRepo.insert(event('c-b', { requestId: 'r-b1', decision: 'user_approve', reasonCode: 'USER_APPROVE', decidedAt: base + 2000 }))

    const rows = approvalEventRepo.list({
      offset: 0,
      limit: 10,
      conversationId: 'c-a',
      decision: 'user_approve',
      from: base + 500,
      to: base + 2500
    })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.decidedAt).toBe(base + 1000)
    expect(rows.rows[0]?.conversationId).toBe('c-a')
    expect(rows.rows[0]?.decision).toBe('user_approve')
    expect(rows.hasMore).toBe(false)
  })

  it('只返回白名单字段：没有原始参数、也没有工具结果字段', () => {
    approvalEventRepo.insert(
      event('c-fields', { argsDigest: 'sha256:abcdef1234567890', argsRedacted: '{"command":"ls"}' })
    )
    const page = approvalEventRepo.list({ offset: 0, limit: 1 })
    const row = page.rows[0]!
    expect(Object.keys(row).sort()).toEqual(
      [
        'actor',
        'argsDigest',
        'argsRedacted',
        'assistantId',
        'conversationId',
        'createdAt',
        'decidedAt',
        'decision',
        'id',
        'reasonCode',
        'requestedAt',
        'scope',
        'stepIndex',
        'toolId',
        'toolName'
      ].sort()
    )
    expect(row.argsRedacted).toBe('{"command":"ls"}')
    expect(row.argsDigest).toBe('sha256:abcdef1234567890')
  })

  it('limit 超过硬顶时按 APPROVAL_AUDIT_MAX_PAGE 截断，绝不一发拉全表', () => {
    const t0 = Date.now() - 200_000
    for (let i = 0; i < APPROVAL_AUDIT_MAX_PAGE + 5; i++) {
      approvalEventRepo.insert(event('c-cap', { requestId: `r-${i}`, decidedAt: t0 + i }))
    }
    const page = approvalEventRepo.list({ offset: 0, limit: 10_000 })
    expect(page.rows).toHaveLength(APPROVAL_AUDIT_MAX_PAGE)
    expect(page.hasMore).toBe(true)
  })
})
