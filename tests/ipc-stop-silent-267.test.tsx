// @vitest-environment jsdom
// V4-Iter-267：第六面静默桶第三簇——拉模型那颗「✕ 中断」。
//
// §265 量出这一族的两条轴，§266 收了"用户点的键"里那三颗，剩下这颗（`useOllamaPull.ts` 的 `abortOllamaPull`）本批收掉。
// 探针读数（改之前）：那一发回 `{ok:false}` 时 **alerts 空、✕ 还在、进度条那一行还在走、console.warn 也是 0 条**——
// 连 §266 那三处的"至少进一次 console"都没有，因为值是**整个丢弃**的（`safeHandle` 的失败不是 rejection，`.catch` 接不住）。
//
// 形状沿 §266 那三处（这颗键也是"句子在场时键还挂着"）：**不配重试键**、**只说后果不指出路**、
// **随那一发落定作废**（下载真结束了还说"可能还在继续"＝新的谎）。
// 两屏都真挂载（设置页那块面板＋管家页推荐卡片那一格）⇒ 本批没有"只有源码级判据"那一档。
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ModelRecommendation, OllamaRuntimeStatus } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const STOPPED = (msg: string): string => L('common.stopNotSent').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
/** 挂载＋导航（点拉取、按 ✕）由界面驱动 ⇒ 用有界预算，满载时 1s 会先崩（§261／§264 那条） */
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const ABORT_KEY = `✕ ${L('ollama.abort')}`
const PULL_BTN = L('ollama.pullBtn')
const REASON = 'IPC_TIMEOUT:中止超时'
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

/** 拉取那一发开成可控闸门：用例自己决定它什么时候（不）落定 */
const pullGate = (): { promise: Promise<unknown>; resolve: (v: unknown) => void } => {
  let resolve!: (v: unknown) => void
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const status = (): OllamaRuntimeStatus => ({
  platformSupported: true, installed: true, running: true, source: 'portable', version: '0.9.9',
  installDir: 'runtime/ollama-test', modelsDir: 'data/ollama-models', downloadUrl: null, downloadBytes: null, models: []
})

type Impl = (...a: unknown[]) => unknown

const panelStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  getOllamaStatus: () => status(),
  getOllamaMirror: () => ({ ok: true, mirror: '' }),
  recommendModels: () => ({ ok: true, data: null }),
  onOllamaInstallEvent: () => () => { /* 订阅卸载函数 */ },
  onOllamaPullEvent: () => () => { /* 订阅卸载函数 */ },
  pullOllamaModel: () => new Promise(() => { /* 默认挂住：下载还在继续 */ }),
  ...over
})

/** 走到"正在拉取"那一格（两屏共用同一颗 ✕，键的文案一致） */
const startPullInPanel = async (): Promise<void> => {
  await waitFor(() => expect(screen.queryByText(PULL_BTN)).not.toBeNull(), MOUNT_BUDGET)
  fireEvent.change(screen.getByPlaceholderText(L('ollama.pullPlaceholder')), { target: { value: 'qwen3:0.6b' } })
  fireEvent.click(screen.getByText(PULL_BTN))
  await waitFor(() => expect(screen.queryByText(ABORT_KEY)).not.toBeNull(), MOUNT_BUDGET)
}

