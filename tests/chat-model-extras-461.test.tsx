// @vitest-environment jsdom
// P4 批次 0 / V4-Iter-461：模型级配置迁入对话壳顶栏（窗口 / 备用链 / 文本协议徽标）
//
// 三条断言：
// · 三颗徽标都按主目标（targets[0]）读写，不是"注册表全量"；
// · 写回走既有 set 通道（不做本地乐观更新，以后端回传表为准）；
// · 读不到时徽标说"读不到"，不演成"没设过"。
import { describe, expect, it } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ProviderRecord, ChatTarget } from '../src/shared/types'
import { ChatModelExtras } from '../src/renderer/src/modules/chat/ChatModelExtras'
import { useAgentModelExtras } from '../src/renderer/src/modules/chat/useAgentModelExtras'
import { modelWindowKey } from '../src/shared/model-window'
import { fallbackTargetKey } from '../src/shared/fallback-target'
import { calledFns, mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'

const providers = [
  { id: 'p1', name: '甲', enabled: true, models: ['m1'] },
  { id: 'p2', name: '乙', enabled: true, models: ['m2'] }
] as unknown as ProviderRecord[]
const targets: ChatTarget[] = [{ providerId: 'p1', model: 'm1' }] as ChatTarget[]

const stubReads = (over: Record<string, unknown> = {}): void => {
  stubPocketai({
    getModelContextWindows: () => ({ [modelWindowKey('p1', 'm1')]: 64000 }),
    getFallbackTargets: () => ({ [fallbackTargetKey('p1', 'm1')]: { providerId: 'p2', model: 'm2' } }),
    getAgentTextProtocol: () => [],
    ...over
  })
}

function Harness(): React.ReactElement {
  const primary = targets[0]
  const extras = useAgentModelExtras(primary?.providerId ?? '', primary?.model ?? '', providers)
  return <ChatModelExtras providers={providers} targets={targets} extras={extras} />
}

function mount() {
  return mountWithProviders(<Harness />)
}

describe('P4 批次 0：对话壳模型级徽标', () => {
  it('按主目标读取三张表：窗口/备用已设、文本协议未点名', async () => {
    stubReads()
    mount()
    const badge = await screen.findByTestId('agent-window-badge')
    expect(badge.textContent).toContain('64000')
    await waitFor(() => expect(screen.getByTestId('agent-fallback-badge').textContent).toContain('m2'))
    expect(screen.getByTestId('chat-text-protocol-badge')).toBeTruthy()
    for (const fn of ['getModelContextWindows', 'getFallbackTargets', 'getAgentTextProtocol']) {
      expect(calledFns()).toContain(fn)
    }
  })

  it('窗口编辑器保存走 setModelContextWindow(主目标)', async () => {
    stubReads({ setModelContextWindow: () => ({ windows: {} }) })
    mount()
    fireEvent.click(await screen.findByTestId('agent-window-badge'))
    const input = screen.getByLabelText('窗口') as HTMLInputElement
    fireEvent.change(input, { target: { value: '32000' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(
        pocketaiCalls().some(
          (c) => c.fn === 'setModelContextWindow' && c.args[0] === 'p1' && c.args[1] === 'm1' && c.args[2] === 32000
        )
      ).toBe(true)
    )
  })

  it('文本协议徽标点击走 setAgentTextProtocol，并以后端回传清单为准', async () => {
    stubReads({ setAgentTextProtocol: () => [`p1::m1`] })
    mount()
    fireEvent.click(await screen.findByTestId('chat-text-protocol-badge'))
    await waitFor(() =>
      expect(
        pocketaiCalls().some(
          (c) => c.fn === 'setAgentTextProtocol' && c.args[0] === 'p1' && c.args[1] === 'm1' && c.args[2] === true
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.getByTestId('chat-text-protocol-badge').textContent).toContain('文本协议已启用')
    )
  })

  it('读不到窗口时徽标说读不到，不演成未设', async () => {
    stubReads({ getModelContextWindows: () => ({ ok: false, error: 'boom' }) })
    mount()
    const badge = await screen.findByTestId('agent-window-badge')
    await waitFor(() => expect(badge.textContent).not.toContain('未设'))
    expect(badge.getAttribute('title')).toContain('boom')
  })
})
