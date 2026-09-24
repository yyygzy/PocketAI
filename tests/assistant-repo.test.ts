// assistant.repo 行映射与 JSON 解析辅助函数测试
//
// 覆盖 src/main/db/repositories/assistant.repo.ts 的三个纯函数：
// - safeArray：JSON 数组解析（失败/非数组→[]，元素 String 化）
// - safeObject：JSON 对象解析（失败/非对象→null）
// - rowToRecord：DB 行 → AssistantRecord 映射（null 兜底、0/1→布尔、JSON 字段解析）
//
// 策略：三函数均不依赖 DB 连接；mock dbService/mustGet 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { safeArray, safeObject, rowToRecord } from '../src/main/db/repositories/assistant.repo'

// ── safeArray ────────────────────────────────────────────
describe('safeArray — JSON 数组安全解析', () => {
  it('null → []', () => {
    expect(safeArray(null)).toEqual([])
  })

  it('空串 → []', () => {
    expect(safeArray('')).toEqual([])
  })

  it('合法 JSON 数组 → 元素 String 化', () => {
    expect(safeArray('["a","b","c"]')).toEqual(['a', 'b', 'c'])
    expect(safeArray('[1,2,3]')).toEqual(['1', '2', '3'])
  })

  it('非数组 JSON → []', () => {
    expect(safeArray('{"a":1}')).toEqual([])
    expect(safeArray('"hello"')).toEqual([])
    expect(safeArray('42')).toEqual([])
  })

  it('非法 JSON → []', () => {
    expect(safeArray('not json')).toEqual([])
    expect(safeArray('[1,')).toEqual([])
  })
})

// ── safeObject ───────────────────────────────────────────
describe('safeObject — JSON 对象安全解析', () => {
  it('null → null', () => {
    expect(safeObject(null)).toBeNull()
  })

  it('空串 → null', () => {
    expect(safeObject('')).toBeNull()
  })

  it('合法 JSON 对象 → 返回对象', () => {
    expect(safeObject('{"temperature":0.7}')).toEqual({ temperature: 0.7 })
  })

  it('非对象 JSON（原始类型）→ null', () => {
    expect(safeObject('"hello"')).toBeNull()
    expect(safeObject('42')).toBeNull()
    expect(safeObject('true')).toBeNull()
    expect(safeObject('null')).toBeNull()
  })

  it('数组 JSON → 返回数组（typeof === object）', () => {
    expect(safeObject('[1,2]')).toEqual([1, 2])
  })

  it('非法 JSON → null', () => {
    expect(safeObject('not json')).toBeNull()
  })
})

// ── rowToRecord ──────────────────────────────────────────
describe('rowToRecord — DB 行映射为 AssistantRecord', () => {
  const baseRow = {
    id: 'a1',
    name: '助手',
    description: null,
    avatar: null,
    system_prompt: null,
    default_provider_id: null,
    default_model: null,
    default_params: null,
    tool_permissions: null,
    skill_ids: null,
    knowledge_base_ids: null,
    welcome_message: null,
    is_builtin: 0,
    is_pinned: 0,
    created_at: 12345
  }

  it('全 null 行 → 默认值填充', () => {
    const rec = rowToRecord(baseRow)
    expect(rec.id).toBe('a1')
    expect(rec.name).toBe('助手')
    expect(rec.description).toBe('')
    expect(rec.avatar).toBe('🤖')
    expect(rec.systemPrompt).toBe('')
    expect(rec.defaultProviderId).toBeNull()
    expect(rec.defaultModel).toBeNull()
    expect(rec.defaultParams).toBeNull()
    expect(rec.toolPermissions).toEqual([])
    expect(rec.skillIds).toEqual([])
    expect(rec.knowledgeBaseIds).toEqual([])
    expect(rec.welcomeMessage).toBe('')
    expect(rec.isBuiltin).toBe(false)
    expect(rec.isPinned).toBe(false)
    expect(rec.createdAt).toBe(12345)
  })

  it('is_builtin=1 → isBuiltin=true', () => {
    expect(rowToRecord({ ...baseRow, is_builtin: 1 }).isBuiltin).toBe(true)
  })

  it('is_pinned=1 → isPinned=true', () => {
    expect(rowToRecord({ ...baseRow, is_pinned: 1 }).isPinned).toBe(true)
  })

  it('非空字符串字段 → 原样透传', () => {
    const rec = rowToRecord({
      ...baseRow,
      description: '一个助手',
      avatar: '🐱',
      system_prompt: '你好',
      default_provider_id: 'p1',
      default_model: 'gpt-4',
      welcome_message: '欢迎'
    })
    expect(rec.description).toBe('一个助手')
    expect(rec.avatar).toBe('🐱')
    expect(rec.systemPrompt).toBe('你好')
    expect(rec.defaultProviderId).toBe('p1')
    expect(rec.defaultModel).toBe('gpt-4')
    expect(rec.welcomeMessage).toBe('欢迎')
  })

  it('default_params 合法 JSON → safeObject 解析', () => {
    const rec = rowToRecord({ ...baseRow, default_params: '{"temperature":0.5}' })
    expect(rec.defaultParams).toEqual({ temperature: 0.5 })
  })

  it('tool_permissions / skill_ids / knowledge_base_ids JSON 数组 → 解析', () => {
    const rec = rowToRecord({
      ...baseRow,
      tool_permissions: '["read","write"]',
      skill_ids: '["s1","s2"]',
      knowledge_base_ids: '["kb1"]'
    })
    expect(rec.toolPermissions).toEqual(['read', 'write'])
    expect(rec.skillIds).toEqual(['s1', 's2'])
    expect(rec.knowledgeBaseIds).toEqual(['kb1'])
  })

  it('JSON 字段非法 → 兜底（对象→null，数组→[]）', () => {
    const rec = rowToRecord({
      ...baseRow,
      default_params: 'invalid',
      tool_permissions: 'invalid',
      skill_ids: 'not-array'
    })
    expect(rec.defaultParams).toBeNull()
    expect(rec.toolPermissions).toEqual([])
    expect(rec.skillIds).toEqual([])
  })
})
