// V4-Iter-235 真链：两条新通道跨过 preload 打到真库上的 conversations / agent_traces。
//
// 为什么又要一份桥层用例（139 那条教训）：渲染层那十几条用例打的全是桩，桩给什么形状它就信什么；
// 而这一批的**只读判据**依赖两个形状——`getConversation` 查无此人时是 `null`（不是 `{ok:false}`），
// 以及入参非法时是 `{ok:false}`（渲染层那句「读不到」得有真 producer）。这两条只在真跨桥时才证得到。
// 库是真的、迁移是真的、SQL 是真的；只有 electron 是假的。每个 describe 自己造会话，互不借对方的 id。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-sub-session-chain'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown
}))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

// 一个 mock 假扮两侧：ipcMain 收 handler，ipcRenderer 把 invoke 直接投进那个 handler
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.dir, getAppPath: () => P.dir, quit: () => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {}
  },
  ipcRenderer: {
    invoke: async (ch: string, ...args: unknown[]) => {
      const fn = H.handlers.get(ch)
      if (!fn) throw new Error(`渲染层指向了一个没人注册的通道：${ch}`)
      return fn({}, ...args)
    },
    on: () => () => {},
    removeListener: () => {},
    send: () => {}
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      H.api = api
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    showErrorBox: () => {}
  },
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
    static getAllWindows() {
      return []
    }
  },
  nativeImage: { createFromPath: () => ({}) }
}))

import { dbService } from '../src/main/db/database'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { registerConversationHandlers } from '../src/main/ipc/handlers/conversations'
import '../src/preload/index'
import { hasIpcFailed } from '../src/renderer/src/utils/ipc'
import {
  formatDelegationResult,
  parseDelegationResultChildPrefixes
} from '../src/shared/delegation-rules'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

