// 真 IPC 往返：工具调用能力探针的三条通道（P0-4b）
//
// 沿用 139/142 的教训：组件用例与主进程用例都绿，中间的桥可能整段没人测过。
// 这三条通道的成功形状都不带 `ok`：探测回 `{entry, error}`、清单回数组、停止回 `{stopped}` ——
// 恰好是 `isIpcFail = 'ok' in v` 那族判据会读错的一族，必须真跨过 preload 才证得到。
//
// 端点是假的、请求是真的：探针的价值在"发出去的形状"（tools 参数、tool_choice、模型名），
// 把 adapter 打桩只能证明函数被调过。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-tool-cap-bridge'
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
import { TOOL_PROBE_TOOL, toolCapabilityKey } from '../src/shared/tool-capability'
import { recordNativeToolCallObservation, recordToolsRejected } from '../src/main/agent/tool-capability'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}
const has = (name: string): unknown => (H.api as Record<string, unknown>)[name]

let bodies: Record<string, unknown>[] = []
let server: http.Server
let baseUrl = ''
let providerId = ''
/** 端点行为开关：同一台模型上要证"失败不覆盖旧判定"，只能让端点换脸色 */
let mode: 'ok' | 'fence' | 'reject' | 'fail' | 'auth' = 'ok'

const MODEL = 'qwen2.5:3b-instruct-q4_K_M.gguf'
const SLOW_MODEL = 'slow-tool-probe-model'
const FENCE_MODEL = 'fence-only-model'
const REJECT_MODEL = 'reject-tools-model'
const SKIP_MODEL = 'skip-probe-model'

function sse(res: http.ServerResponse, delta: unknown, finish: string): void {
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(part(delta))
  res.write(part({ finish_reason: finish }))
  res.write('data: [DONE]\n\n')
  res.end()
}

const nativeSse = (res: http.ServerResponse): void =>
  sse(
    res,
    {
      tool_calls: [
        {
          index: 0,
          id: 'call_t',
          type: 'function',
          function: {
            name: TOOL_PROBE_TOOL,
            arguments: JSON.stringify({ query: 'POCKETAI-TOOL-PROBE' })
          }
        }
      ]
    },
    'tool_calls'
  )

