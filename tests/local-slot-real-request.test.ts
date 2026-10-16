// 本地槽位闸门（V4-Iter-141）——真起 HTTP 服务端、真用适配器，不 mock 网络层
//
// 为什么必须真发包：这一批改的是**时序**（谁在什么时候被放出去）。把 adapter 打桩就只能断言
// "函数被调用过"，而"服务端观察到的并发峰值 = 1"这类判据要在真 socket 上量。
// 依赖方向是本批的硬约束：local-slot 只依赖纯判据与 url-policy，"这张卡多大"与慢等待埋点由
// composition root（src/main/index.ts）注入。原因很实际——本批一开始让 local-slot 静态 import 了
// steward/hardware，结果三个用到适配器的测试文件被 electron 依赖链拖到加载失败。
// index.ts 里那次接线由本文件末尾的 scan 用例钉住（忘记接的后果是"不套槽"，静默且无害，所以必须有 CI）。
//
// 观察方式：先"按住"请求制造一个观察窗口（闸门坏掉时，两条请求会在窗口里同时到场 ⇒ 峰值 2），
// 窗口之后再开排水器让队列把剩余请求陆续放完。少了这个区分，用例会因为第二路根本还没到场而假绿。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { OpenAICompatibleAdapter } from '../src/main/providers/openai-compatible'
import {
  configureLocalSlot,
  currentSlotKind,
  isLocalInferenceBaseUrl,
  localSlotSnapshot,
  resetLocalSlotsForTest,
  runInSlotKind,
  setSlotClockForTest,
  setSlotPromoteMsForTest,
  withLocalSlot
} from '../src/main/providers/local-slot'

// ---------- 假本地推理服务 ----------

interface FakeServer {
  baseUrl: string
  readonly peak: number
  readonly starts: string[]
  readonly inflight: number
  releaseOne: () => void
  failNext: () => void
  reset: () => void
  /** 到达即放行（观察窗口结束后用），返回停止函数 */
  drain: () => () => void
  close: () => Promise<void>
}

async function startFakeLocalServer(): Promise<FakeServer> {
  const state = { inflight: 0, peak: 0, failOnce: false }
  const starts: string[] = []
  const holds: Array<() => void> = []

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += String(c)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      let model = ''
      try {
        model = String(JSON.parse(raw || '{}').model ?? '')
      } catch {
        model = ''
      }
      const tag = `${url.split('/').filter(Boolean).pop() ?? url}#${model || 'n/a'}`
      starts.push(tag)

      if (state.failOnce) {
        state.failOnce = false
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"boom"}')
        return
      }
      // 元数据端点立刻返回：它不过闸，用来钉"拉列表不该排在生成后面"
      if (url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[{"id":"m1","object":"model"}]}')
        return
      }

      state.inflight++
      state.peak = Math.max(state.peak, state.inflight)
      const hold = new Promise<void>((resolve) => holds.push(resolve))
      void hold.then(() => {
        state.inflight--
        if (url.endsWith('/chat/completions')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n')
          return
        }
        if (url.endsWith('/embeddings')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"data":[{"index":0,"embedding":[0.5,0.25]}]}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        // 空 b64 会被适配器判成"既无 b64_json 也无 url"，给个真值
        res.end('{"data":[{"b64_json":"aGVsbG8="}]}')
      })
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get peak() {
      return state.peak
    },
    get inflight() {
      return state.inflight
    },
    starts,
    releaseOne: () => holds.shift()?.(),
    failNext: () => {
      state.failOnce = true
    },
    reset: () => {
      holds.splice(0).forEach((r) => r())
      starts.length = 0
      state.peak = 0
      state.inflight = 0
      state.failOnce = false
    },
    drain: () => {
      const t = setInterval(() => {
        holds.shift()?.()
      }, 10)
      return () => clearInterval(t)
    },
    close: async () => {
      holds.splice(0).forEach((r) => r())
      await new Promise<void>((r) => server.close(() => r()))
    }
  }
}

