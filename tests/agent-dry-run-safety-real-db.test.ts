// @vitest-environment node
// P0-5 dry-run 回放：三组判据（文件树哈希 / 出口计数 / 业务表行数）真库用例
//
// 产品口径（2026-11-14 确认）：
//  · 业务表＝全表 − 显式豁免的审计/日志/成本账本（见 dry-run-safety.ts 的清单）；
//  · 文件树＝Agent 工作目录 + DATA_DIR，排除 DB 文件与 logs 目录；
//  · 出口计数＝safe-fetch 的计数，测试另注入探针证明回放链路零出口。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-dry-run-safety'
  return {
    dir,
    data: dir + sep + 'data',
    ws: dir + sep + 'workspace',
    db: dir + sep + 'data' + sep + 'app.db',
    logs: dir + sep + 'data' + sep + 'logs'
  }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  LOGS_DIR: P.logs
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { replayTraceDryRun } from '../src/main/agent/dry-run-replay'
import {
  DRY_RUN_EXEMPT_TABLES,
  captureDryRunSafetySnapshot,
  defaultDryRunSafetyOptions,
  diffDryRunSafety
} from '../src/main/agent/dry-run-safety'

let CONV = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  fs.mkdirSync(P.logs, { recursive: true })
  fs.mkdirSync(P.ws, { recursive: true })
  fs.writeFileSync(path.join(P.ws, 'notes.txt'), '回放前就在的文件')
  fs.writeFileSync(path.join(P.data, 'config.json'), '{"theme":"dark"}')
  dbService.open()
  dbService.runMigrations()

  CONV = conversationRepo.create({ title: 'dry-run', assistantId: 'a1' }).id
  const msg = messageRepo.insert({
    conversationId: CONV,
    role: 'tool',
    content: JSON.stringify({
      toolCallId: 'tc1',
      name: 'fs_read',
      arguments: '{}',
      content: '这是权威原文，比 trace 的副本长',
      isError: false
    }),
    status: 'done'
  })
  agentTraceRepo.insert({
    requestId: 'req-1',
    conversationId: CONV,
    stepIndex: 1,
    stepType: 'llm',
    status: 'success'
  })
  agentTraceRepo.insert({
    requestId: 'req-1',
    conversationId: CONV,
    stepIndex: 2,
    stepType: 'tools',
    toolName: 'fs_read',
    status: 'success',
    messageId: msg.id,
    coldRef: '@outputs/x.txt',
    resultChars: 5000,
    toolResult: '被截断的副本'
  })
})

afterAll(() => {
  try {
    dbService.close()
  } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

function defaultOpts(): ReturnType<typeof defaultDryRunSafetyOptions> {
  return defaultDryRunSafetyOptions(P.ws)
}

describe('dry-run 三组判据', () => {
  it('回放本体确实按账本重建（不是空跑），且三组全等', async () => {
    const before = captureDryRunSafetySnapshot(defaultOpts())
    const report = await replayTraceDryRun('req-1')
    const after = captureDryRunSafetySnapshot(defaultOpts())
    const diff = diffDryRunSafety(before, after)

    // 先证明回放真的读了账本：否则"三组全等"可能只是回放什么都没做
    expect(report.unavailable).toBeUndefined()
    expect(report.steps.map((s) => s.stepType)).toEqual(['llm', 'tools'])
    expect(report.steps[1]?.output?.source).toBe('messages')
    expect(report.steps[1]?.output?.calls?.[0]?.content).toBe('这是权威原文，比 trace 的副本长')
    expect(report.toolAttemptsBlocked).toBe(0)

    expect(before.fileCount).toBeGreaterThan(0)
    expect(diff.fileTreeEqual, JSON.stringify({ before: before.fileTreeHash, after: after.fileTreeHash })).toBe(true)
    expect(diff.outboundEqual).toBe(true)
    expect(diff.tableRowsEqual, JSON.stringify(diff.tableDiffs)).toBe(true)
    expect(diff.allEqual).toBe(true)

    // 业务表口径：messages 在组内；豁免表不在组内
    expect(after.tableRowCounts.messages).toBe(1)
    for (const exempt of DRY_RUN_EXEMPT_TABLES) {
      expect(after.tableRowCounts[exempt.name], `${exempt.name} 应被豁免`).toBeUndefined()
    }
  })

  it('负向：工作目录写入会被文件树哈希发现', async () => {
    const before = captureDryRunSafetySnapshot(defaultOpts())
    fs.writeFileSync(path.join(P.ws, 'after-replay.txt'), '回放期间不该出现')
    const after = captureDryRunSafetySnapshot(defaultOpts())
    const diff = diffDryRunSafety(before, after)

    expect(diff.fileTreeEqual).toBe(false)
    expect(diff.allEqual).toBe(false)
    fs.rmSync(path.join(P.ws, 'after-replay.txt'))
  })

  it('负向：业务表的新增行会被行数发现', async () => {
    const before = captureDryRunSafetySnapshot(defaultOpts())
    messageRepo.insert({ conversationId: CONV, role: 'assistant', content: '多出来的一行' })
    const after = captureDryRunSafetySnapshot(defaultOpts())
    const diff = diffDryRunSafety(before, after)

    expect(diff.tableRowsEqual).toBe(false)
    expect(diff.tableDiffs).toContainEqual({ table: 'messages', before: 1, after: 2 })
  })

  it('负向：出口计数变化会被发现（注入探针）', async () => {
    const counter = { n: 0 }
    const opts = () => ({ ...defaultOpts(), outboundCount: () => counter.n })
    const before = captureDryRunSafetySnapshot(opts())
    counter.n++
    const after = captureDryRunSafetySnapshot(opts())

    expect(before.outboundCount).toBe(0)
    expect(diffDryRunSafety(before, after).outboundEqual).toBe(false)
  })

  it('豁免是显式的：审计表新增行、logs 目录写入都不进三组', async () => {
    const before = captureDryRunSafetySnapshot(defaultOpts())
    agentTraceRepo.insert({
      requestId: 'req-2',
      conversationId: CONV,
      stepIndex: 1,
      stepType: 'llm',
      status: 'success'
    })
    fs.writeFileSync(path.join(P.logs, 'audit.log'), '审计/日志写入按口径豁免')
    const after = captureDryRunSafetySnapshot(defaultOpts())
    const diff = diffDryRunSafety(before, after)

    expect(diff.tableRowsEqual).toBe(true)
    expect(diff.fileTreeEqual).toBe(true)
    expect(diff.allEqual).toBe(true)
  })
})
