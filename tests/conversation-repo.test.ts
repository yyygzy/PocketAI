// conversation.repo 行映射测试
//
// 覆盖 src/main/db/repositories/conversation.repo.ts 的 rowToRecord：
// DB 行 → ConversationRecord 映射（title null→'新对话'、status null→'idle'）。
//
// 策略：纯函数，mock dbService/mustGet 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToRecord } from '../src/main/db/repositories/conversation.repo'

describe('rowToRecord — DB 行映射为 ConversationRecord', () => {
  it('全 null 可选字段 → 默认值填充', () => {
    const rec = rowToRecord({
      id: 'c1',
      assistant_id: null,
      title: null,
      model: null,
      params: null,
      status: null,
      created_at: 100,
      updated_at: 200
    })
    expect(rec.id).toBe('c1')
    expect(rec.assistantId).toBeNull()
    expect(rec.title).toBe('新对话')
    expect(rec.modelLabel).toBeNull()
    expect(rec.status).toBe('idle')
    expect(rec.createdAt).toBe(100)
    expect(rec.updatedAt).toBe(200)
  })

  it('非空字段 → 原样透传', () => {
    const rec = rowToRecord({
      id: 'c2',
      assistant_id: 'asst-1',
      title: '我的对话',
      model: 'gpt-4o',
      params: null,
      status: 'streaming',
      created_at: 300,
      updated_at: 400
    })
    expect(rec.assistantId).toBe('asst-1')
    expect(rec.title).toBe('我的对话')
    expect(rec.modelLabel).toBe('gpt-4o')
    expect(rec.status).toBe('streaming')
  })

  it('status=空串 → 透传空串（不回退 idle）', () => {
    const rec = rowToRecord({
      id: 'c3',
      assistant_id: null,
      title: null,
      model: null,
      params: null,
      status: '',
      created_at: 0,
      updated_at: 0
    })
    expect(rec.status).toBe('')
  })

  it('title=空串 → 透传空串（不回退 新对话）', () => {
    const rec = rowToRecord({
      id: 'c4',
      assistant_id: null,
      title: '',
      model: null,
      params: null,
      status: null,
      created_at: 0,
      updated_at: 0
    })
    expect(rec.title).toBe('')
  })
})