const fenceSse = (res: http.ServerResponse): void =>
  sse(res, { content: '```json\n{"name":"tool_probe","arguments":{"query":"x"}}\n```' }, 'stop')

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
        setTimeout(() => {
          if (!res.destroyed) nativeSse(res)
        }, 400).unref?.()
        return
      }
      if (mode === 'reject') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'This model does not support tools' } }))
        return
      }
      if (mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }))
        return
      }
      if (mode === 'auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      if (mode === 'fence') {
        fenceSse(res)
        return
      }
      nativeSse(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '工具判定桥测端点',
    baseUrl,
    apiKeys: [],
    models: [MODEL, SLOW_MODEL, FENCE_MODEL, REJECT_MODEL, SKIP_MODEL],
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

describe('preload ⇄ 主进程：工具调用能力三条通道', () => {
  it('preload 暴露了方法，且三条通道都在主进程注册过（通道常量拼错在这里红）', () => {
    expect(typeof has('listToolCapabilities')).toBe('function')
    expect(typeof has('probeToolCapability')).toBe('function')
    expect(typeof has('abortToolProbe')).toBe('function')
    expect(H.handlers.has('agent:list-tool-caps')).toBe(true)
    expect(H.handlers.has('agent:probe-tool-cap')).toBe(true)
    expect(H.handlers.has('agent:abort-tool-probe')).toBe(true)
  })

  it('探测经桥层跑通并落库，清单再经桥层读回来（成功形状不带 ok 字段）', async () => {
    mode = 'ok'
    bodies = []
    const r = await call('probeToolCapability', providerId, MODEL)
    expect(r.entry.tier).toBe('usable')
    expect(r.entry.nativeHits).toBe(3)
    expect(r.error).toBeNull()
    expect(bodies).toHaveLength(3)
    // 发出去的形状：每一发都带探针工具，且不是文本协议
    for (const b of bodies) {
      expect(Array.isArray(b.tools)).toBe(true)
      expect((b.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe(TOOL_PROBE_TOOL)
      expect(b.model).toBe(MODEL)
    }
    expect(hasIpcFailed(r)).toBe(false)

    const list = await call('listToolCapabilities')
    expect(Array.isArray(list)).toBe(true)
    const mine = list.find((e: { key: string }) => e.key === toolCapabilityKey(providerId, MODEL))
    expect(mine.tier).toBe('usable')
    expect(mine.nativeHits).toBe(3)
    expect(mine.stale).toBe(false)
    expect(hasIpcFailed(list)).toBe(false)
  })

  it('provider 不存在 ⇒ safeHandle 转成 {ok:false}，且不落任何判定', async () => {
    const bad = await call('probeToolCapability', 'no-such-provider', MODEL)
    expect(bad.ok).toBe(false)
    expect(hasIpcFailed(bad)).toBe(true)
    expect(ipcFailText(bad, '未知错误')).toContain('不存在')
    expect(bad.entry).toBeUndefined()
    const list = await call('listToolCapabilities')
    expect(list.some((e: { providerId: string }) => e.providerId === 'no-such-provider')).toBe(false)
  })

  it('入参 schema 真在桥上跑：空 providerId 被挡且一个请求都没发出去', async () => {
    bodies = []
    const rejected = await call('probeToolCapability', '', MODEL)
    expect(rejected.ok).toBe(false)
    expect(String(rejected.error)).toContain('providerId')
    expect(bodies).toHaveLength(0)
  })

  it('反向对照：真 id + 长模型名必须过 schema；超长模型名不许写进库', async () => {
    bodies = []
    const ok = await call('probeToolCapability', providerId, MODEL)
    expect(ok.ok).toBeUndefined()
    expect(bodies).toHaveLength(3)
    const tooLong = await call('probeToolCapability', providerId, `m:${'x'.repeat(200)}`)
    expect(tooLong.ok).toBe(false)
    const list = await call('listToolCapabilities')
    expect(list.some((e: { model: string }) => e.model.length > 128)).toBe(false)
  })

  it('清单通道不发消息：只读判定时探针端点零请求', async () => {
    bodies = []
    await call('listToolCapabilities')
    expect(bodies).toHaveLength(0)
  })
})

describe('失败面：和模型能力无关的失败一律不落库、不覆盖旧判定', () => {
  it('服务端 500 ⇒ network_failed；此前判定的 usable 必须原样保留', async () => {
    mode = 'fail'
    bodies = []
    const r = await call('probeToolCapability', providerId, MODEL)
    expect(r.error).toEqual({ code: 'network_failed' })
    expect(bodies.length).toBeGreaterThan(0)
    const list = await call('listToolCapabilities')
    const mine = list.find((e: { key: string }) => e.key === toolCapabilityKey(providerId, MODEL))
    expect(mine.tier).toBe('usable')
    expect(mine.nativeHits).toBe(3)
    mode = 'ok'
  })

  it('401 ⇒ auth_failed；同样不许把旧结论改成"不会调工具"', async () => {
    mode = 'auth'
    const r = await call('probeToolCapability', providerId, MODEL)
    expect(r.error?.code).toBe('auth_failed')
    const list = await call('listToolCapabilities')
    const mine = list.find((e: { key: string }) => e.key === toolCapabilityKey(providerId, MODEL))
    expect(mine.tier).toBe('usable')
    mode = 'ok'
  })

  it('端点明确拒绝 tools ⇒ 唯一会因失败落库的分支：known_unusable/tools_rejected', async () => {
    mode = 'reject'
    bodies = []
    const r = await call('probeToolCapability', providerId, REJECT_MODEL)
    expect(r.error).toBeNull()
    expect(r.entry.tier).toBe('known_unusable')
    expect(r.entry.reason).toBe('tools_rejected')
    // 明确拒绝后不再问后两发
    expect(bodies).toHaveLength(1)
    const list = await call('listToolCapabilities')
    const mine = list.find((e: { key: string }) => e.key === toolCapabilityKey(providerId, REJECT_MODEL))
    expect(mine.tier).toBe('known_unusable')
    expect(mine.reason).toBe('tools_rejected')
    mode = 'ok'
  })

  it('只会写围栏 ⇒ known_unusable/fence_only（当前引擎用不了，不许写成"能用"）', async () => {
    mode = 'fence'
    const r = await call('probeToolCapability', providerId, FENCE_MODEL)
    expect(r.error).toBeNull()
    expect(r.entry.tier).toBe('known_unusable')
    expect(r.entry.reason).toBe('fence_only')
    expect(r.entry.fenceHits).toBe(3)
    mode = 'ok'
  })
})

describe('停止探针', () => {
  async function until(fn: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 800; i++) {
      if (fn()) return
      await new Promise((r) => setTimeout(r, 2))
    }
    throw new Error(`等不到：${what}`)
  }

  it('那一发还在飞 ⇒ 跨桥停得掉：stopped:true，探针带 probe_aborted 收住且不再问第二发', async () => {
    mode = 'ok'
    bodies = []
    const inFlight = call('probeToolCapability', providerId, SLOW_MODEL)
    await until(() => bodies.length === 1, '那一发真的进了端点')

    const stop = await call('abortToolProbe', providerId, SLOW_MODEL)
    expect(stop).toEqual({ stopped: true })

    const r = await inFlight
    expect(r.error).toEqual({ code: 'probe_aborted' })
    expect(bodies, '停了以后不该把剩下两发也跑完').toHaveLength(1)
  })

  it('反向对照：这一台没在探 ⇒ stopped:false，而这个 false 不许被读成 IPC 失败', async () => {
    const r = await call('abortToolProbe', providerId, MODEL)
    expect(r).toEqual({ stopped: false })
    expect(hasIpcFailed(r)).toBe(false)
  })

  it('入参 schema 同样管这根通道：空 providerId 被挡，且一发都没碰', async () => {
    bodies = []
    const bad = await call('abortToolProbe', '', MODEL)
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toContain('providerId')
    expect(bodies).toHaveLength(0)
  })
})

describe('跳过检测：单独一根通道，语义与探测分开', () => {
  it('preload 暴露 skipToolProbe，且主进程注册了跳过通道', () => {
    expect(typeof has('skipToolProbe')).toBe('function')
    expect(H.handlers.has('agent:skip-tool-probe')).toBe(true)
  })

  it('跳过写 unknown/user_skipped，且端点一个请求都没收到', async () => {
    bodies = []
    const e = await call('skipToolProbe', providerId, SKIP_MODEL)
    expect(e.tier).toBe('unknown')
    expect(e.reason).toBe('user_skipped')
    expect(e.key).toBe(toolCapabilityKey(providerId, SKIP_MODEL))
    expect(bodies, '跳过不该为了写一条结论去烧用户的额度').toHaveLength(0)

    const list = await call('listToolCapabilities')
    const mine = list.find((x: { key: string }) => x.key === toolCapabilityKey(providerId, SKIP_MODEL))
    expect(mine.tier).toBe('unknown')
    expect(mine.reason).toBe('user_skipped')
  })

  it('不存在的服务商 ⇒ {ok:false}，且不留下垃圾条目', async () => {
    const bad = await call('skipToolProbe', 'no-such-provider', SKIP_MODEL)
    expect(bad.ok).toBe(false)
    const list = await call('listToolCapabilities')
    expect(list.some((e: { providerId: string }) => e.providerId === 'no-such-provider')).toBe(false)
  })
})

describe('运行期观察：成功工具步正向累计，端点拒绝才落 known_unusable', () => {
  const OBSERVE_MODEL = 'runtime-observed-model'
  const find = async (): Promise<any> =>
    (await call('listToolCapabilities')).find(
      (x: { key: string }) => x.key === toolCapabilityKey(providerId, OBSERVE_MODEL)
    )

  it('端点明确拒绝 tools ⇒ known_unusable/tools_rejected（唯一因失败落库的一条路）', async () => {
    await recordToolsRejected(providerId, OBSERVE_MODEL)
    const mine = await find()
    expect(mine.tier).toBe('known_unusable')
    expect(mine.reason).toBe('tools_rejected')
    expect(mine.samples).toBe(0)
  })

  it('一次成功原生调用只到 likely_unusable：不凭单次把"不会"洗成"会"', async () => {
    await recordNativeToolCallObservation(providerId, OBSERVE_MODEL)
    const mine = await find()
    expect(mine.tier).toBe('likely_unusable')
    expect(mine.reason).toBe('partial_native_calls')
    expect(mine.nativeHits).toBe(1)
  })

  it('累计到 3 次原生命中才 usable（与判卷同一阈值，没改数字）', async () => {
    await recordNativeToolCallObservation(providerId, OBSERVE_MODEL)
    await recordNativeToolCallObservation(providerId, OBSERVE_MODEL)
    const mine = await find()
    expect(mine.tier).toBe('usable')
    expect(mine.nativeHits).toBe(3)
    expect(mine.reason).toBe('')
  })
})
