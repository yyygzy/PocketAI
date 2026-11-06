// P0-3b 端到端（427）：begin → **真跑写盘命令** → finish → 合并 → 落 agent_traces → 读回 change_set
//
// 这一条补的是"只过类型检查"的证据缺口：链路里的每一环都用真实实现——
//   · 真实 shell_exec（registry.classify → registry.execute → cmd/sh 子进程，不是桩）；
//   · 真实临时工作目录（不碰本仓源码树）；
//   · 真实迁移后的 SQLite（v55 的 change_set 列）与真实 repo 读写。
// 断言的是用户看到的那份清单：新增/修改/删除三类都在，且 request_id／conversation_id 对得上。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-change-e2e-427'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data', ws: dir + sep + 'ws' }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
/** 工作目录＝临时目录；策略取默认 confirm（下面的断言同时钉住"被审计的正是 confirm 档"） */
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) =>
      key === 'agent.workspace_dir'
        ? P.ws
        : key === 'agent.shell_enabled'
          ? '1'
          : key === 'agent.shell_policy'
            ? 'confirm'
            : null,
    set: () => {},
    delete: () => {}
  }
}))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listRuntimes: () => [], callTool: async () => ({ isError: false }) }
}))

import { dbService } from '../src/main/db/database'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { toolRegistry } from '../src/main/tools/registry'
import {
  beginWorkspaceChangeAudit,
  finishWorkspaceChangeAudit,
  buildStepChangeSet
} from '../src/main/agent/workspace-changes'
import { parseWorkspaceChangeSet } from '../src/shared/workspace-changes'
import type { WorkspaceChangeSet } from '../src/shared/types'

const REQUEST_ID = 'req-change-e2e-427'
const OLD_MTIME = 1_700_000_000

let conversationId = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.ws, { recursive: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  conversationId = conversationRepo.create({ title: 'e2e-427', assistantId: 'a1' }).id
})

afterAll(() => {
  try { dbService.close() } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

/** 三个动作各用一次真实 shell 调用：新增、改大小、删除；每调用独立前后扫（与 engine 同口径） */
function writeCommands(): string[] {
  return process.platform === 'win32'
    ? ['echo new>added.txt', 'echo xxxxxx>mod.txt', 'del del.txt']
    : ['echo new > added.txt', 'echo xxxxxx > mod.txt', 'rm -f del.txt']
}

describe('begin → 真执行 → finish → 落 trace → 读回', () => {
  it('新增/修改/删除三类都在，conversation_id / request_id 对得上', async () => {
    // 基线：一个不改的文件，一个只改大小的文件，一个将被删掉的文件（mtime 固定，避免精度差异）
    for (const [rel, body] of [['keep.txt', 'kk'], ['mod.txt', 'aa'], ['del.txt', 'ddd']] as const) {
      fs.writeFileSync(path.join(P.ws, rel), body)
      fs.utimesSync(path.join(P.ws, rel), OLD_MTIME, OLD_MTIME)
    }

    const audited: WorkspaceChangeSet[] = []
    for (const command of writeCommands()) {
      const argsJson = JSON.stringify({ command })
      // 这一步钉住范围：被审计的调用正是"被判 confirm"那些
      expect(toolRegistry.classify('shell_exec', argsJson, new Set(['*'])), command)
        .toMatchObject({ decision: 'confirm' })

      const audit = beginWorkspaceChangeAudit(P.ws)!
      expect(audit).not.toBeNull()
      const result = await toolRegistry.execute('shell_exec', argsJson, new Set(['*']))
      expect(result.isError, `${command} 执行失败：${result.content}`).toBeFalsy()
      audited.push(finishWorkspaceChangeAudit(audit))
    }

    const changeSet = buildStepChangeSet(audited, false)
    expect(changeSet, '三次已批准调用全部 ok 时应有一份合并清单').toBeTruthy()
    agentTraceRepo.insert({
      requestId: REQUEST_ID,
      conversationId,
      stepIndex: 0,
      stepType: 'tools',
      status: 'success',
      toolName: 'shell_exec',
      changeSet
    })

    const rec = agentTraceRepo.listByRequest(REQUEST_ID)[0]!
    expect(rec.requestId).toBe(REQUEST_ID)
    expect(rec.conversationId).toBe(conversationId)

    const cs = parseWorkspaceChangeSet(rec.changeSet)!
    expect(cs.status).toBe('ok')
    expect(cs.counts).toEqual({ added: 1, modified: 1, deleted: 1 })

    const byPath = new Map(cs.entries.map((e) => [e.path, e]))
    expect([...byPath.keys()].sort()).toEqual(['added.txt', 'del.txt', 'mod.txt'])
    expect(byPath.get('added.txt')).toMatchObject({ kind: 'added' })
    expect(byPath.get('added.txt')!.size).toBeGreaterThan(0)
    expect(byPath.get('mod.txt')).toMatchObject({ kind: 'modified' })
    expect(byPath.get('mod.txt')!.size).toBe(fs.statSync(path.join(P.ws, 'mod.txt')).size)
    expect(byPath.get('del.txt')).toMatchObject({ kind: 'deleted', content: 'not-compared' })
    // 没动过的文件不出现在清单里
    expect(byPath.has('keep.txt')).toBe(false)
  })
})
