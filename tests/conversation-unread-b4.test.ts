// B-4 会话未读（D3 已定口径）真实库路径：
//   · 助手一轮正常结束 → 未读；用户消息 / 失败 / 中止 / 子会话 → 不产生未读；
//   · 读的判定是合取：窗口聚焦 && 会话可见 && 未锁屏；
//   · 切走再切回但窗口未聚焦不清；聚焦才清；锁屏期间不清；
//   · 重启后保留（事实源是 conversations.unread，v61）；
//   · 清读幂等（重复上报不写、不广播）；
//   · 未读与运行态角标可以并存（两个槽位，互不覆盖）。
// 另验证渲染端镜像：运行态与未读共用一份快照/增量，未读事件只动未读面。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conversation-unread-b4'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { conversationRunRepo } from '../src/main/db/repositories/conversation-run.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import {
  markRunStarted,
  markRunFinished,
  getRuntimeSnapshot,
  resetRuntimeRegistryForTest,
  setConversationUnreadHook,
  setRuntimePersistence,
  setRuntimeStateBroadcaster
} from '../src/main/chat/runtime-registry'
import {
  listUnreadEvents,
  markConversationUnread,
  reportReadState,
  resetUnreadStateForTest
} from '../src/main/chat/unread-state'
import { lockService } from '../src/main/lock/lock'
import { useConversationRuntimeStore } from '../src/renderer/src/store/conversation-runtime-store'
import type { ChatConversationStateEvent } from '../src/shared/types'

setRuntimePersistence(conversationRunRepo)
// 与 index.ts 同一条接线：run 正常结束 → 未读判定
setConversationUnreadHook(markConversationUnread)

const READER = 7

/** 本用例收到的全部广播（未读/运行态共用一条通道） */
let events: ChatConversationStateEvent[] = []

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  resetRuntimeRegistryForTest()
  setConversationUnreadHook(null)
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetRuntimeRegistryForTest()
  resetUnreadStateForTest()
  if (lockService.getStatus().state === 'locked') lockService.unlock()
  dbService.getHandle().prepare('DELETE FROM messages').run()
  dbService.getHandle().prepare('DELETE FROM conversation_runs').run()
  dbService.getHandle().prepare('DELETE FROM conversations').run()
  events = []
  setRuntimeStateBroadcaster((e) => events.push(e))
})

function runDone(conversationId: string, requestId: string): void {
  markRunStarted({ conversationId, requestId, mode: 'chat' })
  markRunFinished(conversationId, requestId, 'done')
}

function unreadEvents(): Array<{ conversationId: string; unread: boolean }> {
  return events
    .filter((e) => e.kind === 'unread')
    .map((e) => ({ conversationId: e.conversationId, unread: (e as { unread: boolean }).unread }))
}

describe('未读的产生：只认助手消息', () => {
  it('助手一轮正常结束 → 标未读并广播', () => {
    const conv = conversationRepo.create({ title: 'A' })
    runDone(conv.id, 'req-a')

    expect(conversationRepo.isUnread(conv.id)).toBe(true)
    expect(listUnreadEvents().map((e) => e.conversationId)).toContain(conv.id)
    expect(unreadEvents()).toContainEqual({ conversationId: conv.id, unread: true })
  })

  it('用户消息不产生未读', () => {
    const conv = conversationRepo.create({ title: 'B' })
    messageRepo.insert({ conversationId: conv.id, role: 'user', content: 'hi', status: 'done' })

    expect(conversationRepo.isUnread(conv.id)).toBe(false)
    expect(listUnreadEvents()).toHaveLength(0)
  })

  it('失败/中止不产生未读（由既有失败角标表达，不重复记）', () => {
    const conv = conversationRepo.create({ title: 'C' })
    markRunStarted({ conversationId: conv.id, requestId: 'req-c1', mode: 'chat' })
    markRunFinished(conv.id, 'req-c1', 'failed', 'CHAT_NO_TARGET')
    const conv2 = conversationRepo.create({ title: 'C2' })
    markRunStarted({ conversationId: conv2.id, requestId: 'req-c2', mode: 'chat' })
    markRunFinished(conv2.id, 'req-c2', 'aborted')

    expect(conversationRepo.isUnread(conv.id)).toBe(false)
    expect(conversationRepo.isUnread(conv2.id)).toBe(false)
    expect(unreadEvents()).toHaveLength(0)
  })

  it('子会话不参与未读（侧栏本来就过滤子会话）', () => {
    const parent = conversationRepo.create({ title: 'P' })
    const child = conversationRepo.create({ title: 'C', parentConversationId: parent.id })
    runDone(child.id, 'req-child')

    expect(conversationRepo.isUnread(child.id)).toBe(false)
    expect(listUnreadEvents()).toHaveLength(0)
    expect(unreadEvents()).toHaveLength(0)
  })

  it('正在被聚焦窗口读着的会话，结束时不再标未读（避免圆点闪一下）', () => {
    const conv = conversationRepo.create({ title: 'D' })
    expect(reportReadState(READER, { conversationId: conv.id, focused: true, visible: true })).toBe(false)

    runDone(conv.id, 'req-d')

    expect(conversationRepo.isUnread(conv.id)).toBe(false)
    expect(unreadEvents()).toHaveLength(0)
  })
})

