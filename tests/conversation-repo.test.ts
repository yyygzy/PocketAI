// conversation.repo 行映射测试
//
// 覆盖 src/main/db/repositories/conversation.repo.ts 的 rowToRecord：
// DB 行 → ConversationRecord 映射（title null→'新对话'、status null→'idle'）。
//
// 策略：纯函数，mock dbService/mustGet 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToRecord, buildConvListQuery } from '../src/main/db/repositories/conversation.repo'

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

  it('置顶/归档新字段：旧库行缺列 → 安全默认；新行 0/1 → boolean', () => {
    // 旧库 ALTER 前查询理论上不走新代码，这里验证 undefined 防御
    const legacy = rowToRecord({
      id: 'c5', assistant_id: null, title: null, model: null, params: null,
      status: null, created_at: 0, updated_at: 0
    })
    expect(legacy.pinned).toBe(false)
    expect(legacy.archived).toBe(false)
    expect(legacy.archivedAt).toBeNull()

    const pinned = rowToRecord({
      id: 'c6', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 1, updated_at: 2, pinned: 1, archived: 0, archived_at: null
    })
    expect(pinned.pinned).toBe(true)
    expect(pinned.archived).toBe(false)

    const archived = rowToRecord({
      id: 'c7', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 1, updated_at: 2, pinned: 0, archived: 1, archived_at: 999
    })
    expect(archived.archived).toBe(true)
    expect(archived.archivedAt).toBe(999)
  })

  it('titleDefault：旧库行缺列 → true（可自动命名）；0 → false；1 → true', () => {
    const legacy = rowToRecord({
      id: 'c8', assistant_id: null, title: '新对话', model: null, params: null,
      status: null, created_at: 0, updated_at: 0
    })
    expect(legacy.titleDefault).toBe(true)

    const finalized = rowToRecord({
      id: 'c9', assistant_id: null, title: '手改标题', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, title_default: 0
    })
    expect(finalized.titleDefault).toBe(false)

    const fresh = rowToRecord({
      id: 'c10', assistant_id: null, title: '新对话', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, title_default: 1
    })
    expect(fresh.titleDefault).toBe(true)
  })
})

describe('buildConvListQuery — 列表过滤/排序条件', () => {
  it('默认（活跃）：排除归档且置顶优先按更新时间', () => {
    const q = buildConvListQuery({})
    expect(q.where).toContain('archived = 0')
    expect(q.where).not.toContain('archived = 1')
    expect(q.orderBy).toBe('pinned DESC, updated_at DESC')
    expect(q.vals).toEqual([])
  })

  it('archivedOnly：只取归档并按归档时间排序', () => {
    const q = buildConvListQuery({ archivedOnly: true })
    expect(q.where).toContain('archived = 1')
    expect(q.orderBy).toBe('pinned DESC, archived_at DESC, updated_at DESC')
  })

  it('asst-default / 普通助手 / agent 过滤组合与参数顺序', () => {
    const def = buildConvListQuery({ assistantId: 'asst-default', isAgent: false })
    expect(def.where).toContain("(assistant_id = 'asst-default' OR assistant_id IS NULL)")
    expect(def.where).toContain("(model NOT LIKE 'agent:%' OR model IS NULL)")
    expect(def.vals).toEqual([])

    const asst = buildConvListQuery({ assistantId: 'asst-9', isAgent: true, archivedOnly: true })
    expect(asst.where).toContain('assistant_id = ?')
    expect(asst.where).toContain("model LIKE 'agent:%'")
    expect(asst.where).toContain('archived = 1')
    // 参数顺序：assistantId 先于 archived 条件之前的拼装位置（archived 无参数），仅一个绑定值
    expect(asst.vals).toEqual(['asst-9'])
  })
})
