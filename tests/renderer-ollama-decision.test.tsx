// @vitest-environment jsdom
// Ollama 面板 Jev 决策区真挂载：空文本拦截、成功渲染三种题型、失败上屏（IPC 不许静默）。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns, pocketaiCalls } from './helpers/renderer'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { OllamaRuntimeStatus } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const status: OllamaRuntimeStatus = {
  platformSupported: true,
  installed: true,
  liveness: 'up',
  source: 'portable',
  version: '0.40.17',
  installDir: 'runtime/ollama-win32-x64',
  modelsDir: 'data/ollama-models',
  downloadUrl: null,
  downloadBytes: null,
  models: ['nimble']
}

const baseStubs = (systemOne: () => unknown) => ({
  getOllamaStatus: () => status,
  getOllamaMirror: () => ({ ok: true, mirror: '' }),
  recommendModels: () => ({ ok: true, data: null }),
  onOllamaInstallEvent: () => () => {},
  onOllamaPullEvent: () => () => {},
  runOllamaSystemOne: systemOne
})

const okData = {
  model: 'nimble',
  answers: {
    team: { type: 'choice', choice: 'billing', confidence: 0.92 },
    refund: { type: 'noul', noul: 0.99 },
    urgency: { type: 'score', score: 0.8 }
  },
  usage: { input_tokens: 10, output_tokens: 4 }
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

describe('Ollama 面板 Jev 决策区', () => {
  it('未填文本就运行 → 本地拦截，不发 IPC', async () => {
    stubPocketai(baseStubs(() => ({ ok: true, data: okData })) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(screen.queryByTestId('ollama-decision-run')).not.toBeNull())
    fireEvent.click(screen.getByTestId('ollama-decision-run'))
    await waitFor(() => expect(screen.getByText(new RegExp(L('ollama.decisionStateRequired')))).not.toBeNull())
    expect(calledFns().filter((f) => f === 'runOllamaSystemOne')).toHaveLength(0)
  })

  it('成功 → 三种题型与 usage 上屏，请求带工单文本与三种题目要求', async () => {
    stubPocketai(baseStubs(() => ({ ok: true, data: okData })) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(screen.queryByTestId('ollama-decision-state')).not.toBeNull())
    fireEvent.change(screen.getByTestId('ollama-decision-state'), { target: { value: 'charged twice' } })
    fireEvent.click(screen.getByTestId('ollama-decision-run'))
    await waitFor(() => expect(screen.queryByTestId('ollama-decision-result')).not.toBeNull())
    expect(screen.getByTestId('ollama-decision-result').textContent).toContain('billing')
    expect(screen.getByTestId('ollama-decision-result').textContent).toContain('10 / 4')
    const call = pocketaiCalls().find((c) => c.fn === 'runOllamaSystemOne')
    expect(call).toBeDefined()
    const req = call!.args[0] as { model: string; state: Record<string, string>; questions: Record<string, { type: string }> }
    expect(req.model).toBe('tev1:0.8b')
    expect(req.state.ticket).toBe('charged twice')
    expect(Object.values(req.questions).map((q) => q.type).sort()).toEqual(['choice', 'noul', 'score'])
  })

  it('IPC 返回 {ok:false} → 错误上屏，不谎报有结果', async () => {
    stubPocketai(baseStubs(() => ({ ok: false, error: 'model "nimble" not found' })) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(screen.queryByTestId('ollama-decision-state')).not.toBeNull())
    fireEvent.change(screen.getByTestId('ollama-decision-state'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('ollama-decision-run'))
    await waitFor(() => expect(screen.getByText(/model "nimble" not found/)).not.toBeNull())
    expect(screen.queryByTestId('ollama-decision-result')).toBeNull()
  })
})
