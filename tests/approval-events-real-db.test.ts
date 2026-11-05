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
