// P0-4b-1：会话级 Agent 模式开关的持久化（迁移 v57）
//
// 为什么要真库：缺陷的两半分处两层——`conversation:set-agent-mode` 到底写没写进那一列（写侧），
// 以及切会话/重启后读出来的记录里有没有它（读侧）。只 mock state 的用例两侧都碰不到：
// 把 `setAgentMode` 改回"只改内存"、或让 `rowToRecord` 漏带这一列，mock 全绿而真机照样丢。
// ⇒ 这里真库＋真 repo，重启用 `close()/open()` 真的重开同一个 db 文件，再读回。
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conv-agent-mode-439'
  return { dir, data: dir + sep + 'data', db: dir + sep + 'data' + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => P.dir, getPath: () => P.dir }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { resolveAgentMode } from '../src/renderer/src/modules/chat/agent-mode'

function colsOf(table: string): Array<{ name: string; notnull: number; dflt_value: string | number | null }> {
  return dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    notnull: number
    dflt_value: string | number | null
  }>
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try {
    dbService.close()
  } catch { /* 关不掉不掩盖结论 */ }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch { /* scratch 残留由 CI 的临时目录承担 */ }
})

describe('① 迁移 v57：列与老数据口径', () => {
  it('conversations 有 agent_mode 列：NOT NULL DEFAULT 0（不用 NULL 留"不知道开没开"的第三态）', () => {
    const col = colsOf('conversations').find((c) => c.name === 'agent_mode')
    expect(col, `现数列：${colsOf('conversations').map((c) => c.name).join(', ')}`).toBeTruthy()
    expect(col!.notnull, '老会话必须有明确的默认值，不能靠 NULL').toBe(1)
    expect(String(col!.dflt_value), '迁移前"没有条目"读出的就是 false ⇒ 默认必须显式是 0').toBe('0')
    // 不钉死具体号（下一条迁移会推进它）；只证明本迁移已在链上
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(57)
  })

  it('迁移前的老会话（写入时压根不带这一列）读回为关闭，与迁移前行为逐字一致', () => {
    const db = dbService.getHandle()
    const now = Date.now()
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, title, created_at, updated_at) VALUES ('legacy-unknown', NULL, '老会话', ?, ?)`
    ).run(now, now)
    const legacy = conversationRepo.get('legacy-unknown')
    expect(legacy).toBeTruthy()
    expect(legacy!.agentMode, '老会话不许读成 undefined/true').toBe(false)
    // 库里存的也必须是 0，而不是 NULL（读侧 false 不能靠"NULL 被 === 1 判成 false"蒙对）
    const raw = db.prepare('SELECT agent_mode FROM conversations WHERE id = ?').get('legacy-unknown') as { agent_mode: number | null }
    expect(raw.agent_mode, `现数：${String(raw.agent_mode)}`).toBe(0)
  })
})

describe('② 写入后读回（真 repo）', () => {
  it('新建会话默认关闭；setAgentMode 写完立刻能从 get/list 读回', () => {
    const a = conversationRepo.create({ title: '会话 A' })
    expect(a.agentMode, '新建会话不继承任何上一轮的值').toBe(false)

    expect(conversationRepo.setAgentMode(a.id, true)).toBe(true)
    expect(conversationRepo.get(a.id)!.agentMode).toBe(true)
    const listed = conversationRepo.list(undefined, false).find((c) => c.id === a.id)
    expect(listed!.agentMode, '列表查询（渲染层的取数路径）也必须带出这一列').toBe(true)

    expect(conversationRepo.setAgentMode(a.id, false)).toBe(true)
    expect(conversationRepo.get(a.id)!.agentMode).toBe(false)
  })

  it('会话不存在时返回 false（不静默成功，否则"记住了"是假的）', () => {
    expect(conversationRepo.setAgentMode('no-such-conversation', true)).toBe(false)
  })

  it('分支（fork）跟着源会话的 Agent 模式走，不静默退回普通问答', () => {
    const src = conversationRepo.create({ title: '分支源' })
    conversationRepo.setAgentMode(src.id, true)
    const db = dbService.getHandle()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('fork-msg-1', ?, 'user', 'hi', ?)`
    ).run(src.id, Date.now())
    const forked = conversationRepo.fork(src.id, 'fork-msg-1')
    expect(forked.agentMode).toBe(true)
  })
})

describe('③ 切会话各自恢复（记录 + 渲染层取值口径）', () => {
  it('A 开 / B 关：同一次列表读回里，两条记录各自是各自的值', () => {
    const a = conversationRepo.create({ title: '切换 A' })
    const b = conversationRepo.create({ title: '切换 B' })
    conversationRepo.setAgentMode(a.id, true)
    conversationRepo.setAgentMode(b.id, false)

    const records = conversationRepo.list(undefined, false)
    expect(records.find((c) => c.id === a.id)!.agentMode).toBe(true)
    expect(records.find((c) => c.id === b.id)!.agentMode).toBe(false)

    // ChatModule 用的就是同一个纯函数：切到哪条，显示哪条的记录值
    expect(resolveAgentMode(a.id, records, {})).toBe(true)
    expect(resolveAgentMode(b.id, records, {})).toBe(false)
    // 尚未建会话的那格不在库里，默认关闭；它只活在内存
    expect(resolveAgentMode(null, records, {})).toBe(false)
  })
})

describe('④ 重启后恢复（关掉数据库再打开同一个文件）', () => {
  it('重开后两条会话仍是各自的值（不靠渲染层 state）', () => {
    const a = conversationRepo.create({ title: '重启 A' })
    const b = conversationRepo.create({ title: '重启 B' })
    conversationRepo.setAgentMode(a.id, true)
    conversationRepo.setAgentMode(b.id, false)

    // 真正的"重启"：丢掉连接与内存缓存，重新读同一个 db 文件
    dbService.close()
    dbService.open()
    dbService.runMigrations()

    expect(conversationRepo.get(a.id)!.agentMode, 'A 开了 Agent，重启后必须还开着').toBe(true)
    expect(conversationRepo.get(b.id)!.agentMode, 'B 关着，重启后必须还是关的').toBe(false)

    const records = conversationRepo.list(undefined, false)
    expect(records.find((c) => c.id === a.id)!.agentMode).toBe(true)
    expect(records.find((c) => c.id === b.id)!.agentMode).toBe(false)
  })

  it('v2 用例：关模式 → 重启仍关（关闭即关闭，启动修复不把它误开）', () => {
    const c = conversationRepo.create({ title: '关闭后重启' })
    expect(conversationRepo.setAgentMode(c.id, true)).toBe(true)
    expect(conversationRepo.setAgentMode(c.id, false)).toBe(true)

    dbService.close()
    dbService.open()
    dbService.runMigrations()
    // 产品启动路径的幂等修复也在重开之后跑（本会话没有前缀残留，应命中 0 行）
    expect(dbService.repairLegacyAgentLabels()).toBe(0)

    expect(conversationRepo.get(c.id)!.agentMode, '用户关掉的开关重启后又开了').toBe(false)
    expect(resolveAgentMode(c.id, conversationRepo.list(undefined, false), {})).toBe(false)
  })
})
