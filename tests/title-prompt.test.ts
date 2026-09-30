// 智能标题纯函数测试：兜底标题 / prompt 构造 / 模型返回清洗
import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDER_TITLE,
  TITLE_INPUT_MAX,
  buildTitlePrompt,
  fallbackTitle,
  sanitizeTitle
} from '../src/main/conversation/title-prompt'

describe('fallbackTitle — 规则兜底标题', () => {
  it('取前 20 字', () => {
    expect(fallbackTitle('一二三四五六七八九十一二三四五六七八九十多余')).toBe('一二三四五六七八九十一二三四五六七八九十')
  })
  it('短文本原样', () => {
    expect(fallbackTitle('你好')).toBe('你好')
  })
  it('空串/纯空白 → 占位标题', () => {
    expect(fallbackTitle('')).toBe(PLACEHOLDER_TITLE)
  })
})

describe('buildTitlePrompt — 标题生成 prompt', () => {
  it('包含同语言、长度与「直接输出」约束', () => {
    const p = buildTitlePrompt('帮我翻译这段话')
    expect(p).toContain('相同的语言')
    expect(p).toContain('10 个汉字')
    expect(p).toContain('6 个单词')
    expect(p).toContain('直接输出标题')
    expect(p.endsWith('帮我翻译这段话')).toBe(true)
  })
  it('超长输入截断到上限', () => {
    const p = buildTitlePrompt('字'.repeat(TITLE_INPUT_MAX + 100))
    expect(p.includes('字'.repeat(TITLE_INPUT_MAX + 1))).toBe(false)
    expect(p.endsWith('字'.repeat(TITLE_INPUT_MAX))).toBe(true)
  })
})

describe('sanitizeTitle — 清洗模型返回', () => {
  it('干净标题原样', () => {
    expect(sanitizeTitle('翻译产品说明书', 'fb')).toBe('翻译产品说明书')
  })
  it('去首尾中英文引号（含两层）', () => {
    expect(sanitizeTitle('"翻译需求"', 'fb')).toBe('翻译需求')
    expect(sanitizeTitle('「会议纪要整理」', 'fb')).toBe('会议纪要整理')
    expect(sanitizeTitle('“《周报》”', 'fb')).toBe('周报')
  })
  it('换行/制表/多空格折叠为单空格', () => {
    expect(sanitizeTitle('  翻译\n\t 合同  条款 ', 'fb')).toBe('翻译 合同 条款')
  })
  it('去标题前缀', () => {
    expect(sanitizeTitle('标题：代码审查', 'fb')).toBe('代码审查')
    expect(sanitizeTitle('Title: Refactor plan', 'fb')).toBe('Refactor plan')
  })
  it('去句末标点与空白', () => {
    expect(sanitizeTitle('季度总结。', 'fb')).toBe('季度总结')
    expect(sanitizeTitle('OK!', 'fb')).toBe('OK')
  })
  it('空串/纯引号 → 回退 fallback', () => {
    expect(sanitizeTitle('', '兜底')).toBe('兜底')
    expect(sanitizeTitle('  ""  ', '兜底')).toBe('兜底')
    expect(sanitizeTitle('。。。', '兜底')).toBe('兜底')
  })
  it('超长截断 40 字', () => {
    expect(sanitizeTitle('字'.repeat(50), 'fb')).toBe('字'.repeat(40))
  })
  it('英文标题正常保留', () => {
    expect(sanitizeTitle('Refactor billing module tests', 'fb')).toBe('Refactor billing module tests')
  })
})
