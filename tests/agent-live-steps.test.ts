// Agent 运行实时步骤条 liveSteps 归约纯函数测试
import { describe, expect, it } from 'vitest'
import { reduceLiveSteps, LIVE_STEPS_MAX, type LiveStep } from '../src/renderer/src/modules/agent/agent-shared'

const ev = (stepIndex: number, type: string, toolName?: string, args?: string, callId = 'tc1') => ({
  stepIndex,
  type,
  toolCall: toolName
    ? { id: callId, type: 'function' as const, function: { name: toolName, arguments: args ?? '{}' } }
    : undefined
})

describe('reduceLiveSteps', () => {
  it('白名单类型追加 chip；工具步携带工具名', () => {
    let steps: LiveStep[] = []
    steps = reduceLiveSteps(steps, ev(1, 'thought'))
    steps = reduceLiveSteps(steps, ev(1, 'tool_call', 'shell_exec'))
    steps = reduceLiveSteps(steps, ev(1, 'tool_result'))
    expect(steps).toEqual([
      { stepIndex: 1, type: 'thought', toolName: undefined, role: undefined, callId: undefined },
      { stepIndex: 1, type: 'tool_call', toolName: 'shell_exec', role: undefined, callId: 'tc1' },
      { stepIndex: 1, type: 'tool_result', toolName: undefined, role: undefined, callId: undefined }
    ])
  })

  it('非白名单类型（user/todo/final）原样返回（引用不变）', () => {
    const prev: LiveStep[] = [{ stepIndex: 1, type: 'thought' }]
    for (const t of ['user', 'todo', 'final']) {
      expect(reduceLiveSteps(prev, ev(2, t))).toBe(prev)
    }
  })

  it('同 stepIndex 同类型覆盖（thought 占位→正式不重复）', () => {
    let steps: LiveStep[] = []
    steps = reduceLiveSteps(steps, ev(1, 'thought'))
    steps = reduceLiveSteps(steps, ev(1, 'thought'))
    expect(steps).toHaveLength(1)
    // 同 index 不同类型不覆盖
    steps = reduceLiveSteps(steps, ev(1, 'tool_call', 'x'))
    expect(steps).toHaveLength(2)
  })

  it('同一步里的两条**不同调用**各留一条 chip（145 的并行委派；按 callId 去重，不按"同步骤同类型"）', () => {
    let steps: LiveStep[] = []
    steps = reduceLiveSteps(steps, ev(2, 'tool_call', 'delegate_task', '{"role":"researcher","task":"a"}', 'call_a'))
    steps = reduceLiveSteps(steps, ev(2, 'tool_call', 'delegate_task', '{"role":"writer","task":"b"}', 'call_b'))
    expect(steps).toHaveLength(2)
    expect(steps.map((s) => s.role)).toEqual(['researcher', 'writer'])
    // 反向对照：同一个 callId 再来一次（重试/重复 emit）仍然只留一条
    steps = reduceLiveSteps(steps, ev(2, 'tool_call', 'delegate_task', '{"role":"writer","task":"b"}', 'call_b'))
    expect(steps).toHaveLength(2)
  })

  it('超出上限丢最旧', () => {
    let steps: LiveStep[] = []
    for (let i = 1; i <= LIVE_STEPS_MAX + 5; i++) {
      steps = reduceLiveSteps(steps, ev(i, 'thought'))
    }
    expect(steps).toHaveLength(LIVE_STEPS_MAX)
    expect(steps[0]!.stepIndex).toBe(6)
    expect(steps[steps.length - 1]!.stepIndex).toBe(LIVE_STEPS_MAX + 5)
  })
})
