// 流式多目标列落定汇总纯函数测试
import { describe, it, expect } from 'vitest'
import { settledOutcome } from '../src/renderer/src/modules/chat/useStreamSession'

describe('settledOutcome', () => {
  it('至少一列 done 即为整体 done（混合 done+error 也算成功）', () => {
    expect(settledOutcome(['done'])).toBe('done')
    expect(settledOutcome(['done', 'error'])).toBe('done')
    expect(settledOutcome(['error', 'done', 'aborted'])).toBe('done')
    expect(settledOutcome(['aborted', 'done'])).toBe('done')
  })

  it('全部 error/aborted 为 error', () => {
    expect(settledOutcome(['error'])).toBe('error')
    expect(settledOutcome(['error', 'aborted'])).toBe('error')
    expect(settledOutcome(['aborted', 'aborted'])).toBe('error')
  })

  it('空数组（无落定记录）保守判为 error', () => {
    expect(settledOutcome([])).toBe('error')
  })
})
