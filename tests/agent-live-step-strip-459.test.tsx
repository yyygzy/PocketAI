// @vitest-environment jsdom
// P2 / V4-Iter-459：运行中实时步骤条（与 Agent 调试台共用同一份 chip 流渲染）
//
// 两条底线：
// · 零步骤不占位（还没收到 step 事件、或已结束时整条不渲染）；
// · 同一条实时卡片上步骤推进时，旧 chip 留、新 chip 追加，步号跟着走。
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentLiveStepStrip } from '../src/renderer/src/components/agent/AgentLiveStepStrip'
import type { LiveStep } from '../src/renderer/src/components/agent/agent-shared'
import { HookProviders, mountWithProviders } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'

const step = (stepIndex: number, type: LiveStep['type'], toolName?: string): LiveStep => ({
  stepIndex,
  type,
  ...(toolName ? { toolName } : {})
})

describe('P2 实时步骤条', () => {
  it('零步骤：整条不渲染（没有一条空的运行中占位）', () => {
    mountWithProviders(<AgentLiveStepStrip steps={[]} />)
    expect(screen.queryByTestId('agent-live-step-strip')).toBeNull()
  })

  it('running=false 时同样收起', () => {
    mountWithProviders(<AgentLiveStepStrip steps={[step(1, 'thought')]} running={false} />)
    expect(screen.queryByTestId('agent-live-step-strip')).toBeNull()
  })

  it('步骤推进：先 1 颗，再来 1 颗时旧 chip 保留、新 chip 追加，步号跟着走', () => {
    const { rerender } = render(
      <HookProviders>
        <AgentLiveStepStrip steps={[step(1, 'tool_call', 'fs_read')]} currentStep={1} />
      </HookProviders>
    )
    expect(screen.getByTestId('agent-live-step-strip').textContent).toContain(
      zh['agent.runningStep'].replace('{n}', '1')
    )
    expect(screen.getByTestId('agent-live-step-0').textContent).toContain('fs_read')
    expect(screen.getByTestId('agent-live-step-0').textContent).toContain('#1')
    expect(screen.queryByTestId('agent-live-step-1')).toBeNull()

    rerender(
      <HookProviders>
        <AgentLiveStepStrip
          steps={[step(1, 'tool_call', 'fs_read'), step(2, 'tool_result')]}
          currentStep={2}
        />
      </HookProviders>
    )
    expect(screen.getByTestId('agent-live-step-strip').textContent).toContain(
      zh['agent.runningStep'].replace('{n}', '2')
    )
    // 旧 chip 没有被推进「吃掉」
    expect(screen.getByTestId('agent-live-step-0').textContent).toContain('fs_read')
    expect(screen.getByTestId('agent-live-step-0').textContent).toContain('#1')
    // 新 chip 追加
    expect(screen.getByTestId('agent-live-step-1').textContent).toContain(zh['agent.liveStep.tool_result'])
    expect(screen.getByTestId('agent-live-step-1').textContent).toContain('#2')
  })
})
