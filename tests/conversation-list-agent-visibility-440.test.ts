// 「用过 Agent 模式的会话会不会从对话侧栏消失」——真库回归（不桩 DB / 不桩仓储）
//
// 背景：引擎 run setup 会把 conversations.model 写成 `agent:provider:model`（engine.ts），
// 而对话侧栏的列表查询曾用 `model NOT LIKE 'agent:%'` 反选 ⇒ 在对话里用过一次 Agent 模式，
// 这条会话就从对话侧栏（含归档区）消失、只出现在 Agent 模块。
//
// 修法：isAgent=false 时不再按 model 前缀反选，只保留 `parent_conversation_id IS NULL`
// （子会话默认不进任何列表）；Agent 侧（isAgent=true）口径不变。
//
// 本文件钉四条：
//  · 写入 `agent:p:m` 形态的 modelLabel 后，会话仍出现在对话侧栏用的那条 list()；
//  · 子会话两边都不列（显式 includeSubSessions 才带出）；
//  · 归档区行为与活跃区一致；
//  · 纯函数 buildConvListQuery 的 where 不再出现 NOT LIKE（防回退），Agent 侧仍按前缀。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conv-agent-visibility'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { buildConvListQuery, conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { resolveAgentMode } from '../src/renderer/src/modules/chat/agent-mode'

/** 对话侧栏实际用的那条查询（useConversationLists → listConversations(aid, false)） */
function chatSidebar(assistantId?: string) {
  return conversationRepo.list(assistantId, false)
}
/** Agent 模块侧栏实际用的那条查询（useAgentChat → listConversations(aid, true)） */
function agentSidebar(assistantId?: string) {
  return conversationRepo.list(assistantId, true)
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
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

describe('① 写过 agent: 前缀的会话仍在对话侧栏', () => {
  it('modelLabel 变成 agent:p:m 后，list(aid,false) 仍含它；Agent 侧同样含它', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '用过 Agent 模式', titleDefault: false })
    expect(ids(chatSidebar('asst-default'))).toContain(conv.id)
    expect(ids(chatSidebar())).toContain(conv.id)
    expect(ids(agentSidebar('asst-default'))).not.toContain(conv.id)

    // 引擎 run setup 的原样写入形状
    conversationRepo.touch(conv.id, { modelLabel: 'agent:prov-x:model-y', status: 'streaming' })

    expect(ids(chatSidebar('asst-default')), '对话侧栏不该因 agent: 前缀丢会话').toContain(conv.id)
    expect(ids(agentSidebar('asst-default')), 'Agent 侧仍按前缀归集').toContain(conv.id)

    // 开关本身（agent_mode）也不参与对话侧过滤
    conversationRepo.setAgentMode(conv.id, true)
    expect(ids(chatSidebar('asst-default'))).toContain(conv.id)
  })

  it('普通会话不会被顺手塞进 Agent 侧栏（放宽只发生在 false 分支）', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '普通问答', titleDefault: false })
    conversationRepo.touch(conv.id, { modelLabel: 'prov-x:model-y' })
    expect(ids(chatSidebar('asst-default'))).toContain(conv.id)
    expect(ids(agentSidebar('asst-default'))).not.toContain(conv.id)
  })
})

describe('② 子代理子会话两边都不列', () => {
  it('parentConversationId 非空的会话，两个侧栏默认都查不到；显式 includeSubSessions 才带出', () => {
    const parent = conversationRepo.create({ assistantId: null, title: '父会话', titleDefault: false })
    const child = conversationRepo.create({
      assistantId: null,
      title: '子会话',
      titleDefault: false,
      parentConversationId: parent.id,
      roleKey: 'researcher'
    })
    conversationRepo.touch(child.id, { modelLabel: 'agent:prov-x:model-y' })

    expect(ids(chatSidebar('asst-default'))).not.toContain(child.id)
    expect(ids(agentSidebar('asst-default'))).not.toContain(child.id)
    expect(
      ids(conversationRepo.list('asst-default', true, { includeSubSessions: true })),
      '显式要看子会话时仍按 Agent 前缀带出'
    ).toContain(child.id)
    expect(ids(chatSidebar('asst-default'))).toContain(parent.id)
  })
})

describe('③ 归档区与活跃区同口径', () => {
  it('归档后的 agent: 会话出现在对话侧栏的归档查询里，且不在活跃列表', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '归档的 Agent 会话', titleDefault: false })
    conversationRepo.touch(conv.id, { modelLabel: 'agent:prov-x:model-y' })
    conversationRepo.setArchived(conv.id, true)

    expect(ids(conversationRepo.list('asst-default', false, { archivedOnly: true }))).toContain(conv.id)
    expect(ids(conversationRepo.list('asst-default', true, { archivedOnly: true }))).toContain(conv.id)
    expect(ids(chatSidebar('asst-default'))).not.toContain(conv.id)
  })
})

describe('④ 纯函数口径（防回退）', () => {
  it('isAgent=false 的 where 不再出现 NOT LIKE；isAgent=true 仍按 agent: 前缀', () => {
    const chat = buildConvListQuery({ isAgent: false })
    expect(chat.where).not.toContain('NOT LIKE')
    expect(chat.where).toContain('parent_conversation_id IS NULL')

    const agent = buildConvListQuery({ isAgent: true })
    expect(agent.where).toContain("model LIKE 'agent:%'")
  })
})

describe('⑤ 入口对齐：Agent 模块建的会话进入对话侧栏时开关默认开启', () => {
  it('agent: 前缀 + agent_mode=0（Agent 模块建会话的默认形态）→ 判开启；本次点击的本地值优先', () => {
    const conv = conversationRepo.create({ assistantId: null, title: 'Agent 模块建的会话' })
    conversationRepo.touch(conv.id, { modelLabel: 'agent:prov-x:model-y' })
    const records = conversationRepo.list(undefined, false)

    expect(records.find((r) => r.id === conv.id)!.agentMode).toBe(false)
    expect(resolveAgentMode(conv.id, records, {}), '不默认开启的话，一次普通发送会把会话踢回 Agent 侧').toBe(
      true
    )
    expect(resolveAgentMode(conv.id, records, { [conv.id]: false })).toBe(false)

    // 普通会话不受影响
    const plain = conversationRepo.create({ assistantId: null, title: '普通会话' })
    conversationRepo.touch(plain.id, { modelLabel: 'prov-x:model-y' })
    const all = conversationRepo.list(undefined, false)
    expect(resolveAgentMode(plain.id, all, {})).toBe(false)
  })
})
