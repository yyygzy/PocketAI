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
import { conversationRunRepo, judgeRunResume } from '../src/main/db/repositories/conversation-run.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import {
  markRunStarted,
  markRunCheckpoint,
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

/** v66：检查点三列 + 对账判定 */
function checkpointRow(requestId: string):
  | {
      status: string
      stage: string | null
      stepsDone: number | null
      toolStepsDone: number | null
      resumeState: string | null
    }
  | undefined {
  return db()
    .prepare(
      `SELECT status, stage, steps_done AS stepsDone, tool_steps_done AS toolStepsDone,
              resume_state AS resumeState
       FROM conversation_runs WHERE request_id=?`
    )
    .get(requestId) as
    | {
        status: string
        stage: string | null
        stepsDone: number | null
        toolStepsDone: number | null
        resumeState: string | null
      }
    | undefined
}

function insertConversation(id: string, title: string): void {
  db()
    .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title, 1_700_000_300_000, 1_700_000_300_000)
}

/** v73：造锚点用户消息 + n 条已完成的助手消息（续跑判定要求产物条数与 steps_done 对齐） */
function insertAnchorWithAssistants(convId: string, userId: string, doneAssistants: number): void {
  const base = 1_700_000_500_000
  db()
    .prepare(
      'INSERT INTO messages (id, conversation_id, role, content, status, parent_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)'
    )
    .run(userId, convId, 'user', '用户消息', 'done', base)
  for (let i = 0; i < doneAssistants; i++) {
    db()
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, status, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(`${userId}-a${i}`, convId, 'assistant', '回答', 'done', userId, base + i + 1)
  }
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
  db().prepare('DELETE FROM messages').run()
})

describe('v60 空库升级', () => {
  it('表、索引、迁移登记齐全，且是最新版本', () => {
    expect(tableExists('conversation_runs')).toBe(true)
    expect(indexExists('idx_conversation_runs_conv')).toBe(true)
    expect(
      db().prepare('SELECT name FROM schema_migrations WHERE version=60').get()
    ).toEqual({ name: 'conversation_runs' })
    // v61（B-4 会话未读）与 v62（mcp_call_log.source）都只 ADD COLUMN，不影响本文件的 v60 表结构断言
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(62)
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })
})

