// P1-5 真库：流程模板表（v74）+ 从成功 run 生成 + 启动前缺失引用清单 + 导入清空授权
//
// 钉住的语义：
//  · v74 建出 agent_runbooks（不是复用助手表/运行账本）；
//  · 只有成功结束的 run 能生成模板；失败 run 抛错而不是给半份数据；
//  · 模板从 trace 里取工具序列与参数键名，提示词摘要取本次 run 的用户消息；
//  · 引用按原样存下来，跨机失效时 checkRunbookRefs 能逐条列出来；
//  · 导入链路（resolve → insert → get）后授权恒为空。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-runbooks'
  return { dir, db: dir + sep + 'app.db', workspace: dir + sep + 'ws' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { runbookRepo } from '../src/main/db/repositories/runbook.repo'
import {
  checkRunbookRefs,
  createRunbookFromConversation,
  createRunbookFromRun
} from '../src/main/runbooks/runbook-service'
import { resolveRunbookImportItem } from '../src/shared/runbook'

const CONV = 'conv-rb-1'
const REQ = 'req-rb-1'
const ANCHOR = 'msg-rb-anchor'

function seedConversation(): void {
  const db = dbService.getHandle()
  const now = Date.now()
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    CONV,
    '巡检会话',
    now,
    now
  )
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ANCHOR, CONV, 'user', '检查昨天的构建日志并汇总失败项', 'done', now)
}

