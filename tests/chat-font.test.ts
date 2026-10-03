// 聊天字号档位纯函数测试（apply/load 涉及 DOM/IPC，这里只测映射与归一）
import { describe, it, expect } from 'vitest'
import { FONT_SIZE_PX, normalizeFontSize, CHAT_FONT_VAR } from '../src/renderer/src/chat-font'

describe('normalizeFontSize', () => {
  it('合法档位原样返回', () => {
    expect(normalizeFontSize('small')).toBe('small')
    expect(normalizeFontSize('medium')).toBe('medium')
    expect(normalizeFontSize('large')).toBe('large')
  })

  it('缺省/非法值（undefined/null/空串/乱码/数字）回退 medium', () => {
    expect(normalizeFontSize(undefined)).toBe('medium')
    expect(normalizeFontSize(null)).toBe('medium')
    expect(normalizeFontSize('')).toBe('medium')
    expect(normalizeFontSize('huge')).toBe('medium')
    expect(normalizeFontSize('SMALL')).toBe('medium') // 大小写敏感
    expect(normalizeFontSize(14)).toBe('medium')
    expect(normalizeFontSize({})).toBe('medium')
  })
})

describe('FONT_SIZE_PX', () => {
  it('三档像素映射 small 13 / medium 14 / large 16（递增）', () => {
    expect(FONT_SIZE_PX.small).toBe(13)
    expect(FONT_SIZE_PX.medium).toBe(14)
    expect(FONT_SIZE_PX.large).toBe(16)
    expect(FONT_SIZE_PX.large).toBeGreaterThan(FONT_SIZE_PX.medium)
    expect(FONT_SIZE_PX.medium).toBeGreaterThan(FONT_SIZE_PX.small)
  })

  it('CSS 变量名与 styles/theme.css 约定一致', () => {
    expect(CHAT_FONT_VAR).toBe('--chat-font-size')
  })
})
