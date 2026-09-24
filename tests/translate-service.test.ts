// translate-service 翻译 system 提示词构造测试
//
// 覆盖 src/main/translate/translate-service.ts 的 buildSystemPrompt 纯函数：
// - 源语言 auto / 指定语言行
// - 目标语言名称
// - 风格提示
// - 术语表注入（空数组不注入、有术语则拼接术语列表）
//
// 策略：buildSystemPrompt 为纯函数，但模块顶层 import providerManager/translationRepo，
// 需 mock 掉避免重依赖链初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null, getRecord: () => ({ name: 'test' }) }
}))
vi.mock('../src/main/db/repositories/translation.repo', () => ({
  translationRepo: { glossaryList: () => [], historyAdd: () => ({}) }
}))

import { buildSystemPrompt } from '../src/main/translate/translate-service'
import type { GlossaryTerm } from '../src/shared/types'

function glossary(terms: Array<[string, string]>): GlossaryTerm[] {
  return terms.map(([sourceTerm, targetTerm], i) => ({
    id: String(i),
    sourceTerm,
    targetTerm,
    createdAt: 0
  }))
}

describe('buildSystemPrompt — 翻译 system 提示词', () => {
  it('源语言 auto → 提示自动检测', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'standard', glossary: [] })
    expect(p).toContain('源语言：未指定')
    expect(p).toContain('翻译为英语')
  })

  it('源语言指定 → 输出对应语言名', () => {
    const p = buildSystemPrompt({ sourceLang: 'zh', targetLang: 'en', style: 'standard', glossary: [] })
    expect(p).toContain('源语言：简体中文。')
    expect(p).toContain('翻译为英语')
  })

  it('目标语言为 zh-TW → 繁体中文', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'zh-TW', style: 'standard', glossary: [] })
    expect(p).toContain('翻译为繁体中文')
  })

  it('目标语言为 ja → 日语', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'ja', style: 'standard', glossary: [] })
    expect(p).toContain('翻译为日语')
  })

  it('风格 standard → 通用翻译风格提示', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'standard', glossary: [] })
    expect(p).toContain('自然、规范且忠实于原文')
  })

  it('风格 fluent → 流畅地道提示', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'fluent', glossary: [] })
    expect(p).toContain('流畅地道')
  })

  it('风格 literal → 直译提示', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'literal', glossary: [] })
    expect(p).toContain('直译')
  })

  it('风格 formal → 正式书面提示', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'formal', glossary: [] })
    expect(p).toContain('正式、严谨')
  })

  it('空术语表 → 不注入术语段', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'standard', glossary: [] })
    expect(p).not.toContain('术语表')
  })

  it('有术语表 → 注入术语列表', () => {
    const p = buildSystemPrompt({
      sourceLang: 'auto',
      targetLang: 'en',
      style: 'standard',
      glossary: glossary([['API', '应用程序接口'], ['GUI', '图形用户界面']])
    })
    expect(p).toContain('术语表')
    expect(p).toContain('API = 应用程序接口')
    expect(p).toContain('GUI = 图形用户界面')
  })

  it('术语表严格使用指定译法', () => {
    const p = buildSystemPrompt({
      sourceLang: 'auto',
      targetLang: 'zh',
      style: 'standard',
      glossary: glossary([['Token', '令牌']])
    })
    expect(p).toContain('Token = 令牌')
  })

  it('包含核心约束：只输出译文、保持格式', () => {
    const p = buildSystemPrompt({ sourceLang: 'auto', targetLang: 'en', style: 'standard', glossary: [] })
    expect(p).toContain('只输出译文本身')
    expect(p).toContain('Markdown')
  })
})
