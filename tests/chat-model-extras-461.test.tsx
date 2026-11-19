// @vitest-environment jsdom
// P4 批次 0 / V4-Iter-461：模型级配置（窗口 / 备用链 / 文本协议）
//
// V4 交互改造后这三项从顶栏徽标收进输入区「+ → 模型」分组；断言口径不变：
// · 三项都按主目标（targets[0]）读写，不是"注册表全量"；
// · 写回走既有 set 通道（不做本地乐观更新，以后端回传表为准）；
// · 读不到时说"读不到"，不演成"没设过"。
import { describe, expect, it } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ProviderRecord, ChatTarget } from '../src/shared/types'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import { useAgentModelExtras } from '../src/renderer/src/modules/chat/useAgentModelExtras'
import { modelWindowKey } from '../src/shared/model-window'
import { fallbackTargetKey } from '../src/shared/fallback-target'
import { calledFns, mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'

const providers = [
  { id: 'p1', name: '甲', enabled: true, models: ['qwen3-8b'] },
  { id: 'p2', name: '乙', enabled: true, models: ['m2'] }
] as unknown as ProviderRecord[]
const targets: ChatTarget[] = [{ providerId: 'p1', model: 'qwen3-8b' }] as ChatTarget[]

const stubReads = (over: Record<string, unknown> = {}): void => {
  stubPocketai({
    getModelContextWindows: () => ({ [modelWindowKey('p1', 'qwen3-8b')]: 64000 }),
    getFallbackTargets: () => ({ [fallbackTargetKey('p1', 'qwen3-8b')]: { providerId: 'p2', model: 'm2' } }),
    getAgentTextProtocol: () => [],
    getAgentThinkingDisabled: () => [],
    listPromptSnippets: () => [],
    ...over
  })
}

function Harness(): React.ReactElement {
  const primary = targets[0]
  const extras = useAgentModelExtras(primary?.providerId ?? '', primary?.model ?? '', providers)
  return (
    <Composer
      streaming={false}
      canSend
      onSend={() => { /* 本组不断言发送 */ }}
      onStop={() => { /* 同上 */ }}
      draftKey="conv-1"
      providers={providers}
      targets={targets}
      modelExtras={extras}
    />
  )
}

function mount() {
  return mountWithProviders(<Harness />)
}

const openPlus = (): void => {
  fireEvent.click(screen.getByTestId('composer-plus-open'))
}

describe('P4 批次 0：「+ → 模型」三项按主目标读写', () => {
  it('按主目标读取三张表：窗口/备用已设、文本协议未点名', async () => {
    stubReads()
    mount()
    openPlus()
    const windowRow = await screen.findByTestId('composer-plus-window')
    await waitFor(() => expect(windowRow.textContent).toContain('64000'))
    await waitFor(() => expect(screen.getByTestId('composer-plus-fallback').textContent).toContain('m2'))
    expect(screen.getByTestId('composer-plus-text-protocol').textContent).toContain('未启用')
    for (const fn of ['getModelContextWindows', 'getFallbackTargets', 'getAgentTextProtocol', 'getAgentThinkingDisabled']) {
      expect(calledFns()).toContain(fn)
    }
  })

  it('窗口编辑器保存走 setModelContextWindow(主目标)', async () => {
    stubReads({ setModelContextWindow: () => ({ windows: {} }) })
    mount()
    openPlus()
    fireEvent.click(await screen.findByTestId('composer-plus-window'))
    const input = screen.getByLabelText('窗口') as HTMLInputElement
    fireEvent.change(input, { target: { value: '32000' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(
        pocketaiCalls().some(
          (c) => c.fn === 'setModelContextWindow' && c.args[0] === 'p1' && c.args[1] === 'qwen3-8b' && c.args[2] === 32000
        )
      ).toBe(true)
    )
  })

  it('文本协议那一行点击走 setAgentTextProtocol，并以后端回传清单为准', async () => {
    stubReads({ setAgentTextProtocol: () => [`p1::qwen3-8b`] })
    mount()
    openPlus()
    fireEvent.click(await screen.findByTestId('composer-plus-text-protocol'))
    await waitFor(() =>
      expect(
        pocketaiCalls().some(
          (c) => c.fn === 'setAgentTextProtocol' && c.args[0] === 'p1' && c.args[1] === 'qwen3-8b' && c.args[2] === true
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.getByTestId('composer-plus-text-protocol').textContent).toContain('文本协议已启用')
    )
  })

  it('思考开关那一行：默认显示服务端默认，点击走 setAgentThinkingDisabled(主目标) 并以后端回传清单为准', async () => {
    stubReads({ setAgentThinkingDisabled: () => [`p1::qwen3-8b`] })
    mount()
    openPlus()
    const row = await screen.findByTestId('composer-plus-thinking')
    expect(row.textContent).toContain('服务端默认')
    fireEvent.click(row)
    await waitFor(() =>
      expect(
        pocketaiCalls().some(
          (c) =>
            c.fn === 'setAgentThinkingDisabled' &&
            c.args[0] === 'p1' &&
            c.args[1] === 'qwen3-8b' &&
            c.args[2] === true
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.getByTestId('composer-plus-thinking').textContent).toContain('已关闭')
    )
  })

  it('读不到窗口时那一行说读不到，不演成未设', async () => {
    stubReads({ getModelContextWindows: () => ({ ok: false, error: 'boom' }) })
    mount()
    openPlus()
    const row = await screen.findByTestId('composer-plus-window')
    await waitFor(() => expect(row.textContent).not.toContain('未设'))
    expect(row.getAttribute('title')).toContain('boom')
  })
})