/** 固定 sleep：只用于"该什么都不发生"的反向对照（等待本身不是它要证的东西） */
const settle = async (ms = 80): Promise<void> => {
  // 先等到「至少一条请求真的落到了服务端」再留一拍。固定 sleep 在全量跑批（296 个 worker 抢机器）里
  // 会两头不靠：80ms 内一条都没发出时，`srv.peak` 读到 0，而它该是 1（V4-Iter-145 的三遍全量撞到一次）。
  // 只等「有到达」这一件所有并发断言共同的前提，不等排队方——那条永远不会到达。
  const t0 = Date.now()
  while (srv.starts.length === 0 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * 等到"第一路已经落到服务端、第二路已在闸门里排队"。
 * 这三个用例原来用 `settle()`（固定 80ms）——全量跑批 296 个 worker 抢机器时，
 * 两条 fetch 可能都还没发出，`srv.peak` 读到 0 就红了（V4-Iter-145 的三遍全量里撞到一次）。
 * 判据是"观察窗口等到事件"而不是"睡一觉赌它发生了"：同 [[feedback-verification-probes-uncontaminated]]。
 */
async function settleQueued(): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < 4000) {
    const waiting = localSlotSnapshot()[0]?.waiting ?? 0
    if (srv.starts.length >= 1 && waiting >= 1) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等不到"一路在飞 + 一路排队"（starts=${srv.starts.length}，peak=${srv.peak}）`)
}

// 每条用例各起一个假服务：peak/starts/holds 都是服务自身的累计量，
// 共用一个 server 会让上一条用例的在飞请求混进这一条的观察窗口（第一次跑就是这么红的）
let srv: FakeServer
let vramMiB: number | null
let waits: Array<{ ms: number; detail: string }>

beforeEach(async () => {
  resetLocalSlotsForTest()
  srv = await startFakeLocalServer()
  vramMiB = 4096
  waits = []
  configureLocalSlot({ readVramMiB: () => vramMiB, recordWait: (ms, detail) => waits.push({ ms, detail }) })
})
afterEach(async () => {
  resetLocalSlotsForTest()
  await srv.close()
})

const adapter = (baseUrl = srv.baseUrl) => new OpenAICompatibleAdapter(baseUrl, ['test-key'])
const chat = (model = 'qwen2.5:3b-instruct', signal?: AbortSignal) =>
  adapter().streamChat([{ role: 'user', content: '说一句好' }], { model, signal }, { onDelta: () => {} })
const embed = (model = 'bge-m3', baseUrl = srv.baseUrl) => adapter(baseUrl).embed(['一句话'], model)

describe('实测档（≤4GiB：本机唯一真测过的卡）', () => {
  it('两路对话并发时服务端观察到的并发峰值是 1（串行不亏，M6）', async () => {
    const a = chat('m-first')
    const b = chat('m-second')
    await settleQueued()
    expect(srv.peak).toBe(1)
    expect(localSlotSnapshot()[0]!.waiting).toBe(1)
    const stop = srv.drain()
    await Promise.all([a, b])
    stop()
    expect(srv.starts.map((s) => s.split('#')[1])).toEqual(['m-first', 'm-second'])
    expect(srv.peak).toBe(1)
  })

  it('对话与 embedding 共用同一条队（M10：小卡上两者不同驻）', async () => {
    const a = chat('c1')
    const b = embed('e1')
    await settleQueued()
    expect(srv.peak).toBe(1)
    const stop = srv.drain()
    await Promise.all([a, b])
    stop()
    expect(srv.starts).toEqual(['completions#c1', 'embeddings#e1'])
  })

  it('图像生成也走同一道闸门（漏一条端点就等于没接线）', async () => {
    const a = chat('c2')
    const b = adapter().generateImages({ model: 'img1', prompt: 'x', size: '512x512' })
    await settleQueued()
    expect(srv.peak).toBe(1)
    const stop = srv.drain()
    await Promise.all([a, b])
    stop()
    expect(srv.starts).toContain('generations#img1')
  })

  it('反向对照①：未实测档（12GiB）不排队，与今天完全一致', async () => {
    vramMiB = 12288
    const a = chat('u1')
    const b = chat('u2')
    await settle()
    expect(srv.peak).toBe(2)
    expect(localSlotSnapshot()).toEqual([])
    const stop = srv.drain()
    await Promise.all([a, b])
    stop()
  })

  it('反向对照②：composition root 忘记接线 ⇒ 不排队也不报错（默认按"采不到"）', async () => {
    resetLocalSlotsForTest() // 回到未配置状态：readVramMiB 恒 null
    const a = chat('x1')
    const b = chat('x2')
    await settle()
    expect(srv.peak).toBe(2)
    const stop = srv.drain()
    await Promise.all([a, b])
    stop()
  })

  it('反向对照③：读硬件抛错 ⇒ 当"采不到"处理，推理照常跑', async () => {
    configureLocalSlot({
      readVramMiB: () => {
        throw new Error('WMI 查询失败')
      }
    })
    const stop = srv.drain()
    const ok = await chat('throw-vram')
    stop()
    expect(ok.content).toBe('好')
  })

  it('云地址与脏地址都不过闸（判据只管本机那张卡）', () => {
    expect(isLocalInferenceBaseUrl('https://api.deepseek.com/v1')).toBe(false)
    expect(isLocalInferenceBaseUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalInferenceBaseUrl('http://localhost:1234/v1')).toBe(true)
    expect(isLocalInferenceBaseUrl('not a url')).toBe(false)
  })

  it('listModels 故意不过闸：拉模型列表不该排在一次正在进行的生成后面', async () => {
    const busy = chat('busy')
    await settle()
    const models = await adapter().listModels()
    expect(models).toEqual(['m1'])
    const stop = srv.drain()
    await busy
    stop()
  })
})

describe('优先级与饿死保护（用户选定的两条）', () => {
  it('前台在场时后台排队；随后到的前台插到后台前面', async () => {
    const holder = chat('holder')
    await settle()
    const bg = runInSlotKind('background', () => embed('bg'))
    const fg = chat('fg')
    await settle()
    srv.releaseOne()
    const stop = srv.drain()
    await Promise.all([holder, bg, fg])
    stop()
    const order = srv.starts.map((s) => s.split('#')[1])
    expect(order.indexOf('fg')).toBeLessThan(order.indexOf('bg'))
  })

  it('槽位类别是在适配器出口读的：detail 里出现 background 才算真透传到位', async () => {
    let clock = 0
    setSlotClockForTest(() => clock)
    expect(currentSlotKind()).toBe('foreground')
    const holder = chat('holder')
    await settle()
    await runInSlotKind('background', async () => {
      expect(currentSlotKind()).toBe('background')
      const p = embed('bg-kind-probe')
      clock += 700
      srv.releaseOne()
      const stop = srv.drain()
      await Promise.all([holder, p])
      stop()
    })
    expect(currentSlotKind()).toBe('foreground')
    expect(waits.length).toBeGreaterThan(0)
    expect(waits[waits.length - 1]!.detail).toContain('background')
  })

  it('后台等待超过阈值 ⇒ 升级为前台同级，后来的前台不得继续压它', async () => {
    let clock = 1000
    setSlotClockForTest(() => clock)
    setSlotPromoteMsForTest(500)

    const holder = chat('holder')
    await settle()
    const bg = runInSlotKind('background', () => embed('bg'))
    clock += 600 // 后台已等到超过阈值
    const laterFg = chat('later-fg')
    await settle()
    srv.releaseOne()
    const stop = srv.drain()
    await Promise.all([holder, bg, laterFg])
    stop()
    const order = srv.starts.map((s) => s.split('#')[1])
    expect(order.indexOf('bg')).toBeLessThan(order.indexOf('later-fg'))
  })
})

describe('释放、重入与观测', () => {
  it('请求失败也必须归还槽（否则一次 500 就永久卡死本地推理）', async () => {
    srv.failNext()
    await expect(chat('boom')).rejects.toThrow()
    const stop = srv.drain()
    const ok = await chat('after-boom')
    stop()
    expect(ok.content).toBe('好')
    expect(localSlotSnapshot()[0]?.waiting ?? 0).toBe(0)
  })

  it('排队期间被取消 ⇒ 退出队列、不占排队位，后来的请求照常起跑', async () => {
    const holder = chat('holder')
    await settle()
    const ctrl = new AbortController()
    const queued = chat('cancelled', ctrl.signal)
    await settle()
    expect(localSlotSnapshot()[0]!.waiting).toBe(1)
    ctrl.abort()
    await expect(queued).rejects.toThrow()
    expect(localSlotSnapshot()[0]!.waiting).toBe(0)
    srv.releaseOne()
    const stop = srv.drain()
    await holder
    const after = await chat('after-cancel')
    stop()
    expect(after.content).toBe('好')
  })

  it('交棒与取消落在同一个 tick ⇒ 不许起跑已被取消的请求，且槽必须归还', async () => {
    // 这一步专门测那条竞态：releaseOne() 里 pickNext 已经把等待者摘出队列并 resolve，
    // 而等待方的续集还没跑到——此时 abort，onAbort 在队列里已经找不到它了。
    // 没有"交棒后再复查一次"这道守卫，被取消的请求会真的起跑（占着一整路生成）。
    const holder = chat('holder')
    await settle()
    const ctrl = new AbortController()
    const queued = chat('race-cancel', ctrl.signal)
    await settle()
    srv.releaseOne()
    ctrl.abort()
    await expect(queued).rejects.toThrow()
    const stop = srv.drain()
    await holder
    // 槽没被幽灵占用：后面这条照常跑完
    const after = await chat('after-race')
    stop()
    expect(after.content).toBe('好')
  })

  it('反向对照：闸门已在链上时，嵌套调用不许二次排队（容量 1 时二次排队就是自锁）', async () => {
    const stop0 = srv.drain()
    const inner = await withLocalSlot({ baseUrl: srv.baseUrl, lane: 'chat', label: 'outer' }, async () =>
      withLocalSlot({ baseUrl: srv.baseUrl, lane: 'embedding', label: 'inner' }, () => embed('inner'))
    )
    stop0()
    expect(inner).toHaveLength(1)
    expect(srv.starts).toEqual(['embeddings#inner'])
    expect(localSlotSnapshot()[0]?.busy ?? 0).toBe(0)
  })

  it('等待超过 500ms 记一次慢等待，detail 带模型名（此前 kb.* 标签不带 provider/model）', async () => {
    let clock = 0
    setSlotClockForTest(() => clock)
    const a = chat('first')
    await settle()
    const b = chat('slow-wait')
    await settle()
    clock += 900
    srv.releaseOne()
    const stop = srv.drain()
    await Promise.all([a, b])
    stop()
    expect(waits).toHaveLength(1)
    expect(waits[0]!.detail).toContain('model=slow-wait')
    expect(waits[0]!.detail).toContain('foreground')
    expect(waits[0]!.ms).toBe(900)
  })

  it('队列按 origin 分：另一台机器不该让本机排队', async () => {
    const other = await startFakeLocalServer()
    try {
      const a = chat('A')
      await settle()
      const b = embed('B', other.baseUrl)
      await settle()
      expect(localSlotSnapshot().map((s) => s.origin)).toHaveLength(2)
      expect(other.inflight).toBe(1) // 第二条队没被本机堵住了
      const stopA = srv.drain()
      const stopB = other.drain()
      await Promise.all([a, b])
      stopA()
      stopB()
    } finally {
      await other.close()
    }
  })
})

// 接线闸门：闸门只存在于适配器出口；端点被绕过时这条会指出是哪一处
describe('闸门位置不可绕过', () => {
  it('三条推理端点都在 withLocalSlot 之后，而 /models 被刻意留在闸门外', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/main/providers/openai-compatible.ts', 'utf8')
    expect((src.match(/withLocalSlot\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
    for (const ep of ['/chat/completions', '/embeddings', '/images/generations']) {
      expect(src.indexOf(ep), `端点 ${ep} 应存在于适配器`).toBeGreaterThan(-1)
      expect(src.indexOf(ep)).toBeGreaterThan(src.indexOf('return withLocalSlot'))
    }
    expect(src).toContain('故意不过槽')
  })

  it('composition root 必须调用 configureLocalSlot；local-slot 自己不许拖 electron 依赖链', async () => {
    const fs = await import('node:fs')
    const main = fs.readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('configureLocalSlot({')
    expect(main).toContain('largestCudaVramMiB(getHardwareInfo().gpus)')
    expect(main).toContain('SLOT_WAIT_PERF_LABEL')

    const slot = fs.readFileSync('src/main/providers/local-slot.ts', 'utf8')
    expect(slot).not.toContain("from '../steward/hardware'")
    expect(slot).not.toContain("from '../steward/perf-probe'")
    expect(slot).not.toContain("'electron'")
  })
})
