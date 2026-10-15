// 委派能力探针（V4-Iter-142）——真库 + 真适配器 + 真 HTTP 端点，不 mock fetch
//
// 为什么这条必须真发包：探针的全部价值是"探的就是引擎将来会走的那条路"。
// 把 adapter 打桩就只能证明判卷函数没写错（那半边在 delegate-capability-judge 里测），
// 证不到"发出去的请求真的带 tools""失败时真的没改写旧判定""被设为文本协议的模型真的没发请求"。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
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
  listDelegateCapabilities,
  listDelegateCapabilitiesWithStaleness,
  probeDelegateCapability
} from '../src/main/agent/delegate-capability'
import { DELEGATE_PROBE_TOOL } from '../src/shared/delegate-capability'

type EndpointMode = 'native' | 'fence' | 'chat' | 'fail'

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
    expect(bad.error, '全失败要给出人话原因').toContain('失败')
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
    expect(r.error).toContain('1/3')
    expect(listDelegateCapabilities().some((e) => e.model === 'partial-model')).toBe(false)
    await new Promise<void>((res2) => srv2.close(() => res2()))
    mode = prevMode
  })

  it('被设为「走文本协议」的模型 ⇒ 直接拒探，一个请求都不发、不落库', async () => {
    setTextProtocolModel(providerId, MODEL, true)
    bodies = []
    const r = await probeDelegateCapability(providerId, MODEL, 3)
    expect(r.entry.capability).toBe('unknown')
    expect(r.error).toContain('文本协议')
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
