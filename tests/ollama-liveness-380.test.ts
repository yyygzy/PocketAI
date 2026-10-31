// §380 行为层：11434 探测的三态分类，以及管家页那半张脸（徽标与那条告警码）各落到哪一态
//
// 起点＝缺陷 hunt 候选 #6「Ollama 探测超时画成『已停止』」。回读发现同一把谎有**两处独立探针**：
//  · `main/ollama/ollama-runtime.ts` 的 `apiGetJson`（catch 一律 return null）→ 面板那圈；
//  · `main/steward/model-recommend.ts` 的 `probeOllamaModels`（catch 一律 running:false）→ 管家徽标＋`no_ollama` 那句。
// 后者本来还自相矛盾：非 2xx 说 `running:true`，超时却说 `running:false` ⇒ 本文件把它判成同一个 `unknown`。
//
// 本机实测（`data/tmp/probe-380-ollama.mjs`）给的证据形状：
//  ① 端口没人听 ⇒ `TypeError: fetch failed` + `cause.code=ECONNREFUSED`
//  ② 到点没答话 ⇒ `AbortError` "This operation was aborted"
//  ⇒ 分类器的判据是"操作系统有没有明确说这里没人接"，其余一律「不知道」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HardwareInfo } from '../src/shared/types'
import { classifyProbeFailure, OLLAMA_PROBE_TIMEOUT_MS } from '../src/shared/ollama-probe'

const GB = 1024 * 1024 * 1024

vi.mock('../src/main/steward/hardware', () => ({
  getHardwareInfo: (): HardwareInfo => ({
    cpu: { model: 'x', cores: 4, threads: 8 },
    memory: { total: 16 * GB, free: 8 * GB },
    gpus: [],
    disk: {
      type: 'ssd',
      removable: false,
      drive: 'C:',
      volumeLabel: null,
      filesystem: null,
      totalSpace: null,
      freeSpace: null,
      mediumType: null,
      busType: null
    },
    os: { platform: 'win32', release: '10', arch: 'x64' }
  }) as HardwareInfo
}))

import { recommendModels } from '../src/main/steward/model-recommend'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 把 `/api/tags` 那一发按五种真实形状之一桩掉 */
function stubProbe(shape: 'up' | 'refused' | 'abort' | '503' | 'bad-json'): void {
  fetchMock.mockImplementation(async () => {
    if (shape === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (shape === 'abort') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    if (shape === '503') return new Response(null, { status: 503 })
    if (shape === 'bad-json') return new Response('<html>gateway</html>', { status: 200 })
    return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
}

describe('① classifyProbeFailure：只有"明确没人接"才算 down', () => {
  it('cause.code=ECONNREFUSED → down（本机实测 11434 没跑时就是这个形状）', () => {
    expect(classifyProbeFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('down')
  })

  it('cause.code=EADDRNOTAVAIL → down（地址根本发不出去，同样是否定证据）', () => {
    expect(classifyProbeFailure(Object.assign(new Error('connect'), { cause: { code: 'EADDRNOTAVAIL' } }))).toBe('down')
  })

  it('AbortError（超时）→ unknown：3 秒没答话不是"没运行"的证明', () => {
    expect(classifyProbeFailure(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBe('unknown')
  })

  it('认不出的形状一律 unknown：顶层 code、无 cause、抛字符串、抛 undefined', () => {
    expect(classifyProbeFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('unknown')
    expect(classifyProbeFailure(new Error('socket hang up'))).toBe('unknown')
    expect(classifyProbeFailure('boom')).toBe('unknown')
    expect(classifyProbeFailure(undefined)).toBe('unknown')
  })

  it('反向对照：ECONNREFUSED 与 ECONNRESET 必须分出两档（否则整个分类器只是把一切都说成 unknown）', () => {
    const refused = classifyProbeFailure(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))
    const reset = classifyProbeFailure(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))
    expect(refused).toBe('down')
    expect(reset).toBe('unknown')
    expect(refused).not.toBe(reset)
  })
})

describe('② recommendModels：三态各说哪句话', () => {
  it('答上了话 → liveness=up，已装清单有值，两条 Ollama 告警都不出现', async () => {
    stubProbe('up')
    const r = await recommendModels()
    expect(r.ollamaLiveness).toBe('up')
    expect(r.installedModels).toEqual(['qwen2.5:7b'])
    expect(r.warnings).not.toContain('no_ollama')
    expect(r.warnings).not.toContain('ollama_unknown')
  })

  it('端口没人听 → liveness=down＋只推 no_ollama（那句"安装并启动"这时才说得出口）', async () => {
    stubProbe('refused')
    const r = await recommendModels()
    expect(r.ollamaLiveness).toBe('down')
    expect(r.warnings).toContain('no_ollama')
    expect(r.warnings).not.toContain('ollama_unknown')
  })

  it('探测超时 → liveness=unknown＋只推 ollama_unknown（改前这里推的是 no_ollama，教用户去重装）', async () => {
    stubProbe('abort')
    const r = await recommendModels()
    expect(r.ollamaLiveness).toBe('unknown')
    expect(r.warnings).toContain('ollama_unknown')
    expect(r.warnings).not.toContain('no_ollama')
  })

  it('有人监听却回 503 → unknown（改前那一支写的是 running:true＝另一头的谎，两半现在同轴）', async () => {
    stubProbe('503')
    const r = await recommendModels()
    expect(r.ollamaLiveness).toBe('unknown')
    expect(r.warnings).toContain('ollama_unknown')
    expect(r.warnings).not.toContain('no_ollama')
  })

  it('回了 200 但 JSON 读不出 → unknown（读不出不等于没有模型，也不等于没在跑）', async () => {
    stubProbe('bad-json')
    const r = await recommendModels()
    expect(r.ollamaLiveness).toBe('unknown')
    expect(r.installedModels).toEqual([])
  })

  it('两枚 Ollama 告警码互斥：任何一种形状都不许同时推两句（同屏自相矛盾）', async () => {
    for (const shape of ['up', 'refused', 'abort', '503', 'bad-json'] as const) {
      stubProbe(shape)
      const r = await recommendModels()
      const n = r.warnings.filter((w) => w === 'no_ollama' || w === 'ollama_unknown').length
      expect(n, `${shape} 那一发同时推了 ${n} 句`).toBe(shape === 'up' ? 0 : 1)
    }
  })
})

describe('③ 面板那句提示的等待预算与探针同源', () => {
  it('shared 常量是 3000ms ⇒ 界面上报的是 3 秒', () => {
    expect(OLLAMA_PROBE_TIMEOUT_MS).toBe(3000)
  })

  it('反向对照：那个数不是随便一颗占位（改 1 个数就会改屏上那句）', () => {
    expect(OLLAMA_PROBE_TIMEOUT_MS / 1000).toBe(3)
    expect(OLLAMA_PROBE_TIMEOUT_MS / 1000).not.toBe(2)
  })
})
