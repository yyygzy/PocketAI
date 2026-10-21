// 委派能力探针（V4-Iter-142）——真库 + 真适配器 + 真 HTTP 端点，不 mock fetch
//
// 为什么这条必须真发包：探针的全部价值是"探的就是引擎将来会走的那条路"。
// 把 adapter 打桩就只能证明判卷函数没写错（那半边在 delegate-capability-judge 里测），
// 证不到"发出去的请求真的带 tools""失败时真的没改写旧判定""被设为文本协议的模型真的没发请求"。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-delegate-probe'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

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

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { setTextProtocolModel } from '../src/main/agent/text-protocol-prefs'
import { toolRegistry } from '../src/main/tools/registry'
import {
  __probeToolForTest,
  abortDelegateProbe,
  currentProbeSampleTimeoutMs,
  listDelegateCapabilities,
  listDelegateCapabilitiesWithStaleness,
  probeDelegateCapability,
  setProbeSampleTimeoutForTest
} from '../src/main/agent/delegate-capability'
import {
  localSlotSnapshot,
  resetLocalSlotsForTest,
  setSlotDecisionForTest,
  withLocalSlot
} from '../src/main/providers/local-slot'
import { DELEGATE_PROBE_TOOL } from '../src/shared/delegate-capability'

type EndpointMode = 'native' | 'fence' | 'chat' | 'fail' | 'silent'

let mode: EndpointMode = 'native'
let bodies: Record<string, unknown>[] = []
let server: http.Server
let baseUrl = ''
let providerId = ''

function sse(res: http.ServerResponse, deltas: unknown[], finish: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  for (const d of deltas) res.write(part(d))
  res.write(part({ finish_reason: finish }))
  res.write('data: [DONE]\n\n')
  res.end()
}

function replyByMode(res: http.ServerResponse): void {
  if (mode === 'silent') {
    // §246 的真实形状（2026-10-21 真机）：端点收了连接、把请求体读完了，然后就是不回话——
    // 那两发探针各挂了 7 分钟以上，日志里连一条失败都没有。这里刻意什么都不写，让对端去掐。
    return
  }
  if (mode === 'native') {
    sse(
      res,
      [
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_p',
              type: 'function',
              function: {
                name: DELEGATE_PROBE_TOOL,
                arguments: JSON.stringify({ role: 'researcher', task: '查清知识库检索慢在哪一层，并给出证据' })
              }
            }
          ]
        }
      ],
      'tool_calls'
    )
    return
  }
  if (mode === 'fence') {
    // 真实形状：coder-1.5b 自发写 ```json（引擎严格解析抽不到，但诊断上它就是"想调"）
    sse(
      res,
      [
        {
          content:
            '```json\n{"name":"delegate_probe","arguments":{"role":"writer","task":"写一段给老板看的汇报，说明检索为什么慢"}}\n```'
        }
      ],
      'stop'
    )
    return
  }
  if (mode === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"error":"boom"}')
    return
  }
  // 1.5b-instruct 的真实形状：无视调度角色，直接自己作答
  sse(res, [{ content: '好的，我会帮你写一段汇报，说明知识库检索为什么慢。' }], 'stop')
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
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
      replyByMode(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '探针端点',
    baseUrl,
    apiKeys: [],
    models: ['probe-model'],
    enabled: true,
    createdAt: Date.now()
  }).id
})

afterAll(async () => {
  // §246 的 silent 档会留下"服务端一直开着"的连接，close() 会等它们
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
})

const MODEL = 'probe-model'

