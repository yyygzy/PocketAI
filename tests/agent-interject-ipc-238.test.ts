// V4-Iter-238 真链：插队那发跨过 preload → IPC handler → zod → 引擎收件箱，一条不落。
//
// 为什么又要一份桥层用例（139 那条教训）：渲染层那二十几条打的全是桩，桩给什么形状它就信什么；
// 而这一批的**"接住了吗"判据**依赖三个真形状——
//  · 运行正在进行时 `interjectAgent` 回的是 `{ok:true}`（不是 undefined）；
//  · 运行不在时回的是 `{ok:false, error:'RUN_NOT_FOUND:…'}`，且 safeHandle 把它转成**返回值**而不是 reject；
//  · 全空白／超长的文本被 zod 挡在门外（`ipcCode=IPC_ARG_INVALID`），不会变成一条空 user 消息进上下文。
// 这三条只有真跨桥才证得到。库是真的、引擎循环是真的、HTTP 端点是假的（挂着不回话，好制造"正在运行"）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-238-ipc'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown
}))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

// 一个 mock 假扮两侧：ipcMain 收 handler，ipcRenderer 把 invoke 直接投进那个 handler
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.data, getAppPath: () => P.data, quit: () => {} },
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
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentEngine } from '../src/main/agent/engine'
import { registerAgentHandlers } from '../src/main/ipc/handlers/agent'
import '../src/preload/index'
import { IPC } from '../src/shared/types'

const MODEL = 'fake-hang'

/** 挂着不回话的端点：让运行停在"这一步正在进行"，好从桥那一侧点「立即」 */
let server: http.Server
const heldResponses: Array<http.ServerResponse> = []
let providerId = ''

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}')
      return
    }
    req.on('data', () => {})
    req.on('end', () => {
      heldResponses.push(res) // 故意不 end：这一轮就一直停在流式里
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '挂起探针',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
  registerAgentHandlers()
})

afterAll(async () => {
  for (const res of heldResponses) {
    try {
      res.end()
    } catch {
      /* 已断则忽略 */
    }
  }
  // 端点是故意不回话的：close() 会一直等那些还挂着的连接，10 秒后钩子超时（第一版就红在这）
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

/** 起一轮"永远停在第一步"的运行 */
async function startHangingRun(): Promise<{ requestId: string; conversationId: string; finished: Promise<void> }> {
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: [] })
  const conversationId = conversationRepo.create({
    assistantId: asst.id,
    title: '挂起',
    titleDefault: false
  }).id
  const requestId = `req-238-ipc-${Date.now()}`
  // 计数要在**发起运行之前**取：那一发随时可能到，先跑再取就会把这一发算进"进场时已有"，
  // 于是下面的 waitFor 等不到增量（5 秒后红）
  const before = heldResponses.length
  const finished = agentEngine.run(
    {
      requestId,
      conversationId,
      assistantId: asst.id,
      content: '第一问',
      agentMode: true,
      targets: [{ providerId, model: MODEL }]
    },
    () => {}
  )
  // 等这一发真的打到端点（== 引擎已经注册好收件箱、正卡在流式里）
  await vi.waitFor(() => expect(heldResponses.length).toBeGreaterThan(before), { timeout: 5_000 })
  return { requestId, conversationId, finished }
}

describe('真跨桥：成功与"这轮不在了"两种形状', () => {
  it('运行正在进行 ⇒ {ok:true}，且这句话此刻还没有落库（要等步边界）', async () => {
    const { requestId, conversationId, finished } = await startHangingRun()
    const r = await call('interjectAgent', { requestId, clientRef: 'ref-ipc', text: '插队一句' })
    expect(r).toEqual({ ok: true })
    const db = messageRepo.listByConversation(conversationId)
    expect(db.some((m) => m.content === '插队一句'), '这一步还没结束，不该已经落库').toBe(false)
    // 收尾：中止这一轮（端点一直不回话，只有 abort 能放它走）
    const a = await call('abortAgent', requestId)
    expect(a).toEqual({ ok: true })
    await finished
  })

  it('运行不在（陌生 requestId）⇒ {ok:false}＋RUN_NOT_FOUND，是返回值而不是 reject', async () => {
    const r = await call('interjectAgent', { requestId: 'req-none-238', clientRef: 'ref-x', text: '话' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^RUN_NOT_FOUND:/)
  })

  it('运行结束后同一个 requestId 也回 RUN_NOT_FOUND（收件箱随 finally 清掉，不留残句）', async () => {
    const { requestId, finished } = await startHangingRun()
    const before = await call('interjectAgent', { requestId, clientRef: 'ref-a', text: '还在跑时的一句' })
    expect(before).toEqual({ ok: true })
    await call('abortAgent', requestId)
    await finished
    const after = await call('interjectAgent', { requestId, clientRef: 'ref-b', text: '晚了一步的一句' })
    expect(after.ok).toBe(false)
    expect(after.error).toMatch(/^RUN_NOT_FOUND:/)
  })
})

describe('zod 那一层真的在门口（空白与超长不进上下文）', () => {
  it('全空白文本被挡：{ok:false}＋那句中文，不会变成一条空 user 消息进上下文', async () => {
    const { requestId, conversationId, finished } = await startHangingRun()
    const r = await call('interjectAgent', { requestId, clientRef: 'ref-blank', text: '   ' })
    expect(r.ok).toBe(false)
    // 自定义 refine（不是 too_small/too_big 那一族）不进 IPC_ARG_INVALID 编码，
    // 按 §209 的口径**原样透出那一句中文**——记在这里，免得被读成"它也走四语"
    expect(r.ipcCode).toBeUndefined()
    expect(r.error).toContain('插队内容不能为空')
    // 只数用户行：这一步正在进行时引擎本来就有一条**空的 assistant 占位行**（流式期），
    // 拿"有没有空白内容的行"当判据会把它一起算进来（第一版就是这么红的）
    const userRows = messageRepo.listByConversation(conversationId).filter((m) => m.role === 'user')
    expect(userRows.map((m) => m.content)).toEqual(['第一问'])
    await call('abortAgent', requestId)
    await finished
  })

  it('缺 clientRef／requestId 空串都被挡（渲染层少传一个字段不会变成"引擎收了个匿名插队"）', async () => {
    const noRef = await call('interjectAgent', { requestId: 'req-238-any', text: '话' })
    expect(noRef.ok).toBe(false)
    expect(noRef.ipcCode).toBe('IPC_ARG_INVALID')
    const emptyId = await call('interjectAgent', { requestId: '', clientRef: 'ref', text: '话' })
    expect(emptyId.ok).toBe(false)
    expect(emptyId.ipcCode).toBe('IPC_ARG_INVALID')
  })

  it('通道名两侧同源：IPC.AGENT_INTERJECT 确实注册在 ipcMain 上', () => {
    expect(H.handlers.has(IPC.AGENT_INTERJECT)).toBe(true)
  })
})
