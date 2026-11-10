// v60 `conversation_runs` 真实库路径（B-1/B-3）：
//   · 空库直接跑到最新版 → 表/索引/迁移登记齐全；
//   · 已有数据（v59 形状：没有这张表）升级 → 只新建表，`conversations` 一行不动；
//   · 重复跑迁移（删掉 schema_migrations v60 行再跑）→ 空操作，既有 run 行不丢。
// 另用同一个真库验证运行态注册表的状态机与启动对账（interrupted）。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conversation-runs-v60'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { conversationRunRepo } from '../src/main/db/repositories/conversation-run.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import {
  markRunStarted,
  markApprovalPending,
  markApprovalSettled,
  markRunFinished,
  clearFailure,
  getRuntimeSnapshot,
  reconcileInterruptedRuns,
  resetRuntimeRegistryForTest,
  setRuntimePersistence
} from '../src/main/chat/runtime-registry'

// 注册表本身不 import 数据库（避免把 electron 拖进纯逻辑单测），落地面在这里接上
setRuntimePersistence(conversationRunRepo)

function db(): ReturnType<typeof dbService.getHandle> {
  return dbService.getHandle()
}

function tableExists(name: string): boolean {
  return !!db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function indexExists(name: string): boolean {
  return !!db().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name)
}

function runRow(requestId: string): { status: string; ended_at: number | null } | undefined {
  return db()
    .prepare('SELECT status, ended_at FROM conversation_runs WHERE request_id=?')
    .get(requestId) as { status: string; ended_at: number | null } | undefined
}

function insertConversation(id: string, title: string): void {
  db()
    .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title, 1_700_000_300_000, 1_700_000_300_000)
}

function conversationTitle(id: string): string | undefined {
  return (db().prepare('SELECT title FROM conversations WHERE id=?').get(id) as { title: string } | undefined)?.title
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  resetRuntimeRegistryForTest()
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetRuntimeRegistryForTest()
  db().prepare('DELETE FROM conversation_runs').run()
  db().prepare('DELETE FROM conversations').run()
})

describe('v60 空库升级', () => {
  it('表、索引、迁移登记齐全，且是最新版本', () => {
    expect(tableExists('conversation_runs')).toBe(true)
    expect(indexExists('idx_conversation_runs_conv')).toBe(true)
    expect(
      db().prepare('SELECT name FROM schema_migrations WHERE version=60').get()
    ).toEqual({ name: 'conversation_runs' })
    // v61（B-4 会话未读）与 v62（mcp_call_log.source）都只 ADD COLUMN，不影响本文件的 v60 表结构断言
    expect(LATEST_SCHEMA_VERSION).toBe(62)
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })
})

describe('v60 已有数据升级 + 幂等', () => {
  it('v59 形状（无此表）升级：只建表，conversations 内容不变', () => {
    insertConversation('conv-v59-a', '老会话 A')
    insertConversation('conv-v59-b', '老会话 B')
    // 回到「v59 已跑完、v60 还没跑」的形状
    db().prepare('DROP TABLE conversation_runs').run()
    db().prepare('DELETE FROM schema_migrations WHERE version=60').run()

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(tableExists('conversation_runs')).toBe(true)
    expect(conversationTitle('conv-v59-a')).toBe('老会话 A')
    expect(conversationTitle('conv-v59-b')).toBe('老会话 B')
    expect(db().prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 2 })
  })

  it('删掉 v60 登记再跑：空操作，已有 run 行不丢', () => {
    insertConversation('conv-v59-c', '老会话 C')
    conversationRunRepo.start({
      requestId: 'req-before-rerun',
      conversationId: 'conv-v59-c',
      mode: 'agent',
      startedAt: 1_700_000_300_100
    })
    db().prepare('DELETE FROM schema_migrations WHERE version=60').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(runRow('req-before-rerun')?.status).toBe('running')
    expect(db().prepare('SELECT COUNT(*) AS n FROM conversation_runs').get()).toEqual({ n: 1 })
    expect(conversationTitle('conv-v59-c')).toBe('老会话 C')
  })
})

