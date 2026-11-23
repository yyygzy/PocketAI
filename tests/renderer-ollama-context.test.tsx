// @vitest-environment jsdom
// Ollama 面板大上下文衍生：基础模型已装才出现按钮；点击发正确请求；成功/失败上屏。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { OllamaRuntimeStatus, ModelRecommendation } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const status: OllamaRuntimeStatus = {
  platformSupported: true, installed: true, liveness: 'up', source: 'portable',
  version: '0.40.17', installDir: 'runtime/ollama-win32-x64',
  modelsDir: 'data/ollama-models', downloadUrl: null, downloadBytes: null,
  models: ['qwen3-coder:30b']
}

const rec: ModelRecommendation = {
  tier: 'mainstream' as never, summary: 'mainstream' as never, summaryParams: {},
  localPicks: [],
  coderPick: { id: 'qwen3-coder:30b', reason: 'coder_qwen3_30b' as never, tag: 'coder', installed: true },
  onlineHint: 'highend' as never, ollamaLiveness: 'up', installedModels: ['qwen3-coder:30b'],
  warnings: []
}

const baseStubs = (create: () => unknown) => ({
  getOllamaStatus: () => status,
  getOllamaMirror: () => ({ ok: true, mirror: '' }),
  recommendModels: () => ({ ok: true, data: rec }),
  onOllamaInstallEvent: () => () => {},
  onOllamaPullEvent: () => () => {},
  createOllamaContextModel: create
})

beforeAll(() => { Element.prototype.scrollIntoView = () => {} })

describe('Ollama 面板大上下文衍生', () => {
  it('点击创建 → 请求含 from/model/numCtx，成功显示派生名', async () => {
    stubPocketai(baseStubs(() => ({ ok: true, model: 'qwen3-coder:30b-128k', numCtx: 131072 })) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(screen.queryByTestId('ollama-ctx-create')).not.toBeNull())
    fireEvent.change(screen.getByTestId('ollama-ctx-size'), { target: { value: '131072' } })
    fireEvent.click(screen.getByTestId('ollama-ctx-create'))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeNull())
    expect(screen.getByRole('status')!.textContent).toContain('qwen3-coder:30b-128k')
    const call = pocketaiCalls().find((c) => c.fn === 'createOllamaContextModel')
    expect(call).toBeDefined()
    expect(call!.args[0]).toEqual({ from: 'qwen3-coder:30b', model: 'qwen3-coder:30b-128k', numCtx: 131072 })
  })

  it('尺寸非法 → 本地拦截，不发 IPC', async () => {
    stubPocketai(baseStubs(() => ({ ok: true })) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(screen.queryByTestId('ollama-ctx-size')).not.toBeNull())
    fireEvent.change(screen.getByTestId('ollama-ctx-size'), { target: { value: '999' } })
    fireEvent.click(screen.getByTestId('ollama-ctx-create'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert')!.textContent).toContain(L('ollama.ctxInvalid'))
    expect(pocketaiCalls().filter((c) => c.fn === 'createOllamaContextModel')).toHaveLength(0)
  })

  it('IPC 失败 → 错误上屏，不谎报成功', async () => {
    stubPocketai(baseStubs(() => ({ ok: false, error: 'model not found' })) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(screen.queryByTestId('ollama-ctx-create')).not.toBeNull())
    fireEvent.click(screen.getByTestId('ollama-ctx-create'))
    await waitFor(() => expect(screen.queryByText(/model not found/)).not.toBeNull())
    expect(screen.queryByRole('status')).toBeNull()
  })
})
