// kb-doc.repo 行映射测试
//
// 覆盖 src/main/db/repositories/kb-doc.repo.ts 的 rowToRecord：
// DB 行 → KbDocument 映射（source/source_type/title null 兜底、error 透传）。
//
// 策略：纯函数，mock dbService/mustGet 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToRecord } from '../src/main/db/repositories/kb-doc.repo'

const baseRow = {
  id: 'd1',
  kb_id: 'kb1',
  source: '/path/to/file.pdf',
  source_type: 'pdf',
  title: '文档标题',
  chunk_count: 10,
  status: 'ready',
  error: null,
  created_at: 100
}

describe('rowToRecord — DB 行映射为 KbDocument', () => {
  it('基础字段原样透传', () => {
    const doc = rowToRecord(baseRow)
    expect(doc.id).toBe('d1')
    expect(doc.kbId).toBe('kb1')
    expect(doc.chunkCount).toBe(10)
    expect(doc.status).toBe('ready')
    expect(doc.createdAt).toBe(100)
  })

  it('source=null → 空串兜底', () => {
    expect(rowToRecord({ ...baseRow, source: null }).source).toBe('')
  })

  it('source=非空 → 原样透传', () => {
    expect(rowToRecord(baseRow).source).toBe('/path/to/file.pdf')
  })

  it('source_type=null → 默认 txt', () => {
    expect(rowToRecord({ ...baseRow, source_type: null }).sourceType).toBe('txt')
  })

  it('source_type=非空 → 原样透传', () => {
    expect(rowToRecord(baseRow).sourceType).toBe('pdf')
  })

  it('title=null → 空串兜底', () => {
    expect(rowToRecord({ ...baseRow, title: null }).title).toBe('')
  })

  it('title=非空 → 原样透传', () => {
    expect(rowToRecord(baseRow).title).toBe('文档标题')
  })

  it('error=null → 透传 null', () => {
    expect(rowToRecord(baseRow).error).toBeNull()
  })

  it('error=非空 → 原样透传', () => {
    expect(rowToRecord({ ...baseRow, error: '解析失败' }).error).toBe('解析失败')
  })

  it('status 各状态值透传', () => {
    const statuses: Array<'pending' | 'parsing' | 'indexing' | 'ready' | 'error'> = [
      'pending',
      'parsing',
      'indexing',
      'ready',
      'error'
    ]
    for (const s of statuses) {
      expect(rowToRecord({ ...baseRow, status: s }).status).toBe(s)
    }
  })
})
