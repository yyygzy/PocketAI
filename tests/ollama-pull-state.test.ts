// 管家推荐模型卡片拉取状态纯函数测试
import { describe, it, expect } from 'vitest'
import { pickPullState } from '../src/renderer/src/hooks/useOllamaPull'

describe('pickPullState', () => {
  it('已安装优先：即使同名任务进行中也返回 installed', () => {
    expect(
      pickPullState({ installed: true, ollamaRunning: true, pulling: 'qwen2.5:7b', model: 'qwen2.5:7b' })
    ).toBe('installed')
  })

  it('当前模型正在拉取 → pulling（含 trim 后的同名匹配由调用方保证，此处直接比对）', () => {
    expect(
      pickPullState({ installed: false, ollamaRunning: true, pulling: 'qwen2.5:7b', model: 'qwen2.5:7b' })
    ).toBe('pulling')
  })

  it('别的模型在拉取 → busy-other（自身未装、ollama 运行中也不可点）', () => {
    expect(
      pickPullState({ installed: false, ollamaRunning: true, pulling: 'llama3.1:8b', model: 'qwen2.5:7b' })
    ).toBe('busy-other')
  })

  it('ollama 未运行且空闲 → disabled', () => {
    expect(
      pickPullState({ installed: false, ollamaRunning: false, pulling: null, model: 'qwen2.5:7b' })
    ).toBe('disabled')
  })

  it('忙碌优先于未运行：有任务时即使 ollamaRunning=false 也是 busy-other（事件残留态）', () => {
    expect(
      pickPullState({ installed: false, ollamaRunning: false, pulling: 'llama3.1:8b', model: 'qwen2.5:7b' })
    ).toBe('busy-other')
  })

  it('未装、运行中、空闲 → pullable', () => {
    expect(
      pickPullState({ installed: false, ollamaRunning: true, pulling: null, model: 'qwen2.5:7b' })
    ).toBe('pullable')
  })
})