function seedRun(status: 'done' | 'aborted', requestId = REQ): void {
  const db = dbService.getHandle()
  const now = Date.now()
  db.prepare(
    `INSERT INTO conversation_runs
       (request_id, conversation_id, mode, status, started_at, ended_at, anchor_user_message_id, workspace_dir)
     VALUES (?, ?, 'agent', ?, ?, ?, ?, ?)`
  ).run(requestId, CONV, status, now, now + 1000, ANCHOR, P.workspace)
  db.prepare(
    `INSERT INTO agent_traces
       (id, request_id, conversation_id, step_index, step_type, tool_name, status, tool_args, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`${requestId}-llm`, requestId, CONV, 0, 'llm', null, 'success', null, now)
  db.prepare(
    `INSERT INTO agent_traces
       (id, request_id, conversation_id, step_index, step_type, tool_name, status, tool_args, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `${requestId}-tools-1`,
    requestId,
    CONV,
    1,
    'tools',
    'shell_exec, kb_search',
    'success',
    'shell_exec {"command":"grep -c ERROR build.log"}\nkb_search {"query":"构建失败","topK":5}',
    now
  )
  db.prepare(
    `INSERT INTO agent_traces
       (id, request_id, conversation_id, step_index, step_type, tool_name, status, tool_args, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `${requestId}-tools-2`,
    requestId,
    CONV,
    2,
    'tools',
    'mcp_ci_fetch',
    'success',
    'mcp_ci_fetch {"jobId":"build-42"}',
    now
  )
}

describe('runbook（真库）', () => {
  beforeAll(() => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(P.workspace, { recursive: true })
    dbService.open()
    dbService.runMigrations()
  })

  afterAll(() => {
    try {
      dbService.close()
    } catch {
      /* ignore */
    }
    fs.rmSync(P.dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    const db = dbService.getHandle()
    for (const table of ['agent_runbooks', 'agent_traces', 'conversation_runs', 'messages', 'conversations', 'mcp_servers', 'skills']) {
      db.prepare(`DELETE FROM ${table}`).run()
    }
  })

  it('v74 建出 agent_runbooks', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(74)
    const tables = (
      dbService
        .getHandle()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain('agent_runbooks')
  })

  it('从成功 run 生成：工具序列、参数键名、提示词摘要、路径引用', () => {
    seedConversation()
    seedRun('done')
    const record = createRunbookFromRun(
      { requestId: REQ, name: '每日巡检' },
      {
        resolveTool: {
          toolId: (name) => (name === 'kb_search' ? 'kb.search' : null),
          mcpServerId: (name) => (name === 'mcp_ci_fetch' ? 'srv-ci' : null)
        }
      }
    )
    expect(record.name).toBe('每日巡检')
    expect(record.promptSummary).toBe('检查昨天的构建日志并汇总失败项')
    expect(record.steps.map((s) => s.toolName)).toEqual(['shell_exec', 'kb_search', 'mcp_ci_fetch'])
    expect(record.steps[0]!.argKeys).toEqual(['command'])
    expect(record.steps[1]!.toolId).toBe('kb.search')
    // 授权恒为空：模板不携带授权（SEC-3 同口径）
    expect(record.toolPermissions).toEqual([])
    // 引用：MCP Server 与本次 run 的工作目录
    expect(record.refs).toEqual(
      expect.arrayContaining([
        { kind: 'mcp', id: 'srv-ci', label: 'srv-ci' },
        { kind: 'path', id: P.workspace, label: P.workspace }
      ])
    )
    // 落库后可读回（JSON 列没有丢结构）
    expect(runbookRepo.get(record.id)).toEqual(record)
  })

  it('失败结束的 run 不能生成模板', () => {
    seedConversation()
    seedRun('aborted', 'req-rb-bad')
    expect(() => createRunbookFromRun({ requestId: 'req-rb-bad' })).toThrow(/没有成功结束/)
  })

  it('从会话沉淀：跳过最近一轮失败，取更早的合格 run', () => {
    seedConversation()
    seedRun('done')
    seedRun('aborted', 'req-rb-bad')
    const record = createRunbookFromConversation(CONV, '巡检沉淀')
    expect(record.name).toBe('巡检沉淀')
    expect(record.steps.map((s) => s.toolName)).toEqual(['shell_exec', 'kb_search', 'mcp_ci_fetch'])
    expect(runbookRepo.get(record.id)).toEqual(record)
  })

  it('启动前校验：跨机失效的引用逐条列出（路径存在则不算缺）', () => {
    seedConversation()
    seedRun('done')
    const record = createRunbookFromRun(
      { requestId: REQ },
      { resolveTool: { toolId: () => null, mcpServerId: () => 'srv-missing' } }
    )
    // 手工补一条本机不存在的技能引用（模拟从别的机器导入）
    const withSkill = runbookRepo.insert({
      name: '带技能',
      promptSummary: record.promptSummary,
      steps: record.steps,
      refs: [
        ...record.refs,
        { kind: 'skill', id: 'skill-not-here', label: '别人的技能' },
        { kind: 'knowledge_base', id: 'kb-not-here', label: '别人的知识库' }
      ],
      toolPermissions: []
    })
    const missing = checkRunbookRefs(withSkill.id)
    expect(missing.map((r) => r.label).sort()).toEqual(['srv-missing', '别人的知识库', '别人的技能'].sort())
    // 本机路径存在 ⇒ 不在缺失清单里
    expect(missing.some((r) => r.kind === 'path')).toBe(false)
  })

  it('MCP Server 在本机存在时校验通过', () => {
    const now = Date.now()
    dbService
      .getHandle()
      .prepare('INSERT INTO mcp_servers (id, name, transport, created_at) VALUES (?, ?, ?, ?)')
      .run('srv-ok', 'CI 服务', 'stdio', now)
    const record = runbookRepo.insert({
      name: '只用 MCP',
      promptSummary: '拉取构建',
      steps: [{ toolName: 'mcp_ci_fetch', toolId: 'mcp:srv-ok:fetch', argKeys: ['jobId'] }],
      refs: [{ kind: 'mcp', id: 'srv-ok', label: 'CI 服务' }]
    })
    expect(checkRunbookRefs(record.id)).toEqual([])
  })

  it('导入解析后落库：文件里的授权被清空，用户必须重勾', () => {
    const resolved = resolveRunbookImportItem({
      name: '外部流程',
      promptSummary: '来自别人的模板',
      steps: [{ toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] }],
      refs: [{ kind: 'path', id: P.workspace, label: P.workspace }],
      toolPermissions: ['*', 'shell.exec']
    })
    expect(resolved).not.toBeNull()
    const saved = runbookRepo.insert(resolved!.draft)
    const readBack = runbookRepo.get(saved.id)
    expect(readBack!.toolPermissions).toEqual([])
    expect(readBack!.name).toBe('外部流程')
  })

  it('重新勾选授权只改本机这一列', () => {
    const record = runbookRepo.insert({
      name: '待勾选',
      promptSummary: '',
      steps: [{ toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] }],
      refs: []
    })
    const updated = runbookRepo.update(record.id, { toolPermissions: ['shell.exec'] })
    expect(updated!.toolPermissions).toEqual(['shell.exec'])
    expect(runbookRepo.get(record.id)!.steps).toEqual(record.steps)
  })
})