describe('探针三态（真发包）', () => {
  beforeEach(() => {
    bodies = []
  })

  it('端点回原生 tool_calls ⇒ native_tools_ok，且发出去的每条请求都带 tools 与探针工具', async () => {
    mode = 'native'
    const r = await probeDelegateCapability(providerId, MODEL, 3)
    expect(r.entry.capability).toBe('native_tools_ok')
    expect(r.error).toBeNull()
    expect(bodies).toHaveLength(3)
    for (const b of bodies) {
      const tools = b.tools as Array<{ function: { name: string } }> | undefined
      expect(tools?.[0]?.function?.name, '探针必须走原生 tools 路径').toBe(DELEGATE_PROBE_TOOL)
    }
    const stored = listDelegateCapabilities()
    expect(stored.find((e) => e.model === MODEL)?.capability).toBe('native_tools_ok')
    expect(stored.find((e) => e.model === MODEL)?.nativeHits).toBe(3)
  })

  it('端点回 ```json 围栏 ⇒ fence_only（决策①说清：这一态今天仍然不可用）', async () => {
    mode = 'fence'
    const r = await probeDelegateCapability(providerId, MODEL, 3)
    expect(r.entry.capability).toBe('fence_only')
    expect(listDelegateCapabilities().find((e) => e.model === MODEL)?.capability).toBe('fence_only')
  })

  it('端点回闲扯 ⇒ no_delegation', async () => {
    mode = 'chat'
    const r = await probeDelegateCapability(providerId, MODEL, 3)
    expect(r.entry.capability).toBe('no_delegation')
  })
})

