// @vitest-environment node
// V4-Iter-242 真跨桥：评测入口那四条通道跨过 preload → handler → zod → 编排层，一条不落。
//
// 为什么桥层这一份不能省（139 那条教训）：界面那十几条打的全是桩，桩给什么形状它就信什么。
// 而这一批"能不能跑"的判据恰恰全在桥的形状上——
//  · 三道入口闸回的是 **`{ok:false, error:'EVAL_*:中文说明'}`**（safeHandle 把抛错转成返回值），不是 reject
//    ——界面按 `CODE:` 前缀查四语字典（§206 那一族），`ipcCode` 只属于 zod 入参那条道（§209）；
//  · 进度事件推回的是**发起那一个 sender**，且穿过结构化克隆后字段还在；
//  · `k`／`tier`／报告名这些坏入参被 zod 挡在门外，不会变成一个"看起来跑起来了"的空趟。
// 库是真的、引擎是真的、handler 与 preload 是真的；只有端点是假的。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-242-ipc'
  const appRoot = dir + sep + 'app'
  process.env.POCKETAI_APP_ROOT = appRoot
  return { dir, appRoot, db: dir + sep + 'app.db', data: appRoot + sep + 'data' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown,
  /** 每次 invoke 都换一个新的 sender，事件推到它身上——"只推给发起那一窗"要能从这儿读出来 */
  events: [] as Array<{ channel: string; data: Record<string, unknown> }>
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
      // 真 Electron 给 handler 的是 IpcMainInvokeEvent，发送方在 `event.sender` 上——
      // 这一层形状写错，"进度只推给发起那一窗"这条判据就什么都没测到
      return fn({ sender: { send: (channel: string, data: unknown) => {
        H.events.push({ channel, data: data as Record<string, unknown> })
      }, isDestroyed: () => false } }, ...args)
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
import { agentEngine } from '../src/main/agent/engine'
import { registerAgentHandlers } from '../src/main/ipc/handlers/agent'
import '../src/preload/index'
import { IPC } from '../src/shared/types'
import { smokeTasks } from '../src/main/agent/eval/contract'
import { AGENT_EVAL_MAX_K } from '../src/shared/agent-eval'

const MODEL = 'fake-lazy'
/** 这台什么都不干：桥层要证的是通道与形状，产品通过率那一档在别处（真链 242 与真机） */

let obedient: http.Server
let hanging: http.Server
const held: Array<http.ServerResponse> = []
let lazyProvider = ''
let hangProvider = ''

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

  obedient = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({ choices: [{ index: 0, delta: { content: '我想好了，但没有动手' } }] }) +
          '\n\n'
      )
      res.write(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => obedient.listen(0, '127.0.0.1', r))
  lazyProvider = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '不动手的端点',
    baseUrl: `http://127.0.0.1:${(obedient.address() as AddressInfo).port}/v1`,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id

  hanging = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => held.push(res)) // 故意不回话：制造"这一发正在进行"
  })
  await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r))
  hangProvider = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '挂起的端点',
    baseUrl: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/v1`,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id

  registerAgentHandlers()
})

afterAll(async () => {
  for (const res of held) {
    try {
      res.end()
    } catch {
      /* 已断则忽略 */
    }
  }
  hanging.closeAllConnections()
  obedient.closeAllConnections()
  await Promise.all([
    new Promise<void>((r) => hanging.close(() => r())),
    new Promise<void>((r) => obedient.close(() => r()))
  ])
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

/** 起一轮"永远停在第一步"的运行，用来造「现在有 Agent 在跑」那一档 */
async function startHangingRun(): Promise<{ requestId: string; finished: Promise<unknown> }> {
  const asst = assistantRepo.save({ name: `助手-挂起-${Date.now()}`, toolPermissions: [] })
  const conversationId = conversationRepo.create({
    assistantId: asst.id,
    title: '挂起',
    titleDefault: false
  }).id
  const requestId = `req-242-hang-${Date.now()}`
  const before = held.length
  const finished = agentEngine.run(
    {
      requestId,
      conversationId,
      assistantId: asst.id,
      content: '说一句就好',
      agentMode: true,
      targets: [{ providerId: hangProvider, model: MODEL }]
    },
    () => {}
  )
  // 等引擎真把这一发挂上去（controllers 里有它了），否则下面那道闸读到的还是"空闲"
  for (let i = 0; i < 100 && held.length === before; i++) await new Promise((r) => setTimeout(r, 20))
  return { requestId, finished }
}

describe('① 跑一趟：通道、进度、结果形状', () => {
  it('runAgentEval 真跑完冒烟档，进度只推到发起那个 sender，字段穿过克隆还在', async () => {
    H.events.length = 0
    const r = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: 1 })
    expect(r.ok, JSON.stringify(r)).toBeUndefined()
    expect(r.tier).toBe('smoke')
    expect(r.attempts).toHaveLength(smokeTasks().length)
    // 这台不动手：每一发都"跑起来了但没过"，而"没跑起来"必须是 0——这两格在桥那头也要分得开
    expect(r.report.deadTasks).toBe(0)
    expect(r.report.everPassed).toBe(0)

    const evs = H.events.filter((e) => e.channel === IPC.AGENT_EVAL_PROGRESS_EVENT)
    expect(evs.length).toBeGreaterThan(0)
    expect(evs.every((e) => typeof e.data.runId === 'string' && typeof e.data.total === 'number')).toBe(true)
    const last = evs[evs.length - 1]!.data
    expect(last.phase).toBe('attempt-done')
    expect(last.done).toBe(smokeTasks().length)
  }, 120_000)

  it('清单与全文都读得回来：桥那头拿到的就是盘上那份', async () => {
    const list = await call('listAgentEvalReports')
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    const text = await call('readAgentEvalReport', list[0]!.fileName)
    expect(text.ok).toBeUndefined()
    expect(text.text).toContain('Agent 评测')
  })
})

describe('② 入口闸与坏入参：抛出来的回码走 `CODE:中文` 那一族，zod 的自定义文案不进回码通道', () => {
  it('有 Agent 正在跑 ⇒ EVAL_RUN_BUSY；它撤销之后同一通道还能跑（拒绝不许留下脏状态）', async () => {
    const hang = await startHangingRun()
    try {
      expect(agentEngine.hasActiveRun()).toBe(true)
      const busy = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: 1 })
      expect(busy.ok, JSON.stringify(busy)).toBe(false)
      // §206 口径：回码形状是 `CODE:中文说明`，界面按前缀查四语字典，中文尾段留给日志。
      // `ipcCode` 是 zod 入参那条道专用的字段，抛出来的回码不该出现在那儿
      expect(busy.error).toMatch(/^EVAL_RUN_BUSY:/)
      expect(busy.ipcCode, '抛出来的回码被塞进了 ipcCode').toBeUndefined()
    } finally {
      // 断言中途红也不许把那个挂着的运行留在"正在跑"里：它会把后面每一条用例都染成 EVAL_RUN_BUSY
      agentEngine.abort(hang.requestId)
      await hang.finished
    }
    expect(agentEngine.hasActiveRun()).toBe(false)

    const ok = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: 1 })
    expect(ok.ok, JSON.stringify(ok)).toBeUndefined()
    expect(ok.attempts.length).toBeGreaterThan(0)
  }, 120_000)

  it('一趟没跑完时第二趟被挡：EVAL_ALREADY_RUNNING', async () => {
    // 前置自己也要证：上一趟留下的运行没清干净的话，这里拿到的会是 EVAL_RUN_BUSY 而不是本条要测的那一格
    expect(agentEngine.hasActiveRun(), '进这条用例时引擎里还有正在跑的运行').toBe(false)
    const first = call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: 1 })
    const second = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: 1 })
    expect(second.ok).toBe(false)
    expect(second.error, JSON.stringify(second)).toMatch(/^EVAL_ALREADY_RUNNING:/)
    // 被挡的那一趟不许在报告目录里留下半份文件
    const before = (await call('listAgentEvalReports')).length
    await first
    expect((await call('listAgentEvalReports')).length).toBe(before + 1)
  }, 120_000)

  it('没有在跑时点「停下」不是失败：回 stopped:false', async () => {
    const r = await call('stopAgentEval')
    expect(r.ok).toBeUndefined()
    expect(r.stopped).toBe(false)
  })

  it('「停下」打断的正是正在跑的那一发：那一发记成"没跑起来"，剩下的发不再开', async () => {
    // 端点故意不回话：不这样就分不清"只是不再开下一发"与"手上这一发真的被掐了"——
    // 后者才是用户点停止时期望的那件事（否则一次停止最快也要等这一发自己跑完）
    const pending = call('runAgentEval', { providerId: hangProvider, model: MODEL, tier: 'smoke', k: 1 })
    for (let i = 0; i < 200 && !H.events.some((e) => e.data.phase === 'attempt-start'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(H.events.some((e) => e.data.phase === 'attempt-start'), '评测一直没开跑，这条测不到打断').toBe(true)
    const beforeHeld = held.length
    expect(beforeHeld, '那一发还没挂到端点上').toBeGreaterThan(0)

    const stop = await call('stopAgentEval')
    expect(stop.stopped).toBe(true)
    const r = await pending
    expect(r.stoppedEarly).toBe(true)
    expect(r.attempts.length).toBeLessThanOrEqual(2)
    const first = r.attempts[0]
    expect(first.ran, JSON.stringify(first)).toBe(false)
    expect(first.why).toContain('没跑起来')
  }, 120_000)
})

describe('③ zod 面：坏入参挡在门外，不跑出"看起来成功"的空趟', () => {
  it('k 越界 ⇒ IPC_ARG_INVALID；档位拼错 ⇒ 作者写的那句清单（枚举不进回码通道，§209）', async () => {
    const before = (await call('listAgentEvalReports')).length
    const badK = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: AGENT_EVAL_MAX_K + 1 })
    expect(badK.ipcCode, JSON.stringify(badK)).toBe('IPC_ARG_INVALID')
    const zeroK = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'smoke', k: 0 })
    expect(zeroK.ipcCode, JSON.stringify(zeroK)).toBe('IPC_ARG_INVALID')
    const badTier = await call('runAgentEval', { providerId: lazyProvider, model: MODEL, tier: 'all' })
    // 宽松字符串会被服务层静默读成冒烟档，所以枚举必须挡下来。
    // 挡下来的是这句清单本身（`invalid_value` 不进回码通道——那是 §209 定过的三条例外之一）
    expect(badTier.ok).toBe(false)
    expect(badTier.ipcCode).toBeUndefined()
    expect(badTier.error).toContain('smoke / full')
    expect((await call('listAgentEvalReports')).length).toBe(before)
  })

  it('报告名带路径 ⇒ 挡在门外（自定义文案那条门槛同样不进回码通道）；形状对但不存在 ⇒ EVAL_REPORT_NOT_FOUND', async () => {
    const traversal = await call('readAgentEvalReport', '../../config.json')
    expect(traversal.ok).toBe(false)
    expect(traversal.ipcCode).toBeUndefined()
    expect(traversal.error).toContain('报告名只能是一个')
    const missing = await call('readAgentEvalReport', 'no-such-report.md')
    expect(missing.ok).toBe(false)
    expect(missing.error, JSON.stringify(missing)).toMatch(/^EVAL_REPORT_NOT_FOUND:/)
  })
})