/** 建一条会话：给了 parent 就写 parent_conversation_id（与 delegation 建子会话走同一条 create） */
function mkConv(title: string, parentConversationId?: string, roleKey?: string): string {
  return conversationRepo.create({
    assistantId: 'a-chain',
    title,
    modelLabel: 'agent:glm:glm-4.6',
    ...(parentConversationId ? { parentConversationId, roleKey } : {})
  }).id
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerConversationHandlers()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('conversationRepo.listChildren（真 SQL）', () => {
  it('只带直接子级、按创建先后；孙级挂在它自己那一层下面（正向对照）', () => {
    const parent = mkConv('父')
    const kid1 = mkConv('子代理 · 检索', parent, 'researcher')
    const kid2 = mkConv('子代理 · 撰稿', parent, 'writer')
    const grand = mkConv('孙 · 检索', kid1, 'researcher')
    mkConv('另一条顶层会话')

    expect(conversationRepo.listChildren(parent).map((k) => k.id)).toEqual([kid1, kid2])
    expect(conversationRepo.listChildren(parent).map((k) => k.roleKey)).toEqual(['researcher', 'writer'])
    expect(conversationRepo.listChildren(kid1).map((k) => k.id)).toEqual([grand])
    expect(conversationRepo.listChildren(grand)).toEqual([])
  })

  it('空串父 id 返回空表，而不是"所有没有父的会话"（create 把空串归一成 NULL，这条是它的反面）', () => {
    expect(conversationRepo.listChildren('')).toEqual([])
    expect(conversationRepo.listChildren('no-such-conversation')).toEqual([])
  })

  it('与 `list()` 的默认口径互不越界：列表按构造滤掉子会话，listChildren 不受那张滤网影响', () => {
    const parent = mkConv('父·列表')
    const kid = mkConv('子代理 · 审校', parent, 'reviewer')
    const listed = conversationRepo.list('a-chain', true).map((c) => c.id)
    expect(listed).toContain(parent)
    expect(listed).not.toContain(kid)
    expect(conversationRepo.listChildren(parent).map((c) => c.id)).toContain(kid)
  })
})

describe('两条新通道真跨过 preload', () => {
  it('listChildConversations 拿到那两条子会话（父 id 是位置参数，没被 zod 吃掉）', async () => {
    const parent = mkConv('父·桥')
    const kid = mkConv('子代理 · 检索', parent, 'researcher')
    const list = await call('listChildConversations', parent)
    expect(hasIpcFailed(list)).toBe(false)
    expect(list.map((c: { id: string }) => c.id)).toEqual([kid])
  })

  it('getConversation 带得出 parentConversationId 与 roleKey——只读判据读的就是这两列', async () => {
    const parent = mkConv('父·身份')
    const kid = mkConv('子代理 · 撰稿', parent, 'writer')
    const rec = await call('getConversation', kid)
    expect(rec.parentConversationId).toBe(parent)
    expect(rec.roleKey).toBe('writer')
    const top = await call('getConversation', parent)
    expect(top.parentConversationId).toBeNull()
  })

  it('查无此人是 null，不是 {ok:false}：渲染层据此保持"能发"，不发明第三种脸', async () => {
    const rec = await call('getConversation', 'does-not-exist')
    expect(rec).toBeNull()
    expect(hasIpcFailed(rec)).toBe(false)
  })

  it('入参非法（空串 id）⇒ {ok:false}：那句「读不到」有真 producer，不是渲染层自己造的形状', async () => {
    expect(hasIpcFailed(await call('listChildConversations', ''))).toBe(true)
    expect(hasIpcFailed(await call('getConversation', ''))).toBe(true)
  })
})

describe('§163 那把尺子没被这条改动污染（明细归属 + 汇总口径）', () => {
  it('父的明细只有主干、子的明细是它自己那一趟；读过子会话之后父的数字一个字节不变', () => {
    const parent = mkConv('父·带 trace')
    const kid = mkConv('子代理 · 检索', parent, 'researcher')
    const parentReq = 'req-parent-235'
    const childReq = 'req-child-235'
    agentTraceRepo.insert({
      requestId: parentReq,
      conversationId: parent,
      stepIndex: 1,
      stepType: 'llm',
      tokenUsage: 100,
      status: 'success'
    })
    agentTraceRepo.insert({
      requestId: parentReq,
      conversationId: parent,
      stepIndex: 2,
      stepType: 'tools',
      toolName: 'delegate_task',
      tokenUsage: 10,
      status: 'success',
      toolResult: formatDelegationResult({ role: 'researcher', childConversationId: kid, content: '结论' })
    })
    // 子那一趟：自己的 conversationId + 带父 request（144/163 的归因形状）
    agentTraceRepo.insert({
      requestId: childReq,
      conversationId: kid,
      parentRequestId: parentReq,
      stepIndex: 1,
      stepType: 'llm',
      tokenUsage: 40,
      status: 'success'
    })
    agentTraceRepo.insert({
      requestId: childReq,
      conversationId: kid,
      parentRequestId: parentReq,
      stepIndex: 2,
      stepType: 'final',
      tokenUsage: 20,
      status: 'success'
    })

    const trunk = agentTraceRepo.latestTracesByConversation(parent)
    expect(trunk.map((t) => t.requestId)).toEqual([parentReq, parentReq])
    expect(trunk.find((t) => t.toolName === 'delegate_task')?.toolResult).toContain('独立会话')
    const kidSteps = agentTraceRepo.latestTracesByConversation(kid)
    expect(kidSteps.map((s) => s.stepType)).toEqual(['llm', 'final'])

    const before = agentTraceRepo.sessionStatsByConversation(parent)!
    // token 含子那一趟（100+10+40+20），运行次数只算主干
    expect(before.totalTokens).toBe(170)
    expect(before.runCount).toBe(1)
    expect(before.childRuns).toBe(1)
    const own = agentTraceRepo.sessionStatsByConversation(kid)!
    expect(own.totalTokens).toBe(60)
    expect(own.childRuns).toBeUndefined()
    // 打开子会话是纯读：读完再读父，数字不能被带偏
    expect(agentTraceRepo.sessionStatsByConversation(parent)).toEqual(before)
  })
})

describe('那 8 位前缀读得回来（与写入侧同源，渲染层的入口判据不手抄文案）', () => {
  it('一条委派返回一个前缀；并行两条拼在同一行里给两个；没有头部与空值都是零命中', () => {
    const kid = 'aabbccdd-1111-2222-3333-444444444444'
    const other = '99998888-1111-2222-3333-444444444444'
    const one = formatDelegationResult({ role: 'writer', childConversationId: kid, content: '稿子' })
    expect(parseDelegationResultChildPrefixes(one)).toEqual([kid.slice(0, 8)])
    const both = `${one}\n${formatDelegationResult({ role: 'researcher', childConversationId: other, content: 'x' })}`
    expect(parseDelegationResultChildPrefixes(both)).toEqual([kid.slice(0, 8), other.slice(0, 8)])
    // 同一个前缀出现两次 ⇒ 去重（否则一个前缀会被算成两个命中，"唯一命中"那条判据就假了）
    expect(parseDelegationResultChildPrefixes(`${one}\n${one}`)).toEqual([kid.slice(0, 8)])
    expect(parseDelegationResultChildPrefixes('普通工具返回，没有头部')).toEqual([])
    expect(parseDelegationResultChildPrefixes(undefined)).toEqual([])
  })
})