describe('两条硬规矩（失败不许当结论、文本协议不许探）', () => {
  it('全部请求失败 ⇒ 报错，且库里保留上一轮的判定', async () => {
    mode = 'native'
    await probeDelegateCapability(providerId, MODEL, 3)
    expect(listDelegateCapabilities().find((e) => e.model === MODEL)?.capability).toBe('native_tools_ok')

    bodies = []
    mode = 'fail'
    const bad = await probeDelegateCapability(providerId, MODEL, 3)
    expect(bad.entry.capability).toBe('unknown')
    // 152：没跑完只回码 + 数（中文句子中 ko 界面就成中英夹排）；具体几个失败要在参数里，别把信息丢了
    expect(bad.error).toEqual({ code: 'probe_incomplete', params: { failed: 3, total: 3 } })
    expect(bodies).toHaveLength(3) // 确实发过 3 次，不是没试
    expect(
      listDelegateCapabilities().find((e) => e.model === MODEL)?.capability,
      '失败不得把已知结论冲掉'
    ).toBe('native_tools_ok')
    mode = 'native'
  })

  it('部分失败（3 发挂 1 发）⇒ 不落库，返回的 error 里带计数', async () => {
    let n = 0
    const prevMode = mode
    mode = 'native'
    const before = listDelegateCapabilities().filter((e) => e.model === 'partial-model').length
    expect(before).toBe(0)
    // 用 provider 不存在的方式造不出部分失败，所以直接跑 3 次里让端点坏一次
    const srv2 = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        n++
        if (n === 2) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end('{"error":"一次抖动"}')
          return
        }
        replyByMode(res)
      })
    })
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r))
    const url2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}/v1`
    const p2 = providerRepo.save({
      id: '',
      type: 'openai-compatible',
      name: '抖动端点',
      baseUrl: url2,
      apiKeys: [],
      models: ['partial-model'],
      enabled: true,
      createdAt: Date.now()
    }).id
    const r = await probeDelegateCapability(p2, 'partial-model', 3)
    expect(r.entry.capability).toBe('unknown')
    expect(r.error).toEqual({ code: 'probe_incomplete', params: { failed: 1, total: 3 } })
    expect(listDelegateCapabilities().some((e) => e.model === 'partial-model')).toBe(false)
    await new Promise<void>((res2) => srv2.close(() => res2()))
    mode = prevMode
  })

  it('被设为「走文本协议」的模型 ⇒ 直接拒探，一个请求都不发、不落库', async () => {
    setTextProtocolModel(providerId, MODEL, true)
    bodies = []
    const r = await probeDelegateCapability(providerId, MODEL, 3)
    expect(r.entry.capability).toBe('unknown')
    expect(r.error).toEqual({ code: 'text_protocol_forced' })
    expect(bodies).toHaveLength(0)
    setTextProtocolModel(providerId, MODEL, false)
  })
})

describe('探针工具的边界', () => {
  it('探针工具权限是 deny 且没注册进工具表（它只能被"问"，不能被执行）', () => {
    expect(__probeToolForTest.permission).toBe('deny')
    const names = toolRegistry.listAll().map((t) => t.name)
    expect(names).not.toContain(DELEGATE_PROBE_TOOL)
  })

  it('staleness：拿不到 digest（云端 / serve 没起）就不下"已过期"的结论', async () => {
    mode = 'native'
    await probeDelegateCapability(providerId, MODEL, 3)
    const list = await listDelegateCapabilitiesWithStaleness()
    const mine = list.find((e) => e.model === MODEL)
    expect(mine).toBeDefined()
    expect(mine!.digest).toBe('') // 这台不是 ollama provider，没有失效键
    expect(mine!.stale).toBe(false) // 没失效键 ⇒ 不装懂，只说无法核对
  })
})

describe('app_config 落盘形状', () => {
  it('脏 JSON 直接当"没探过"，不抛也不留半条', () => {
    mode = 'native'
    appConfigRepo.set('agent.delegate_capability', '{这不是 JSON')
    expect(listDelegateCapabilities()).toEqual([])
    appConfigRepo.set('agent.delegate_capability', '[{"providerId":"p"}]')
    expect(listDelegateCapabilities()).toEqual([])
  })
})

// ---------- V4-Iter-246：超时的钟只计"请求在飞"那一段，并给界面一个停止 ----------
// 为什么这四条值得跑真链：这一批的缺陷形状是**两个不同的事实共用一根钟**——
// 本地那张卡被占住时排队是设计（M5／M6），端点收了连接不回话才是故障。把排队算进超时，
// 界面就会指着一条好模型说"它不回话"；不排队（默认未实测档）又永远撞不到那条路，
// 所以判据必须同时有"占着槽"与"端点装死"两条真链，让两种假说算出不同的数。
function origin(): string {
  return new URL(baseUrl).host
}

/** 等状态，不等时长（CI 上排队要多久取决于负载，固定 sleep 只会同时制造假绿和假红） */
async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 800; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`等不到：${what}｜槽位现状 ${JSON.stringify(localSlotSnapshot())}`)
}

function slotState(): { busy: number; waiting: number } {
  const s = localSlotSnapshot().find((x) => x.origin === origin())
  return { busy: s?.busy ?? 0, waiting: s?.waiting ?? 0 }
}

/** 先拿一个已知结论，好在"没跑完"那几条里判它有没有被冲掉 */
async function seedVerdict(): Promise<void> {
  mode = 'native'
  expect((await probeDelegateCapability(providerId, MODEL, 3)).error).toBeNull()
  expect(listDelegateCapabilities().find((e) => e.model === MODEL)?.capability).toBe('native_tools_ok')
}

describe('超时计在飞那一段、停止不留结论（V4-Iter-246）', () => {
  afterEach(() => {
    setProbeSampleTimeoutForTest(null)
    setSlotDecisionForTest(null)
    resetLocalSlotsForTest()
    mode = 'native'
  })

  it('缝接的是真值：不设就是 60 秒，设了当场读得回来（不是设了个没人读的数）', () => {
    expect(currentProbeSampleTimeoutMs()).toBe(60_000)
    setProbeSampleTimeoutForTest(700)
    expect(currentProbeSampleTimeoutMs()).toBe(700)
    setProbeSampleTimeoutForTest(null)
    expect(currentProbeSampleTimeoutMs()).toBe(60_000)
  })

  it('槽位被用户另一条生成占着 ⇒ 排队那 1.5 秒（>整发预算 700ms）不算这台不回话，整探照旧绿', async () => {
    bodies = []
    // 实测档才会套槽（未实测档一行时序都不改，也就永远撞不到这条路）
    setSlotDecisionForTest(() => ({
      maxConcurrentChatSlots: 1,
      allowChatEmbedOverlap: false,
      rolesMayUseDistinctModels: false,
      measured: true,
      bucket: 'entry-4g',
      reasons: []
    }))
    setProbeSampleTimeoutForTest(700)

    let release!: () => void
    const hold = new Promise<void>((r) => {
      release = r
    })
    const held = withLocalSlot({ baseUrl, lane: 'chat', label: '用户正在等的那一条' }, () => hold)
    await until(() => slotState().busy >= 1, '闸门把那张卡占住了')

    const probe = probeDelegateCapability(providerId, MODEL, 3)
    await until(() => slotState().waiting >= 1, '探针那一发确实排在队里')
    // 让"排队"这一段真的长过单发预算：钟若在入队时就武装，这里必然超时红
    await new Promise((r) => setTimeout(r, 1500))
    release()

    const r = await probe
    expect(r.error, '排队不等于端点不回话').toBeNull()
    expect(r.entry.capability).toBe('native_tools_ok')
    expect(bodies).toHaveLength(3)
    await held
  })

  it('端点收了连接不回话 ⇒ 等满 700ms 中止这一发，回 probe_timeout（第几发/共几发/几秒），旧判定不动', async () => {
    await seedVerdict()
    bodies = []
    mode = 'silent'
    setProbeSampleTimeoutForTest(700)

    const r = await probeDelegateCapability(providerId, MODEL, 3)
    // sec 只给数、句子在字典里（152 那条口径）：Math.round(700/1000)=1
    expect(r.error).toEqual({ code: 'probe_timeout', params: { failed: 1, total: 3, sec: 1 } })
    expect(bodies).toHaveLength(1) // 端点装死就别再问第二发，用户已经在等
    expect(
      listDelegateCapabilities().find((e) => e.model === MODEL)?.capability,
      '没跑完不是结论，不许把已知的 native_tools_ok 冲成 unknown'
    ).toBe('native_tools_ok')
  })

  it('用户点停止 ⇒ 掐掉在飞那一发并收住整探，回 probe_aborted，旧判定不动', async () => {
    await seedVerdict()
    bodies = []
    mode = 'silent'
    setProbeSampleTimeoutForTest(30_000) // 让它绝不自走超时，只能被人停

    const probe = probeDelegateCapability(providerId, MODEL, 3)
    await until(() => bodies.length === 1, '第一发真的发出去了')
    expect(abortDelegateProbe(providerId, MODEL)).toBe(true)

    const r = await probe
    expect(r.error).toEqual({ code: 'probe_aborted' })
    expect(bodies).toHaveLength(1) // "停止"是就此收住，不是把剩下两发也跑完
    expect(listDelegateCapabilities().find((e) => e.model === MODEL)?.capability).toBe('native_tools_ok')
  })

  it('同一台不许叠两发 ⇒ 第二发立刻回 probe_running 且一个请求都不发；停了第一发后那台又空得下来', async () => {
    bodies = []
    mode = 'silent'
    setProbeSampleTimeoutForTest(30_000)

    const first = probeDelegateCapability(providerId, MODEL, 3)
    await until(() => bodies.length === 1, '第一发在飞')

    const second = await probeDelegateCapability(providerId, MODEL, 3)
    expect(second.error).toEqual({ code: 'probe_running' })
    expect(second.entry.capability).toBe('unknown')
    expect(bodies, '叠上去的那一发不该把请求真打出去').toHaveLength(1)

    expect(abortDelegateProbe(providerId, MODEL)).toBe(true)
    expect((await first).error).toEqual({ code: 'probe_aborted' })
    // 跑完/停完就没有"正在跑的探测"了——界面那句"此刻没有正在跑的探测"读的是这个 false
    expect(abortDelegateProbe(providerId, MODEL)).toBe(false)
  })
})