describe('清读：聚焦 + 可见 + 未锁屏才清', () => {
  it('切走再切回但窗口未聚焦：不清', () => {
    const conv = conversationRepo.create({ title: 'E' })
    runDone(conv.id, 'req-e')

    // 切到别的会话（窗口仍未聚焦）→ 切回来（仍未聚焦）
    reportReadState(READER, { conversationId: 'other', focused: false, visible: true })
    const r = reportReadState(READER, { conversationId: conv.id, focused: false, visible: true })

    expect(r).toBe(true)
    expect(conversationRepo.isUnread(conv.id)).toBe(true)
    expect(unreadEvents()).toEqual([{ conversationId: conv.id, unread: true }])
  })

  it('页面不可见（document.hidden）也不清', () => {
    const conv = conversationRepo.create({ title: 'F' })
    runDone(conv.id, 'req-f')

    reportReadState(READER, { conversationId: conv.id, focused: true, visible: false })

    expect(conversationRepo.isUnread(conv.id)).toBe(true)
  })

  it('聚焦后清掉；重复聚焦不写不广播（幂等）', () => {
    const conv = conversationRepo.create({ title: 'G' })
    runDone(conv.id, 'req-g')
    events = []

    const first = reportReadState(READER, { conversationId: conv.id, focused: true, visible: true })
    expect(first).toBe(false)
    expect(conversationRepo.isUnread(conv.id)).toBe(false)
    expect(unreadEvents()).toEqual([{ conversationId: conv.id, unread: false }])

    events = []
    expect(reportReadState(READER, { conversationId: conv.id, focused: true, visible: true })).toBe(false)
    expect(unreadEvents()).toHaveLength(0)
  })

  it('锁屏期间不清；解锁后重新聚焦才清', () => {
    const conv = conversationRepo.create({ title: 'H' })
    runDone(conv.id, 'req-h')

    lockService.lock('manual')
    const lockedReport = reportReadState(READER, { conversationId: conv.id, focused: true, visible: true })
    expect(lockedReport).toBeNull() // 锁屏时库是关的，问不到（也不清）
    expect(conversationRepo.isUnread(conv.id)).toBe(true)

    lockService.unlock()
    expect(reportReadState(READER, { conversationId: conv.id, focused: true, visible: true })).toBe(false)
    expect(conversationRepo.isUnread(conv.id)).toBe(false)
  })

  it('锁屏期间完成的助手消息仍算未读（锁屏不算「正在读」）', () => {
    const conv = conversationRepo.create({ title: 'I' })
    reportReadState(READER, { conversationId: conv.id, focused: true, visible: true })
    lockService.lock('manual')

    runDone(conv.id, 'req-i')

    lockService.unlock()
    expect(conversationRepo.isUnread(conv.id)).toBe(true)
  })

  it('子会话的未读不进入快照（双保险）', () => {
    const parent = conversationRepo.create({ title: 'P2' })
    const child = conversationRepo.create({ title: 'C2', parentConversationId: parent.id })
    // 直接写库模拟历史脏数据：快照那一层也要过滤掉
    dbService.getHandle().prepare('UPDATE conversations SET unread=1 WHERE id=?').run(child.id)

    expect(listUnreadEvents()).toHaveLength(0)
  })
})

describe('持久化与叠加', () => {
  it('重启后保留（事实源是 conversations.unread）', () => {
    const conv = conversationRepo.create({ title: 'J' })
    runDone(conv.id, 'req-j')

    // 模拟重启：内存读态/运行态全清，重开数据库
    resetUnreadStateForTest()
    resetRuntimeRegistryForTest()
    dbService.close()
    dbService.open()
    dbService.runMigrations()

    expect(listUnreadEvents().map((e) => e.conversationId)).toContain(conv.id)
  })

  it('未读与运行态角标并存：新一轮在跑时上一轮的未读仍在', () => {
    const conv = conversationRepo.create({ title: 'K' })
    runDone(conv.id, 'req-k1')
    markRunStarted({ conversationId: conv.id, requestId: 'req-k2', mode: 'agent' })

    expect(getRuntimeSnapshot()).toContainEqual(
      expect.objectContaining({ conversationId: conv.id, state: 'running' })
    )
    expect(listUnreadEvents().map((e) => e.conversationId)).toContain(conv.id)
  })

  it('未读不计入 updated_at（不把会话顶到列表最前）', () => {
    const conv = conversationRepo.create({ title: 'L' })
    const before = conversationRepo.get(conv.id)?.updatedAt
    markConversationUnread(conv.id)
    expect(conversationRepo.get(conv.id)?.updatedAt).toBe(before)
    expect(conversationRepo.isUnread(conv.id)).toBe(true)
  })
})

describe('渲染端镜像：运行态与未读共用一份快照/增量', () => {
  it('replace 同时重建两份；unread 事件只动未读面', () => {
    useConversationRuntimeStore.getState().reset()
    useConversationRuntimeStore.getState().replace([
      { conversationId: 'c1', requestId: 'r1', state: 'running', at: 1 },
      { kind: 'unread', conversationId: 'c2', unread: true, at: 2 }
    ])

    const s1 = useConversationRuntimeStore.getState()
    expect(s1.byConversation.c1?.state).toBe('running')
    expect(s1.unreadByConversation.c2).toBe(true)

    s1.apply({ kind: 'unread', conversationId: 'c2', unread: false, at: 3 })
    const s2 = useConversationRuntimeStore.getState()
    expect(s2.unreadByConversation.c2).toBeUndefined()
    expect(s2.byConversation.c1?.state).toBe('running')

    s2.apply({ conversationId: 'c1', requestId: 'r1', state: 'idle', at: 4 })
    expect(useConversationRuntimeStore.getState().byConversation.c1).toBeUndefined()
  })
})
