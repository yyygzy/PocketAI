// 代码块折叠纯函数测试
import { describe, it, expect } from 'vitest'
import {
  CODE_COLLAPSE_THRESHOLD,
  CODE_PREVIEW_LINES,
  countCodeLines,
  isCollapsible,
  previewLines
} from '../src/renderer/src/utils/code-block'

describe('countCodeLines', () => {
  it('空串 0 行；无换行 1 行；换行计数正确', () => {
    expect(countCodeLines('')).toBe(0)
    expect(countCodeLines('a')).toBe(1)
    expect(countCodeLines('a\nb\nc')).toBe(3)
    expect(countCodeLines('a\n')).toBe(2)
  })
})

describe('isCollapsible', () => {
  it('阈值边界：等于阈值不折叠，超过才折叠', () => {
    const code20 = Array.from({ length: CODE_COLLAPSE_THRESHOLD }, (_, i) => `L${i}`).join('\n')
    const code21 = code20 + '\nL21'
    expect(isCollapsible(code20)).toBe(false)
    expect(isCollapsible(code21)).toBe(true)
  })
  it('自定义阈值生效；空串不折叠', () => {
    expect(isCollapsible('a\nb', 1)).toBe(true)
    expect(isCollapsible('a', 1)).toBe(false)
    expect(isCollapsible('')).toBe(false)
  })
  it('预览行数常量小于折叠阈值（保证折叠态有遮罩意义）', () => {
    expect(CODE_PREVIEW_LINES).toBeLessThan(CODE_COLLAPSE_THRESHOLD)
  })
})

describe('previewLines', () => {
  it('取前 n 行；n=0 空串；n 超总数返回全部', () => {
    expect(previewLines('a\nb\nc\nd', 2)).toBe('a\nb')
    expect(previewLines('a\nb', 0)).toBe('')
    expect(previewLines('a\nb', 10)).toBe('a\nb')
    expect(previewLines('', 3)).toBe('')
  })
})