describe('v60 已有数据升级 + 幂等', () => {
  it('v59 形状（无此表）升级：只建表，conversations 内容不变', () => {
    insertConversation('conv-v59-a', '老会话 A')
    insertConversation('conv-v59-b', '老会话 B')
    // 回到「v59 已跑完、v60 还没跑」的形状
    db().prepare('DROP TABLE conversation_runs').run()
    // v66 也依赖这张表（ADD COLUMN）：一起退回未跑，否则重建出来的新表缺检查点列
    // v73 同样在这张表上 ADD COLUMN，一起退回（顺带验证三列能被迁移补回来）
    db().prepare('DELETE FROM schema_migrations WHERE version IN (60, 66, 73)').run()

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

// v66：运行检查点（可恢复的任务状态第一层）。
// 只验证"事实 + 判定"：不自动续跑，所以这里断言的是"重启后读得出跑到哪、能不能接着跑"。
describe('v66 运行检查点', () => {
  it('迁移补四列并登记 v66；重复执行是空操作', () => {
    const cols = new Set(
      (db().prepare('PRAGMA table_info(conversation_runs)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    for (const name of ['stage', 'steps_done', 'tool_steps_done', 'resume_state']) {
      expect(cols.has(name), name).toBe(true)
    }
    expect(db().prepare('SELECT name FROM schema_migrations WHERE version=66').get()).toEqual({
      name: 'conversation_runs_checkpoint'
    })
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(66)

    // 删掉登记再跑：PRAGMA 守卫让 ADD COLUMN 不重复执行
    db().prepare('DELETE FROM schema_migrations WHERE version=66').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(checkpointRow('nope')).toBeUndefined()
  })

  it('检查点逐步落库，终态行不被后来的检查点改动', () => {
    insertConversation('conv-cp-a', '检查点 A')
    markRunStarted({ conversationId: 'conv-cp-a', requestId: 'req-cp-a', mode: 'agent' })
    expect(checkpointRow('req-cp-a')).toEqual(
      expect.objectContaining({ status: 'running', stage: 'preparing', stepsDone: 0, toolStepsDone: 0 })
    )

    markRunCheckpoint('conv-cp-a', 'req-cp-a', { stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    expect(checkpointRow('req-cp-a')).toEqual(
      expect.objectContaining({ stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    )
    expect(getRuntimeSnapshot()[0]).toEqual(expect.objectContaining({ stage: 'model', stepsDone: 1 }))

    markRunFinished('conv-cp-a', 'req-cp-a', 'done')
    markRunCheckpoint('conv-cp-a', 'req-cp-a', { stage: 'tools', stepsDone: 2, toolStepsDone: 1 })
    expect(checkpointRow('req-cp-a')).toEqual(
      expect.objectContaining({ status: 'done', stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    )
  })

  it('重启对账按检查点判定：没进过工具步=可继续，进过/停在工作里=只能重来', () => {
    insertConversation('conv-cp-b', '检查点 B')
    insertConversation('conv-cp-c', '检查点 C')
    insertConversation('conv-cp-d', '检查点 D')
    // B：只走到模型步，没碰过工具（v73：还要有锚点，且产物条数与 steps_done 对齐）
    insertAnchorWithAssistants('conv-cp-b', 'msg-cp-b', 1)
    markRunStarted({
      conversationId: 'conv-cp-b',
      requestId: 'req-cp-b',
      mode: 'agent',
      anchorUserMessageId: 'msg-cp-b'
    })
    markRunCheckpoint('conv-cp-b', 'req-cp-b', { stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    // C：进过工具步（工具可能已经改过东西）
    insertAnchorWithAssistants('conv-cp-c', 'msg-cp-c', 2)
    markRunStarted({
      conversationId: 'conv-cp-c',
      requestId: 'req-cp-c',
      mode: 'agent',
      anchorUserMessageId: 'msg-cp-c'
    })
    markRunCheckpoint('conv-cp-c', 'req-cp-c', { stage: 'model', stepsDone: 2, toolStepsDone: 1 })
    // D：停在待审批
    insertAnchorWithAssistants('conv-cp-d', 'msg-cp-d', 1)
    markRunStarted({
      conversationId: 'conv-cp-d',
      requestId: 'req-cp-d',
      mode: 'agent',
      anchorUserMessageId: 'msg-cp-d'
    })
    markRunCheckpoint('conv-cp-d', 'req-cp-d', { stage: 'tools', stepsDone: 1, toolStepsDone: 1 })
    markApprovalPending('conv-cp-d', 'req-cp-d')
    expect(checkpointRow('req-cp-d')?.stage).toBe('approval')
    // 模拟重启
    resetRuntimeRegistryForTest()

    expect(reconcileInterruptedRuns()).toBe(3)
    expect(checkpointRow('req-cp-b')).toEqual(
      expect.objectContaining({ status: 'interrupted', stage: 'model', stepsDone: 1, resumeState: 'resumable' })
    )
    expect(checkpointRow('req-cp-c')).toEqual(
      expect.objectContaining({ status: 'interrupted', stage: 'model', resumeState: 'restart' })
    )
    expect(checkpointRow('req-cp-d')).toEqual(
      expect.objectContaining({ status: 'interrupted', stage: 'approval', resumeState: 'restart' })
    )
  })

  it('v73：没有锚点、产物条数对不上、或普通对话，都不判"可继续"', () => {
    insertConversation('conv-cp-f', '检查点 F')
    // 有锚点但已落库助手条数（0）落后于 steps_done（1）：说明"模型答完了、下一步检查点没写"，不猜
    insertAnchorWithAssistants('conv-cp-f', 'msg-cp-f', 0)
    markRunStarted({
      conversationId: 'conv-cp-f',
      requestId: 'req-cp-f',
      mode: 'agent',
      anchorUserMessageId: 'msg-cp-f'
    })
    markRunCheckpoint('conv-cp-f', 'req-cp-f', { stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    // 没有锚点的 agent 行（v73 之前的老行形状）
    insertConversation('conv-cp-g', '检查点 G')
    db()
      .prepare(
        `INSERT INTO conversation_runs
           (request_id, conversation_id, mode, status, started_at, stage, steps_done, tool_steps_done)
         VALUES (?, ?, 'agent', 'running', ?, 'model', 0, 0)`
      )
      .run('req-cp-g', 'conv-cp-g', 1_700_000_600_000)
    // 普通对话：有锚点也不给续跑入口
    insertConversation('conv-cp-h', '检查点 H')
    insertAnchorWithAssistants('conv-cp-h', 'msg-cp-h', 0)
    markRunStarted({
      conversationId: 'conv-cp-h',
      requestId: 'req-cp-h',
      mode: 'chat',
      anchorUserMessageId: 'msg-cp-h'
    })
    resetRuntimeRegistryForTest()

    reconcileInterruptedRuns()
    expect(checkpointRow('req-cp-f')?.resumeState).toBe('restart')
    expect(checkpointRow('req-cp-g')?.resumeState).toBe('restart')
    expect(checkpointRow('req-cp-h')?.resumeState).toBe('restart')
  })

  it('界面上读得到判定：快照带 stage/stepsDone/resumeState，且中断不冒充正常结束', () => {
    insertConversation('conv-cp-e', '检查点 E')
    insertAnchorWithAssistants('conv-cp-e', 'msg-cp-e', 0)
    markRunStarted({
      conversationId: 'conv-cp-e',
      requestId: 'req-cp-e',
      mode: 'agent',
      anchorUserMessageId: 'msg-cp-e'
    })
    markRunCheckpoint('conv-cp-e', 'req-cp-e', { stage: 'model', stepsDone: 0, toolStepsDone: 0 })
    resetRuntimeRegistryForTest()

    reconcileInterruptedRuns()
    expect(getRuntimeSnapshot()).toEqual([
      expect.objectContaining({
        conversationId: 'conv-cp-e',
        state: 'interrupted',
        stage: 'model',
        stepsDone: 0,
        resumeState: 'resumable'
      })
    ])
    // 中断是终态：迟到的 done 不能把它改成"正常结束"
    conversationRunRepo.finish('req-cp-e', 'done')
    expect(checkpointRow('req-cp-e')?.status).toBe('interrupted')
    // 第二次对账命中 0 行，也不会重写已有判定
    expect(reconcileInterruptedRuns()).toBe(0)
    expect(checkpointRow('req-cp-e')?.resumeState).toBe('resumable')
  })

  it('老记录没有检查点：不编造阶段，按 v60 语义判"只能重来"', () => {
    insertConversation('conv-cp-old', '老运行')
    // v66 之前的写入形状：只填 v60 的列
    db()
      .prepare(
        `INSERT INTO conversation_runs (request_id, conversation_id, mode, status, started_at)
         VALUES (?, ?, 'agent', 'running', ?)`
      )
      .run('req-cp-old', 'conv-cp-old', 1_700_000_400_000)

    reconcileInterruptedRuns()
    expect(checkpointRow('req-cp-old')).toEqual({
      status: 'interrupted',
      stage: null,
      stepsDone: null,
      toolStepsDone: null,
      resumeState: 'restart'
    })
    const evt = getRuntimeSnapshot()[0]!
    expect(evt.state).toBe('interrupted')
    expect(evt.stage).toBeUndefined()
    expect(evt.stepsDone).toBeUndefined()
    expect(evt.resumeState).toBe('restart')
  })

  it('判定函数本身：没有锚点/普通对话/工具步 >0/停在工作里，都不许判"可继续"', () => {
    const agent = { mode: 'agent' as const, anchorUserMessageId: 'msg-u' }
    expect(judgeRunResume({ ...agent, stage: null, toolStepsDone: null })).toBe('restart')
    expect(judgeRunResume({ ...agent, stage: 'preparing', toolStepsDone: 0 })).toBe('resumable')
    expect(judgeRunResume({ ...agent, stage: 'model', toolStepsDone: 0 })).toBe('resumable')
    expect(judgeRunResume({ ...agent, stage: 'model', toolStepsDone: 1 })).toBe('restart')
    // v73：普通对话没有续跑入口；没有锚点或产物对不齐，也不猜
    expect(judgeRunResume({ mode: 'chat', anchorUserMessageId: 'msg-u', stage: 'model', toolStepsDone: 0 })).toBe(
      'restart'
    )
    expect(judgeRunResume({ mode: 'agent', stage: 'model', toolStepsDone: 0 })).toBe('restart')
    expect(
      judgeRunResume({ ...agent, stage: 'model', stepsDone: 1, toolStepsDone: 0, doneAssistantCount: 0 })
    ).toBe('restart')
    expect(
      judgeRunResume({ ...agent, stage: 'model', stepsDone: 1, toolStepsDone: 0, doneAssistantCount: 1 })
    ).toBe('resumable')
    expect(
      judgeRunResume({ ...agent, stage: 'model', stepsDone: 0, toolStepsDone: 0, toolMessageCount: 1 })
    ).toBe('restart')
    for (const stage of ['tools', 'approval', 'final'] as const) {
      expect(judgeRunResume({ ...agent, stage, toolStepsDone: 0 }), stage).toBe('restart')
    }
  })
})
