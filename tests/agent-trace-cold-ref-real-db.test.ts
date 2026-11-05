// @vitest-environment node
// v54（P0-5 冷 blob 第一批）——真库 + 真 runMigrations()
//
// 这一批只加三列、不改表结构形状，风险全在"老库升上来"：
//  · ALTER 不可重入，靠 schema_migrations 挡；测试要退回版本号真跑一遍；
//  · 旧行必须是 NULL（＝从未留全文），不能是空串——否则判定会把它当成"清了"；
//  · 新列必须真的经 repo 落库并读回（列在 schema 里、值恒 NULL 也能让 CI 全绿）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-v54-cold-ref'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { offloadToolOutput, defaultOffloadRoot, OFFLOAD_PREFIX } from '../src/main/agent/tool-output-offload'
import { resolveTraceReplay, replayStateOf } from '../src/main/agent/trace-replay'

const NEW_COLS = ['message_id', 'cold_ref', 'result_chars'] as const

function columns(): Array<{ name: string; type: string; notnull: number; dflt_value: string | null }> {
  return dbService.getHandle().prepare('PRAGMA table_info(agent_traces)').all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
  }>
}

/**
 * 把 agent_traces 退回 v53 形状（去掉三列、行与索引都搬回来），再删掉 v54 的迁移记录。
 * 不手抄旧 DDL：拿 sqlite_master 里真实语句去掉那三列——手抄一份「上个版本的结构」＝假绿。
 */
function rewindToBeforeV54(): void {
  const db = dbService.getHandle()
  const rows = db.prepare('SELECT * FROM agent_traces').all() as Array<Record<string, unknown>>
  const idx = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_traces' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_traces'").get() as { sql: string }

  let legacy = sql
  for (const n of NEW_COLS) {
    // SQLite 把 ALTER ADD COLUMN 的列追加在建表语句右括号前：`, result_chars INTEGER`
    const re = new RegExp(`,\\s*"?${n}"?\\s+(TEXT|INTEGER)`, 'i')
    expect(legacy, `没在 agent_traces 的建表语句里找到列 ${n}：\n${sql}`).toMatch(re)
    legacy = legacy.replace(re, '')
  }
  expect(legacy).not.toMatch(/message_id|cold_ref|result_chars/)

  db.exec('DROP TABLE agent_traces')
  db.exec(legacy)
  if (rows.length > 0) {
    const kept = Object.keys(rows[0]!).filter((k) => !(NEW_COLS as readonly string[]).includes(k))
    const stmt = db.prepare(`INSERT INTO agent_traces (${kept.join(', ')}) VALUES (${kept.map(() => '?').join(', ')})`)
    for (const r of rows) stmt.run(...kept.map((k) => r[k] as string | number | null))
  }
  for (const i of idx) db.exec(i.sql)
  db.exec('DELETE FROM schema_migrations WHERE version = 54')
}

