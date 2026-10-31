// @vitest-environment jsdom
// §380 真挂载：Ollama 面板那三张脸（跑着／确实没跑／没探出来）各自摆什么
//
// 起点＝缺陷 hunt 候选 #6：`apiGetJson` 的 `catch { return null }` 与 `if (!res.ok) return null`
// 把「连接被拒」「3 秒没答话」「有人听但回 503」「回了却读不出」四类不同事实压成同一个 null，
// 上层 `running:false` ⇒ 面板把"我们不知道"画成"没在跑"，还会摆出 `ollama.noModels`「尚未拉取模型」
// 与那圈安装/启动引导（＝建议用户重装）。
//
// 夹具照 §352 那份 Ollama 面板挂载桩（`load-fail-read-retry-352.test.tsx`）的形状抄，通道一发不多。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act, within } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import { OLLAMA_PROBE_TIMEOUT_MS } from '../src/shared/ollama-probe'
import type { OllamaLiveness, OllamaRuntimeStatus } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const RETRY = L('agent.retryRead')
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

/** 生产里 `t()` 的插值语义：把 `{seconds}` 换成真数字。测试自己插一遍，不放宽断言（§379 同款） */
const T = (key: string, params: Record<string, number>): string =>
  Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(new RegExp('\\{' + k + '\\}', 'g'), () => String(v)),
    L(key)
  )
const UNKNOWN_MSG = T('ollama.probeUnknown', { seconds: OLLAMA_PROBE_TIMEOUT_MS / 1000 })

const status = (liveness: OllamaLiveness): OllamaRuntimeStatus => ({
  platformSupported: true,
  installed: true,
  liveness,
  source: liveness === 'up' ? 'portable' : null,
  version: liveness === 'up' ? '0.9.9' : null,
  installDir: 'runtime/ollama-test',
  modelsDir: 'data/ollama-models',
  downloadUrl: null,
  downloadBytes: null,
  // §380：主进程在非 up 那一支根本不取清单 ⇒ 这里给空数组是"没去取"，界面不许把它读成"一个模型都没有"
  models: []
})

const stubs = (fn: () => unknown): Record<string, unknown> => ({
  getOllamaStatus: fn,
  getOllamaMirror: () => ({ ok: true, mirror: '' }),
  recommendModels: () => ({ ok: true, data: null }),
  startOllama: () => ({ ok: true }),
  stopOllama: () => ({ ok: true }),
  onOllamaInstallEvent: () => () => { /* 订阅卸载函数 */ },
  onOllamaPullEvent: () => () => { /* 订阅卸载函数 */ }
})

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

describe('① 没探出来（unknown）那一档：说一句"无法确认"，但不再摆出"尚未拉取模型"', () => {
  it('那句上屏、数字是插进去的（屏上不许留 {seconds} 模板）、键在同屏且位于 alert 外面', async () => {
    stubPocketai(stubs(() => status('unknown')) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(alerts()).toEqual([UNKNOWN_MSG])
    // 字典里确实是占位符（不是把 3 抄进四本字典），而屏上那颗是插进去的数
    expect(L('ollama.probeUnknown')).toContain('{seconds}')
    expect(UNKNOWN_MSG).not.toContain('{')
    expect(UNKNOWN_MSG).toContain('3')
    const key = screen.getByTestId('ollama-liveness-retry')
    expect(key.textContent).toBe(RETRY)
    // §268 的判据在这里要**换强的、不换弱的**：那句文案自己就含"重试"两个字（"可以重试"是给用户看的出路），
    // 所以"alert 文本里不许出现键名"这条子串判据在本处不成立——改成结构判据：那颗键不是 alert 盒子的后代。
    // 键与句子仍是兄弟（盒子外面），上一条的逐值相等也仍然钉着盒子里只有那一句。
    const box = screen.getByRole('alert')
    expect(within(box).queryByRole('button')).toBeNull()
    expect(box.parentElement?.contains(key)).toBe(true)
  })

  it('这一档不许把清单那圈摆出来（`ollama.noModels` 与拉取那颗都不在场），绿色来源徽标与停止键也不在场', async () => {
    stubPocketai(stubs(() => status('unknown')) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(screen.queryByText(L('ollama.noModels'), { exact: false })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(L('ollama.pullBtn')) })).toBeNull()
    expect(screen.queryByText(L('ollama.portableSource'), { exact: false })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(L('ollama.stop')) })).toBeNull()
  })

  it('但操作区仍然在场（那颗"启动"点得动）——"不知道"不该把出路一起藏掉', async () => {
    stubPocketai(stubs(() => status('unknown')) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(screen.queryByRole('button', { name: new RegExp(L('ollama.start')) })).not.toBeNull()
  })

  it('按那颗重试键⇒真再发一发；下一发答上了话⇒那句与键一起撤，绿色徽标与清单那圈回来', async () => {
    stubPocketai(stubs(() => status('unknown')) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(alerts()).toEqual([UNKNOWN_MSG])

    stubPocketai(stubs(() => status('up')) as never)
    fireEvent.click(screen.getByTestId('ollama-liveness-retry'))
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('ollama-liveness-retry')).toBeNull()
    expect(screen.getAllByText(L('ollama.portableSource'), { exact: false }).length).toBeGreaterThan(0)
  })
})

describe('② 反向对照：另外两档都不许出现那句', () => {
  it('确实没人听（down）：没有"无法确认"那句，安装/启动引导照常（这才是它该出现的场合）', async () => {
    stubPocketai(stubs(() => status('down')) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('ollama-liveness-retry')).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(L('ollama.start')) })).not.toBeNull()
  })

  it('跑着（up）：正向对照——清单那圈真的会摆出来（说明上面那条"不在场"是有牙的判据，不是恒真）', async () => {
    stubPocketai(stubs(() => status('up')) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('ollama-liveness-retry')).toBeNull()
    expect(screen.queryByText(L('ollama.noModels'), { exact: false })).not.toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(L('ollama.stop')) })).toBeTruthy()
  })
})
