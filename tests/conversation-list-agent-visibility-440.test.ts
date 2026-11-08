// 会话归集口径：能力列 `agent_mode`（v2 P0，迁移 v59 之后）—— 真库回归（不桩 DB / 不桩仓储）
//
// 背景：v1/Iter-454 把 Agent 侧归集绑在展示字段 `model LIKE 'agent:%'` 上。v2 取消「会话类型」：
// 能不能调用工具是会话级能力开关，唯一口径是 `conversations.agent_mode`，`model` 只存
// `provider:model`。前缀已由 v59 一次性回填，任何列表都不再看前缀。
//
// 本文件钉五组（评审 M3 要求的口径与四种组合）：
//  · 活跃列表：前缀不再是身份——agent_mode=0 的前缀行只在对话侧；置位后才进 Agent 侧；
//  · 置顶：两侧都保持置顶排序；
//  · 归档区：与活跃区同口径，工具会话不因归档丢失；
//  · 子会话：默认两边都不列，显式 includeSubSessions 时仍受 agent_mode 约束；
//  · 纯函数 buildConvListQuery 防回退：Agent 侧出现 `agent_mode = 1`，对话侧不出现类型过滤。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conv-agent-visibility-v59'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { buildConvListQuery, conversationRepo } from '../src/main/db/repositories/conversation.repo'

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

describe('① 活跃列表：前缀不再是身份，能力列才是', () => {
  it('只有 agent: 前缀、agent_mode=0 的会话只在对话侧；置位后才进 Agent 侧', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '历史前缀行', titleDefault: false })
    // 模拟 v58 残留：前缀在、能力列关闭。迁移/启动修复之后正常不会再出现，这里故意保留
    conversationRepo.touch(conv.id, { modelLabel: 'agent:prov-x:model-y', status: 'idle' })
    expect(conversationRepo.get(conv.id)!.agentMode).toBe(false)

    expect(ids(chatSidebar('asst-default')), '对话侧必须含它（P0 不能再丢会话）').toContain(conv.id)
    expect(ids(agentSidebar('asst-default')), '前缀不再有归集作用').not.toContain(conv.id)

    conversationRepo.setAgentMode(conv.id, true)
    expect(ids(chatSidebar('asst-default')), '置位后对话侧仍含它').toContain(conv.id)
    expect(ids(agentSidebar('asst-default'))).toContain(conv.id)
  })

  it('普通会话不会被塞进 Agent 侧栏', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '普通问答', titleDefault: false })
    conversationRepo.touch(conv.id, { modelLabel: 'prov-x:model-y' })
    expect(ids(chatSidebar('asst-default'))).toContain(conv.id)
    expect(ids(agentSidebar('asst-default'))).not.toContain(conv.id)
  })
})

describe('② 置顶：两侧都保持置顶优先', () => {
  it('同助手两个工具会话，置顶的排前；对话侧也不因能力位丢失置顶排序', () => {
    const a = conversationRepo.create({ assistantId: 'asst-pin', title: '工具 A', titleDefault: false })
    const b = conversationRepo.create({ assistantId: 'asst-pin', title: '工具 B', titleDefault: false })
    conversationRepo.setAgentMode(a.id, true)
    conversationRepo.setAgentMode(b.id, true)
    conversationRepo.setPinned(b.id, true)

    expect(ids(agentSidebar('asst-pin')).slice(0, 2)).toEqual([b.id, a.id])
    expect(ids(chatSidebar('asst-pin')).slice(0, 2)).toEqual([b.id, a.id])
  })
})

describe('③ 归档区与活跃区同口径', () => {
  it('工具会话归档后：对话归档区含它、Agent 归档区含它、两侧活跃列表都不含', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '归档的工具会话', titleDefault: false })
    conversationRepo.setAgentMode(conv.id, true)
    conversationRepo.setArchived(conv.id, true)

    expect(ids(conversationRepo.list('asst-default', false, { archivedOnly: true })).length).toBeGreaterThan(0)
    expect(ids(conversationRepo.list('asst-default', false, { archivedOnly: true }))).toContain(conv.id)
    expect(ids(conversationRepo.list('asst-default', true, { archivedOnly: true }))).toContain(conv.id)
    expect(ids(chatSidebar('asst-default'))).not.toContain(conv.id)
    expect(ids(agentSidebar('asst-default'))).not.toContain(conv.id)
  })

  it('未置位的归档会话只进对话归档区，不进 Agent 归档区', () => {
    const conv = conversationRepo.create({ assistantId: null, title: '归档的普通会话', titleDefault: false })
    conversationRepo.setArchived(conv.id, true)
    expect(ids(conversationRepo.list('asst-default', false, { archivedOnly: true }))).toContain(conv.id)
    expect(ids(conversationRepo.list('asst-default', true, { archivedOnly: true }))).not.toContain(conv.id)
  })
})

describe('④ 子会话：默认两边都不列，includeSubSessions 仍受能力位约束', () => {
  it('工具子会话默认两侧都不出现；显式带出时按 agent_mode 归集', () => {
    const parent = conversationRepo.create({ assistantId: 'asst-sub', title: '父会话', titleDefault: false })
    conversationRepo.setAgentMode(parent.id, true)
    const child = conversationRepo.create({
      assistantId: 'asst-sub',
      title: '工具子会话',
      titleDefault: false,
      parentConversationId: parent.id,
      roleKey: 'researcher'
    })
    conversationRepo.setAgentMode(child.id, true)

    const plainChild = conversationRepo.create({
      assistantId: 'asst-sub',
      title: '普通子会话',
      titleDefault: false,
      parentConversationId: parent.id,
      roleKey: 'researcher'
    })

    expect(ids(chatSidebar('asst-sub'))).not.toContain(child.id)
    expect(ids(agentSidebar('asst-sub'))).not.toContain(child.id)
    expect(ids(chatSidebar('asst-sub'))).toContain(parent.id)

    const chatWithSubs = ids(conversationRepo.list('asst-sub', false, { includeSubSessions: true }))
    expect(chatWithSubs).toContain(child.id)
    expect(chatWithSubs).toContain(plainChild.id)

    const agentWithSubs = ids(conversationRepo.list('asst-sub', true, { includeSubSessions: true }))
    expect(agentWithSubs, '工具子会话应按能力位带出').toContain(child.id)
    expect(agentWithSubs, '未置位的子会话不进 Agent 侧').not.toContain(plainChild.id)
  })
})

describe('⑤ 纯函数口径（防回退）', () => {
  it('Agent 侧按 agent_mode；对话侧不做类型过滤；两侧都不出现前缀判断', () => {
    const chat = buildConvListQuery({ isAgent: false })
    expect(chat.where).not.toContain('LIKE')
    expect(chat.where).not.toContain('agent_mode')
    expect(chat.where).toContain('parent_conversation_id IS NULL')

    const agent = buildConvListQuery({ isAgent: true })
    expect(agent.where).toContain('agent_mode = 1')
    expect(agent.where).not.toContain('LIKE')
    expect(agent.where).toContain('parent_conversation_id IS NULL')

    const all = buildConvListQuery({})
    expect(all.where).not.toContain('agent_mode')
  })
})
