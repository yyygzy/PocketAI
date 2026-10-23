// V4-Iter-274：第四面静默名单第七簇——停在字面量默认两发（镜像地址＋pip 源）。
//
// 名单现查 19 条里这一族占两条（逐条原文 data/tmp/silent-274.json）：
//  · `OllamaPanel.tsx:67` 挂载读镜像地址 ⇒ 失败时那一格停在字面量默认值「空串」
//    （§226 第二形态：有东西但那不是你的设置）；
//  · `usePipSource.ts:22` 挂载读 pip 源 ⇒ 失败时那一格停在字面量默认值「官方」
//    （同一形态）。
// 两发的出路现查都是"关掉整个面板再开一次"，按 §268 判据等于没有出口 ⇒ 两发各配一颗重试键；
// 每颗键都有一条用例点它一次（§271 第 24 条）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { McpPanel } from '../src/renderer/src/modules/agent/mcp/McpPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { OllamaRuntimeStatus } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const DEFAULTS = (what: string, msg: string): string =>
  L('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const MIRROR_WHAT = L('ollama.mirror')
const PIP_WHAT = L('agent.f.pipSource')

const STATUS_PROBE = {
  platformSupported: true,
  installed: false,
  running: false,
  models: [],
  modelsDir: '/probe'
} as unknown as OllamaRuntimeStatus

/** 逐发调用次数：每颗键都要被点一次，并钉"只重发自己那一发" */
const calls = { mirror: 0, pipSource: 0 }

beforeEach(() => {
  localStorage.clear()
  calls.mirror = 0
  calls.pipSource = 0
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('① Ollama 面板：镜像地址那一格不再演成"你没设过镜像"', () => {
  const mount = (over: Record<string, (...a: any[]) => unknown> = {}): void => {
    stubPocketai({
      getOllamaStatus: () => STATUS_PROBE,
      getOllamaMirror: () => {
        calls.mirror += 1
        return { ok: true, mirror: 'https://probe.mirror' }
      },
      onOllamaInstallEvent: () => () => {},
      onOllamaPullEvent: () => () => {},
      recommendModels: () => ({ ok: true, data: null }),
      ...over
    })
    mountWithProviders(<OllamaPanel />)
  }

  it('读不到 ⇒ 那句上屏并自带一颗键（这一格没有"点一下就重拉"的出口）', async () => {
    mount({
      getOllamaMirror: () => {
        calls.mirror += 1
        return { ok: false, error: 'MIRROR:镜像通道断了' }
      }
    })
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(MIRROR_WHAT, 'MIRROR:镜像通道断了')]), MOUNT_BUDGET)
    expect(calls.mirror).toBe(1)
  })

  it('那颗键点了有效：只重发镜像这一发，读到即退场、输入框照常见', async () => {
    let fail = true
    mount({
      getOllamaMirror: () => {
        calls.mirror += 1
        return fail ? { ok: false, error: 'MIRROR:镜像通道断了' } : { ok: true, mirror: 'https://probe.mirror' }
      }
    })
    await waitFor(() => expect(alerts()).toHaveLength(1), MOUNT_BUDGET)
    fail = false
    fireEvent.click(screen.getByTestId('ollama-mirror-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calls.mirror, '点一次只多发一次').toBe(2)
  })

  it('反向对照：读到 ⇒ 零 alert、输入框照常摆', async () => {
    mount()
    await waitFor(() => expect(screen.getByDisplayValue('https://probe.mirror')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})

describe('② MCP 面板：pip 源那一格不再演成"你选的就是官方"', () => {
  const mount = (over: Record<string, (...a: any[]) => unknown> = {}): void => {
    stubPocketai({
      listMcpServers: () => [],
      getMcpRuntimes: () => [],
      getPythonPipSource: () => {
        calls.pipSource += 1
        return { ok: true, source: 'tuna' }
      },
      onMcpStatus: () => () => {},
      onMcpLog: () => () => {},
      onPythonEnvEvent: () => () => {},
      listMcpCallLogs: () => [],
      ...over
    })
    mountWithProviders(<McpPanel />)
  }

  it('读不到 ⇒ 那句上屏并自带一颗键（这一格没有"点一下就重拉"的出口）', async () => {
    mount({
      getPythonPipSource: () => {
        calls.pipSource += 1
        return { ok: false, error: 'PIP:pip 源通道断了' }
      }
    })
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(PIP_WHAT, 'PIP:pip 源通道断了')]), MOUNT_BUDGET)
    expect(calls.pipSource).toBe(1)
  })

  it('那颗键点了有效：只重发 pip 源这一发，读到即退场、下拉框照常见', async () => {
    let fail = true
    mount({
      getPythonPipSource: () => {
        calls.pipSource += 1
        return fail ? { ok: false, error: 'PIP:pip 源通道断了' } : { ok: true, source: 'tuna' }
      }
    })
    await waitFor(() => expect(alerts()).toHaveLength(1), MOUNT_BUDGET)
    fail = false
    fireEvent.click(screen.getByTestId('mcp-pip-source-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calls.pipSource, '点一次只多发一次').toBe(2)
  })

  it('反向对照：读到 ⇒ 零 alert、下拉框照常摆', async () => {
    mount()
    await waitFor(() => expect(bodyText()).toContain(L('agent.f.pipTuna')), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})
