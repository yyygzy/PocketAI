// skill.repo 行映射测试
//
// 覆盖 src/main/db/repositories/skill.repo.ts 的 rowToRecord：
// DB 行 → SkillRecord 映射（description/icon/content null 兜底、enabled/is_builtin 0/1→布尔）。
//
// 策略：纯函数，mock dbService/mustGet 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToRecord } from '../src/main/db/repositories/skill.repo'

describe('rowToRecord — DB 行映射为 SkillRecord', () => {
  it('全 null 可选字段 → 默认值填充', () => {
    const rec = rowToRecord({
      id: 's1',
      name: '技能',
      description: null,
      icon: null,
      content: null,
      enabled: 0,
      is_builtin: 0,
      created_at: 100
    })
    expect(rec.id).toBe('s1')
    expect(rec.name).toBe('技能')
    expect(rec.description).toBe('')
    expect(rec.icon).toBe('⚡')
    expect(rec.content).toBe('')
    expect(rec.enabled).toBe(false)
    expect(rec.isBuiltin).toBe(false)
    expect(rec.createdAt).toBe(100)
  })

  it('非空字段 → 原样透传', () => {
    const rec = rowToRecord({
      id: 's2',
      name: '翻译助手',
      description: '专业翻译',
      icon: '🌐',
      content: '你是一个翻译助手',
      enabled: 1,
      is_builtin: 1,
      created_at: 200
    })
    expect(rec.description).toBe('专业翻译')
    expect(rec.icon).toBe('🌐')
    expect(rec.content).toBe('你是一个翻译助手')
    expect(rec.enabled).toBe(true)
    expect(rec.isBuiltin).toBe(true)
  })

  it('enabled=0 → false', () => {
    expect(rowToRecord({ id: 's3', name: 'n', description: null, icon: null, content: null, enabled: 0, is_builtin: 0, created_at: 0 }).enabled).toBe(false)
  })

  it('enabled=1 → true', () => {
    expect(rowToRecord({ id: 's4', name: 'n', description: null, icon: null, content: null, enabled: 1, is_builtin: 0, created_at: 0 }).enabled).toBe(true)
  })

  it('is_builtin=1 → true', () => {
    expect(rowToRecord({ id: 's5', name: 'n', description: null, icon: null, content: null, enabled: 0, is_builtin: 1, created_at: 0 }).isBuiltin).toBe(true)
  })

  it('description=空串 → 透传空串（不回退）', () => {
    const rec = rowToRecord({ id: 's6', name: 'n', description: '', icon: null, content: null, enabled: 0, is_builtin: 0, created_at: 0 })
    expect(rec.description).toBe('')
  })
})