let CONV = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  CONV = conversationRepo.create({ title: 'v54', assistantId: 'a1' }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('v54 结构', () => {
  it('全新库：三列都在，类型与可空性符合口径（旧行必须是 NULL，不能是空串/0）', () => {
    const info = columns()
    const byName = (n: string) => info.find((c) => c.name === n)!
    expect(byName('message_id').type).toBe('TEXT')
    expect(byName('cold_ref').type).toBe('TEXT')
    expect(byName('result_chars').type).toBe('INTEGER')
    for (const n of NEW_COLS) {
      expect(byName(n).notnull, `${n} 不该 NOT NULL（旧行是 NULL）`).toBe(0)
      expect(byName(n).dflt_value, `${n} 不该有默认值（NULL 与空串语义不同）`).toBeNull()
    }
    const m = dbService.getHandle().prepare('SELECT name FROM schema_migrations WHERE version = 54').get() as { name: string } | undefined
    expect(m?.name).toBe('agent_trace_cold_ref')
  })

  it('升级路径：退回 v53 + 塞旧行 ⇒ 迁移补列，旧行读成 undefined 且原数据不丢', () => {
    const legacy = agentTraceRepo.insert({
      requestId: 'r-legacy-54',
      conversationId: CONV,
      stepIndex: 0,
      stepType: 'tools',
      toolName: 'fs_read',
      status: 'success',
      toolResult: '旧格式 trace'
    })
    expect(legacy.messageId).toBeUndefined()

    rewindToBeforeV54()
    expect(columns().some((c) => c.name === 'cold_ref')).toBe(false)

    dbService.runMigrations()

    expect(columns().some((c) => c.name === 'message_id')).toBe(true)
    const back = agentTraceRepo.listByRequest('r-legacy-54')[0]!
    expect(back.toolResult).toBe('旧格式 trace') // 行没被重建丢掉
    expect(back.messageId).toBeUndefined()
    expect(back.coldRef).toBeUndefined()
    expect(back.resultChars).toBeUndefined()
    // 旧行 ≠ 已清理
    expect(replayStateOf(back, { fileExists: () => true, messageExists: () => true })).toBe('never_stored')
  })

  it('重复跑迁移不再 ALTER（版本门挡着，否则 duplicate column 当场崩）', () => {
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(() => dbService.runMigrations()).not.toThrow()
  })
})

describe('新列读写往返', () => {
  it('messageId / coldRef / resultChars 经 repo.insert 落库并原样读回', () => {
    agentTraceRepo.insert({
      requestId: 'r-roundtrip-54',
      conversationId: CONV,
      stepIndex: 1,
      stepType: 'tools',
      toolName: 'shell_run',
      status: 'success',
      messageId: 'm-1\nm-2',
      coldRef: '@outputs/m-1.txt\n@outputs/m-2.txt',
      resultChars: 12_345
    })
    const row = agentTraceRepo.listByRequest('r-roundtrip-54')[0]!
    expect(row.messageId).toBe('m-1\nm-2')
    expect(row.coldRef).toBe('@outputs/m-1.txt\n@outputs/m-2.txt')
    expect(row.resultChars).toBe(12_345)
  })
})

describe('三档判定（真库 + 真 fs）', () => {
  const root = () => defaultOffloadRoot()

  function makeMessage(content: string): string {
    return messageRepo.insert({ conversationId: CONV, role: 'tool', content }).id
  }

  it('文件与 messages 行都在 ⇒ 可回放', () => {
    const msg = makeMessage('x'.repeat(5000))
    const off = offloadToolOutput(root(), msg, 'x'.repeat(5000))!
    const rec = agentTraceRepo.insert({
      requestId: 'r-replayable', conversationId: CONV, stepIndex: 0, stepType: 'tools',
      status: 'success', messageId: msg, coldRef: off.ref, resultChars: 5000
    })
    expect(resolveTraceReplay(rec)).toBe('replayable')
  })

  it('messages 行被删 ⇒ 原文已清理（文件还在也不许兜底）', () => {
    const msg = makeMessage('y'.repeat(5000))
    const off = offloadToolOutput(root(), msg, 'y'.repeat(5000))!
    const rec = agentTraceRepo.insert({
      requestId: 'r-expired-msg', conversationId: CONV, stepIndex: 0, stepType: 'tools',
      status: 'success', messageId: msg, coldRef: off.ref, resultChars: 5000
    })
    expect(resolveTraceReplay(rec)).toBe('replayable')
    messageRepo.delete(msg)
    expect(resolveTraceReplay(rec)).toBe('expired')
  })

  it('卸载文件不在 ⇒ 原文已清理（messages 行还在也不许兜底）', () => {
    const msg = makeMessage('z'.repeat(5000))
    const rec = agentTraceRepo.insert({
      requestId: 'r-expired-file', conversationId: CONV, stepIndex: 0, stepType: 'tools',
      status: 'success', messageId: msg, coldRef: `${OFFLOAD_PREFIX}never-written.txt`, resultChars: 5000
    })
    expect(resolveTraceReplay(rec)).toBe('expired')
  })

  it('旧行（两列 NULL）⇒ 从未留全文，不判成已清理', () => {
    const rec = agentTraceRepo.insert({
      requestId: 'r-never', conversationId: CONV, stepIndex: 0, stepType: 'tools', status: 'success'
    })
    expect(resolveTraceReplay(rec)).toBe('never_stored')
  })

  it('引用段与 messageId 段对不齐 ⇒ expired（不猜、不兜底）', () => {
    const msg = makeMessage('w'.repeat(5000))
    const rec = agentTraceRepo.insert({
      requestId: 'r-misaligned', conversationId: CONV, stepIndex: 0, stepType: 'tools',
      status: 'success', messageId: msg, coldRef: '', resultChars: 5000
    })
    expect(resolveTraceReplay(rec)).toBe('expired')
  })
})
