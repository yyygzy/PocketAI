// Agent 运行实时步骤条 liveSteps 归约纯函数测试
import { describe, expect, it } from 'vitest'
import { reduceLiveSteps, LIVE_STEPS_MAX, type LiveStep } from '../src/renderer/src/modules/agent/agent-shared'

const ev = (stepIndex: number, type: string, toolName?: string) => ({
  stepIndex,
  type,
  toolCall: toolName ? { id: 'tc1', type: 'function' as const, function: { name: toolName, arguments: '{}' } } : undefined
})

describe('reduceLiveSteps', () => {
  it('白名单类型追加 chip；工具步携带工具名', () => {
    let steps: LiveStep[] = []
    steps = reduceLiveSteps(steps, ev(1, 'thought'))
    steps = reduceLiveSteps(steps, ev(1, 'tool_call', 'shell_exec'))
    steps = reduceLiveSteps(steps, ev(1, 'tool_result'))
    expect(steps).toEqual([
      { stepIndex: 1, type: 'thought', toolName: undefined },
      { stepIndex: 1, type: 'tool_call', toolName: 'shell_exec' },
      { stepIndex: 1, type: 'tool_result', toolName: undefined }
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
