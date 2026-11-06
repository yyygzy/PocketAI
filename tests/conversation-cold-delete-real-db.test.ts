// @vitest-environment node
// P0-5 第二批：删父会话（含子会话）后目录消失、回放降级；旧平铺引用仍可回放（真库 + 真 fs）
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-v54-cold-delete'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('electron', () => ({
  ipcMain: { handle: () => true },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => '/', quit: () => {} }
}))
vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db }))

import { dbService } from '../src/main/db/database'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { writeOffloadFile, defaultOffloadRoot, conversationOffloadDir, OFFLOAD_PREFIX } from '../src/main/agent/tool-output-offload'
import { purgeConversationColdData } from '../src/main/agent/cold-data'
import { resolveTraceReplay } from '../src/main/agent/trace-replay'

const body = 'y'.repeat(5000)

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try {
    dbService.close()
  } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

function seedTrace(convId: string, requestId: string, prefix: string) {
  const msg = messageRepo.insert({ conversationId: convId, role: 'tool', content: body })
  const off = writeOffloadFile(defaultOffloadRoot(), msg.id, body, convId)!
  const rec = agentTraceRepo.insert({
    requestId,
    conversationId: convId,
    stepIndex: 0,
    stepType: 'tools',
    status: 'success',
    messageId: msg.id,
    coldRef: off.ref,
    resultChars: body.length
  })
  return { msg, off, rec, prefix }
}

describe('删父会话：含子会话整目录删，回放降级', () => {
  it('父 + 子目录都消失；删前 replayable，删后 expired（行与文件都没了）', () => {
    const parent = conversationRepo.create({ assistantId: 'a1', title: 'p' })
    const child = conversationRepo.create({ assistantId: 'a1', parentConversationId: parent.id, title: 'c' })
    const p = seedTrace(parent.id, 'r-parent', 'p')
    const c = seedTrace(child.id, 'r-child', 'c')

    expect(fs.existsSync(conversationOffloadDir(defaultOffloadRoot(), parent.id))).toBe(true)
    expect(fs.existsSync(conversationOffloadDir(defaultOffloadRoot(), child.id))).toBe(true)
    expect(resolveTraceReplay(p.rec)).toBe('replayable')
    expect(resolveTraceReplay(c.rec)).toBe('replayable')

    // 仓储只删行；调用方拿返回的 id 清单删盘（与 IPC 层的真实调用一致）
    const doomed = conversationRepo.delete(parent.id)
    expect(doomed).toContain(parent.id)
    expect(doomed).toContain(child.id)
    purgeConversationColdData(doomed)

    expect(fs.existsSync(conversationOffloadDir(defaultOffloadRoot(), parent.id))).toBe(false)
    expect(fs.existsSync(conversationOffloadDir(defaultOffloadRoot(), child.id))).toBe(false)
    expect(resolveTraceReplay(p.rec)).toBe('expired')
    expect(resolveTraceReplay(c.rec)).toBe('expired')
  })
})

describe('旧布局不失联', () => {
  it('平铺 @outputs/<messageId>.txt 仍判 replayable（库里旧的 cold_ref 照旧可回放）', () => {
    const conv = conversationRepo.create({ assistantId: 'a1', title: 'legacy' })
    const msg = messageRepo.insert({ conversationId: conv.id, role: 'tool', content: body })
    // 旧布局：文件在根上，引用没有会话段
    const legacyFile = path.join(defaultOffloadRoot(), `${msg.id}.txt`)
    fs.mkdirSync(defaultOffloadRoot(), { recursive: true })
    fs.writeFileSync(legacyFile, body)
    const rec = agentTraceRepo.insert({
      requestId: 'r-legacy-layout',
      conversationId: conv.id,
      stepIndex: 0,
      stepType: 'tools',
      status: 'success',
      messageId: msg.id,
      coldRef: `${OFFLOAD_PREFIX}${msg.id}.txt`,
      resultChars: body.length
    })
    expect(resolveTraceReplay(rec)).toBe('replayable')
  })
})

describe('恢复后引用缺失的降级', () => {
  it('备份恢复只带回 DB：messages 行在、卸载文件不在 ⇒ expired（不假装可回放）', () => {
    const conv = conversationRepo.create({ assistantId: 'a1', title: 'restored' })
    const msg = messageRepo.insert({ conversationId: conv.id, role: 'tool', content: body })
    const rec = agentTraceRepo.insert({
      requestId: 'r-restored',
      conversationId: conv.id,
      stepIndex: 0,
      stepType: 'tools',
      status: 'success',
      messageId: msg.id,
      coldRef: `${OFFLOAD_PREFIX}${conv.id}/${msg.id}.txt`,
      resultChars: body.length
    })
    expect(resolveTraceReplay(rec)).toBe('expired')
  })
})
