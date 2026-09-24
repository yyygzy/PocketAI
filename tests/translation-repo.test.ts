// translation.repo 行映射测试
//
// 覆盖 src/main/db/repositories/translation.repo.ts 的两个映射函数：
// - rowToTranslation：翻译历史行 → TranslationRecord
// - rowToGlossary：术语表行 → GlossaryTerm
//
// 策略：纯函数，mock dbService 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))

import { rowToTranslation, rowToGlossary } from '../src/main/db/repositories/translation.repo'

describe('rowToTranslation — 翻译历史行映射', () => {
  it('字段全透传', () => {
    const rec = rowToTranslation({
      id: 't1',
      source_text: '你好',
      target_text: 'Hello',
      source_lang: 'zh',
      target_lang: 'en',
      style: 'standard',
      provider_id: 'p1',
      provider_name: 'OpenAI',
      model: 'gpt-4o',
      created_at: 12345
    })
    expect(rec.id).toBe('t1')
    expect(rec.sourceText).toBe('你好')
    expect(rec.targetText).toBe('Hello')
    expect(rec.sourceLang).toBe('zh')
    expect(rec.targetLang).toBe('en')
    expect(rec.style).toBe('standard')
    expect(rec.providerId).toBe('p1')
    expect(rec.providerName).toBe('OpenAI')
    expect(rec.model).toBe('gpt-4o')
    expect(rec.createdAt).toBe(12345)
  })

  it('source_lang=auto 透传', () => {
    const rec = rowToTranslation({
      id: 't2',
      source_text: 'hi',
      target_text: '你好',
      source_lang: 'auto',
      target_lang: 'zh',
      style: 'fluent',
      provider_id: 'p2',
      provider_name: 'Anthropic',
      model: 'claude',
      created_at: 0
    })
    expect(rec.sourceLang).toBe('auto')
    expect(rec.targetLang).toBe('zh')
    expect(rec.style).toBe('fluent')
  })
})

describe('rowToGlossary — 术语表行映射', () => {
  it('字段全透传', () => {
    const term = rowToGlossary({
      id: 'g1',
      source_term: 'API',
      target_term: '应用程序接口',
      created_at: 999
    })
    expect(term.id).toBe('g1')
    expect(term.sourceTerm).toBe('API')
    expect(term.targetTerm).toBe('应用程序接口')
    expect(term.createdAt).toBe(999)
  })

  it('空术语透传', () => {
    const term = rowToGlossary({
      id: 'g2',
      source_term: '',
      target_term: '',
      created_at: 0
    })
    expect(term.sourceTerm).toBe('')
    expect(term.targetTerm).toBe('')
  })
})
