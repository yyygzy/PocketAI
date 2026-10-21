// 真 IPC 往返：委派能力探针的两个新通道（V4-Iter-142）
//
// 为什么再来一份桥层用例：139 那条教训是「组件用例 + 主进程用例都绿，中间的桥可能整段没人测过」。
// 本批新增的是**两个通道 + 渲染层两个调用点**，而这两条通道的成功形状并不带 `ok` 字段
// （探针成功返回 `{entry, error}`，清单成功返回数组）——恰好是 139 里 `isIpcFail = 'ok' in v`
// 那种判据会读错的一族。判据只有真跨过 preload 才证得到，所以这一份不能省。
//
// 端点是假的、请求是真的：探针的价值就在"发出去的形状"，把 adapter 打桩只能证明函数被调过。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-agent-bridge'
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

// 一个 mock 同时假扮两侧：ipcMain 收 handler，ipcRenderer 把 invoke 直接投过去
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.dir, getAppPath: () => P.dir, quit: () => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {},
    removeHorizontalListener: () => {}
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
import { registerAgentHandlers } from '../src/main/ipc/handlers/agent'
import '../src/preload/index'
import { hasIpcFailed, ipcFailText } from '../src/renderer/src/utils/ipc'
import { DELEGATE_PROBE_TOOL } from '../src/shared/delegate-capability'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}
const has = (name: string): unknown => (H.api as Record<string, unknown>)[name]

// ---------- 假端点：回原生 tool_calls，并记录每一条收到的请求体 ----------
let bodies: Record<string, unknown>[] = []
let server: http.Server
let baseUrl = ''
let providerId = ''