describe('① 设置页那块面板：✕ 没送到要说一句，且这句只在拉取还在场时挂着', () => {
  it('回 {ok:false} ⇒ 那句上屏、✕ 仍在（再按一次就是重发，所以不另配重试键）、不谎报已停', async () => {
    stubPocketai(panelStubs({ abortOllamaPull: () => ({ ok: false, error: REASON }) }))
    mountWithProviders(<OllamaPanel />)
    await startPullInPanel()
    expect(alerts()).toEqual([])
    fireEvent.click(screen.getByText(ABORT_KEY))
    await waitFor(() => expect(alerts()).toEqual([STOPPED(REASON)]), MOUNT_BUDGET)
    // 不阻断也不"改成已停"：✕ 与进度那一行都还在原位
    expect(screen.queryAllByText(ABORT_KEY)).toHaveLength(1)
    expect(screen.queryByText(L('ollama.pullBtn'))).toBeNull()
    expect(screen.queryAllByText(L('ollama.pulling'), { exact: false }).length).toBeGreaterThan(0)
    expect(toasts()).toEqual([])
  })

  it('reject 面 ⇒ 同一句、用的是抛出的原文（旧写法那条 `.catch(reportIpcError(...))` 只进 console，屏上零字）', async () => {
    stubPocketai(panelStubs({ abortOllamaPull: () => Promise.reject(new Error('通道被拆了')) }))
    mountWithProviders(<OllamaPanel />)
    await startPullInPanel()
    fireEvent.click(screen.getByText(ABORT_KEY))
    await waitFor(() => expect(alerts()).toEqual([STOPPED('通道被拆了')]), MOUNT_BUDGET)
  })

  it('再按一次这回落成功 ⇒ 那句退场（它讲的是上一发）', async () => {
    let first = true
    stubPocketai(panelStubs({
      abortOllamaPull: () => {
        if (first) { first = false; return { ok: false, error: REASON } }
        return { ok: true }
      }
    }))
    mountWithProviders(<OllamaPanel />)
    await startPullInPanel()
    fireEvent.click(screen.getByText(ABORT_KEY))
    await waitFor(() => expect(alerts()).toEqual([STOPPED(REASON)]), MOUNT_BUDGET)
    fireEvent.click(screen.getByText(ABORT_KEY))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calledFns().filter((f) => f === 'abortOllamaPull')).toHaveLength(2)
  })

  it('反向对照：✕ 一次就送到 ⇒ 一个 alert 都不许有（那句不是常驻装饰）', async () => {
    stubPocketai(panelStubs({ abortOllamaPull: () => ({ ok: true }) }))
    mountWithProviders(<OllamaPanel />)
    await startPullInPanel()
    fireEvent.click(screen.getByText(ABORT_KEY))
    await settle()
    await settle()
    expect(alerts()).toEqual([])
  })

  it('那一发随后自己落定 ⇒ 那句必须作废（下载都结束了还说"可能还在继续"＝新的谎）', async () => {
    const gate = pullGate()
    stubPocketai(panelStubs({
      pullOllamaModel: () => gate.promise,
      abortOllamaPull: () => ({ ok: false, error: REASON })
    }))
    mountWithProviders(<OllamaPanel />)
    await startPullInPanel()
    fireEvent.click(screen.getByText(ABORT_KEY))
    await waitFor(() => expect(alerts()).toEqual([STOPPED(REASON)]), MOUNT_BUDGET)
    await act(async () => { gate.resolve({ ok: true }) })
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    // 落定后回到"拉取"那颗键原位（原来的界面行为不变）
    expect(screen.queryByText(ABORT_KEY)).toBeNull()
  })
})

describe('② 管家页推荐卡片那一格：同一颗 ✕，同一句', () => {
  // 夹具形状照抄 §255 那份（缺字段会让渲染当场 TypeError，与"桩按返回类型写死"同一条教训）
  const hardwareSample = {
    os: { platform: 'win32', release: '10.0', arch: 'x64', hostname: 'BOX' },
    cpu: { model: 'X', cores: 8 },
    memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
    gpus: [],
    disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
  }
  const healthSample = {
    totalConversations: 3, totalMessages: 12, kbCount: 1, totalAttachmentsBytes: 0,
    orphanMessages: 0, orphanChunks: 0
  }
  const RECO: ModelRecommendation = {
    tier: 'entry', summary: 'cpu_low', summaryParams: {},
    localPicks: [{ id: 'PROBE-PICK:latest', tag: 'primary', reason: 'qwen3b_q4_lowvram', installed: false }],
    onlineHint: 'low_end', ollamaRunning: true, installedModels: [], warnings: []
  }
  const stewardStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
    getHardwareInfo: () => ({ ok: true, data: hardwareSample }),
    checkIntegrity: () => ({ ok: true, data: { ok: true, details: 'ok' } }),
    getHealthReport: () => ({ ok: true, data: healthSample }),
    getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
    recommendModels: () => ({ ok: true, data: RECO }),
    onOllamaPullEvent: () => () => { /* 订阅卸载函数 */ },
    pullOllamaModel: () => new Promise(() => { /* 挂住 */ }),
    ...over
  })

  const startPullInCard = async (): Promise<void> => {
    await waitFor(() => expect(screen.queryByText('⬇️ ' + PULL_BTN)).not.toBeNull(), MOUNT_BUDGET)
    fireEvent.click(screen.getByText('⬇️ ' + PULL_BTN))
    await waitFor(() => expect(screen.queryByText(ABORT_KEY)).not.toBeNull(), MOUNT_BUDGET)
  }

  it('✕ 没送到 ⇒ 那一格里出现同一句，且 ✕ 仍在原位（再按一次就是重发）', async () => {
    stubPocketai(stewardStubs({ abortOllamaPull: () => ({ ok: false, error: REASON }) }))
    mountWithProviders(<StewardModule />)
    await startPullInCard()
    expect(alerts()).toEqual([])
    fireEvent.click(screen.getByText(ABORT_KEY))
    await waitFor(() => expect(alerts()).toEqual([STOPPED(REASON)]), MOUNT_BUDGET)
    expect(screen.queryAllByText(ABORT_KEY)).toHaveLength(1)
  })

  it('反向对照：一次就送到 ⇒ 零 alert；那一发随后落定也不该冒出这句', async () => {
    const gate = pullGate()
    stubPocketai(stewardStubs({
      pullOllamaModel: () => gate.promise,
      abortOllamaPull: () => ({ ok: true })
    }))
    mountWithProviders(<StewardModule />)
    await startPullInCard()
    fireEvent.click(screen.getByText(ABORT_KEY))
    await settle()
    await settle()
    expect(alerts()).toEqual([])
    await act(async () => { gate.resolve({ ok: true }) })
    await settle()
    expect(alerts()).toEqual([])
  })
})