describe('运行态注册表（真库落地）', () => {
  it('running → pending_approval → running → done，快照与库同步', () => {
    insertConversation('conv-run-a', '运行 A')
    markRunStarted({ conversationId: 'conv-run-a', requestId: 'req-a', mode: 'agent' })
    expect(getRuntimeSnapshot()).toEqual([
      expect.objectContaining({ conversationId: 'conv-run-a', requestId: 'req-a', state: 'running', mode: 'agent' })
    ])
    expect(runRow('req-a')?.status).toBe('running')

    markApprovalPending('conv-run-a', 'req-a')
    expect(getRuntimeSnapshot()[0]).toEqual(
      expect.objectContaining({ state: 'pending_approval', pendingApprovals: 1 })
    )
    expect(runRow('req-a')?.status).toBe('pending_approval')

    markApprovalSettled('conv-run-a', 'req-a')
    expect(getRuntimeSnapshot()[0]).toEqual(
      expect.objectContaining({ state: 'running', pendingApprovals: 0 })
    )
    expect(runRow('req-a')?.status).toBe('running')

    markRunFinished('conv-run-a', 'req-a', 'done')
    expect(getRuntimeSnapshot()).toEqual([])
    expect(runRow('req-a')?.status).toBe('done')
    expect(runRow('req-a')?.ended_at).toBeTypeOf('number')
  })

  it('failed 保留到用户打开会话；迟到的旧 requestId 不覆盖新登记', () => {
    insertConversation('conv-run-b', '运行 B')
    markRunStarted({ conversationId: 'conv-run-b', requestId: 'req-b1', mode: 'chat' })
    markRunFinished('conv-run-b', 'req-b1', 'failed', 'PROVIDER_DOWN')
    expect(getRuntimeSnapshot()[0]).toEqual(
      expect.objectContaining({ requestId: 'req-b1', state: 'failed', errorCode: 'PROVIDER_DOWN' })
    )

    // 新 run 覆盖失败登记（失败态允许被新运行替换）
    markRunStarted({ conversationId: 'conv-run-b', requestId: 'req-b2', mode: 'chat' })
    expect(getRuntimeSnapshot()[0]).toEqual(expect.objectContaining({ requestId: 'req-b2', state: 'running' }))
    // 旧 run 的迟到终态只落库，不动当前登记
    markRunFinished('conv-run-b', 'req-b1', 'done')
    expect(getRuntimeSnapshot()[0]).toEqual(expect.objectContaining({ requestId: 'req-b2', state: 'running' }))

    markRunFinished('conv-run-b', 'req-b2', 'failed')
    expect(clearFailure('conv-run-b')).toBe(true)
    expect(getRuntimeSnapshot()).toEqual([])
    expect(clearFailure('conv-run-b')).toBe(false)
  })

  it('启动对账：残留 running/pending_approval → interrupted，第二次为空操作', () => {
    insertConversation('conv-run-c1', '中断 1')
    insertConversation('conv-run-c2', '中断 2')
    markRunStarted({ conversationId: 'conv-run-c1', requestId: 'req-c1', mode: 'agent' })
    markRunStarted({ conversationId: 'conv-run-c2', requestId: 'req-c2', mode: 'chat' })
    markApprovalPending('conv-run-c2', 'req-c2')
    // 模拟进程重启：内存清空，库里还是 running/pending_approval
    resetRuntimeRegistryForTest()
    expect(getRuntimeSnapshot()).toEqual([])

    expect(reconcileInterruptedRuns()).toBe(2)
    expect(runRow('req-c1')?.status).toBe('interrupted')
    expect(runRow('req-c2')?.status).toBe('interrupted')
    expect(runRow('req-c2')?.ended_at).toBeTypeOf('number')
    expect(getRuntimeSnapshot().map((e) => e.state)).toEqual(['interrupted', 'interrupted'])

    expect(reconcileInterruptedRuns()).toBe(0)
    expect(clearFailure('conv-run-c1')).toBe(true)
  })

  it('删除会话时级联删除 run 行', () => {
    insertConversation('conv-run-d', '删除 D')
    markRunStarted({ conversationId: 'conv-run-d', requestId: 'req-d', mode: 'agent' })
    expect(db().prepare('SELECT COUNT(*) AS n FROM conversation_runs').get()).toEqual({ n: 1 })
    conversationRepo.delete('conv-run-d')
    expect(db().prepare('SELECT COUNT(*) AS n FROM conversation_runs').get()).toEqual({ n: 0 })
  })
})