const nativeSse = (res: http.ServerResponse): void => {
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(
    part({
      tool_calls: [
        {
          index: 0,
          id: 'call_b',
          type: 'function',
          function: {
            name: DELEGATE_PROBE_TOOL,
            arguments: JSON.stringify({ role: 'researcher', task: '查清知识库检索慢在哪一层，并给出证据' })
          }
        }
      ]
    })
  )
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

let MODEL = ''
/** 这个模型名会让假端点延迟回话——桥上要证的是"那一发还在飞的时候停得掉"，端点秒回就停不到任何东西 */
const SLOW_MODEL = 'slow-probe-model'

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerAgentHandlers()

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      bodies.push(body)
      if (body.model === SLOW_MODEL) {
        // 延迟 400ms 再回：够桥层把「停止」送进去，又不至于把用例拖慢
        setTimeout(() => {
          if (!res.destroyed) nativeSse(res)
        }, 400).unref?.()
        return
      }
      nativeSse(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  // 模型名取"带 registry/量化后缀的长名"这一档：它是 schema 上限边上真实存在的输入
  MODEL = 'qwen2.5:3b-instruct-q4_K_M.gguf'
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '桥测端点',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('preload ⇄ 主进程：委派能力两个通道真的接上了', () => {
  it('preload 暴露了方法，且两条通道都在主进程注册过（通道常量拼错在这里红）', () => {
    expect(typeof has('listDelegateCapabilities')).toBe('function')
    expect(typeof has('probeDelegateCapability')).toBe('function')
    expect(H.handlers.has('agent:list-delegate-caps')).toBe(true)
    expect(H.handlers.has('agent:probe-delegate-cap')).toBe(true)
  })

  it('探测经桥层跑通并落库，清单再经桥层读回来（成功形状不带 ok 字段）', async () => {
    bodies = []
    const r = await call('probeDelegateCapability', providerId, MODEL)
    expect(r.entry.capability).toBe('native_tools_ok')
    expect(r.error).toBeNull()
    expect(bodies).toHaveLength(3)
    // 桥层判失败的谓辞必须对这条通道成立：成功值没有 ok ⇒ 不许被当成失败
    expect(hasIpcFailed(r)).toBe(false)

    const list = await call('listDelegateCapabilities')
    expect(Array.isArray(list)).toBe(true)
    const mine = list.find((e: { model: string }) => e.model === MODEL)
    expect(mine.capability).toBe('native_tools_ok')
    expect(mine.nativeHits).toBe(3)
    expect(mine.stale).toBe(false)
    expect(hasIpcFailed(list)).toBe(false)
  })

  it('provider 不存在 ⇒ safeHandle 转成 {ok:false}，渲染层把它显示成人话而不是"这台不行"', async () => {
    const bad = await call('probeDelegateCapability', 'no-such-provider', MODEL)
    expect(bad.ok).toBe(false)
    expect(hasIpcFailed(bad)).toBe(true)
    expect(ipcFailText(bad, '未知错误')).toContain('不存在')
    // 失败绝不能伪装成一次"判定为不派活"的探测结果
    expect(bad.entry).toBeUndefined()
    const list = await call('listDelegateCapabilities')
    expect(list.some((e: { providerId: string }) => e.providerId === 'no-such-provider')).toBe(false)
  })

  it('入参 schema 真在桥上跑：空 providerId 被挡且一个请求都没发出去', async () => {
    bodies = []
    const rejected = await call('probeDelegateCapability', '', MODEL)
    expect(rejected.ok).toBe(false)
    expect(String(rejected.error)).toContain('providerId')
    expect(bodies).toHaveLength(0)
  })

  it('反向对照：设置页实际构造的载荷（真 id + 长模型名）必须过 schema —— 上一批就是栽在新建空 id 上', async () => {
    bodies = []
    const ok = await call('probeDelegateCapability', providerId, MODEL)
    expect(ok.ok).toBeUndefined()
    expect(bodies).toHaveLength(3)
    // 上限另一侧：超长的模型名是脏输入，不该被放过去写进库
    const tooLong = await call('probeDelegateCapability', providerId, `m:${'x'.repeat(200)}`)
    expect(tooLong.ok).toBe(false)
    const list = await call('listDelegateCapabilities')
    expect(list.some((e: { model: string }) => e.model.length > 128)).toBe(false)
  })

  it('清单通道不发消息：只读判定时探针端点零请求', async () => {
    bodies = []
    await call('listDelegateCapabilities')
    expect(bodies).toHaveLength(0)
  })
})

// ---------- V4-Iter-246：停止探针那根通道 ----------
// 为什么这根通道值得单独跨一次桥：它的返回值 `{stopped}` 既没有 `ok` 字段、又天生带一个
// 长得像失败的 `false`。渲染层那句「此刻没有正在跑的探测」全靠 `stopped:false` 说得出——
// 只要 `hasIpcFailed` 把它读成失败（那是 139 那一族的判据形状），界面上就会换一句话。
describe('preload ⇄ 主进程：停止探针（V4-Iter-246）', () => {
  async function until(fn: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 800; i++) {
      if (fn()) return
      await new Promise((r) => setTimeout(r, 2))
    }
    throw new Error(`等不到：${what}`)
  }

  it('preload 暴露了方法，主进程也注册了这根通道（通道名拼错在这里红，不会等到界面上点了没反应）', () => {
    expect(typeof has('abortDelegateProbe')).toBe('function')
    expect(H.handlers.has('agent:abort-delegate-probe')).toBe(true)
  })

  it('那一发还在飞 ⇒ 跨桥停得掉：stopped:true，探针带 probe_aborted 收住且不再问第二发', async () => {
    bodies = []
    const inFlight = call('probeDelegateCapability', providerId, SLOW_MODEL)
    await until(() => bodies.length === 1, '那一发真的进了端点')

    const stop = await call('abortDelegateProbe', providerId, SLOW_MODEL)
    expect(stop).toEqual({ stopped: true })

    const r = await inFlight
    expect(r.error).toEqual({ code: 'probe_aborted' })
    expect(bodies, '停了以后不该把剩下两发也跑完').toHaveLength(1)
  })

  it('反向对照：这一台没在探 ⇒ stopped:false，而这个 false 不许被读成 IPC 失败', async () => {
    const r = await call('abortDelegateProbe', providerId, MODEL)
    expect(r).toEqual({ stopped: false })
    expect(hasIpcFailed(r)).toBe(false)
  })

  it('入参 schema 同样管这根通道：空 providerId 被挡，且一发都没碰', async () => {
    bodies = []
    const bad = await call('abortDelegateProbe', '', MODEL)
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toContain('providerId')
    expect(bodies).toHaveLength(0)
  })
})
