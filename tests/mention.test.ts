// mention 纯函数测试
import { describe, it, expect } from 'vitest'
import { getMentionQuery, filterMentionKbs, filterMentionFiles } from '../src/renderer/src/utils/mention'
import type { KnowledgeBase, MessageRecord } from '../src/shared/types'

describe('getMentionQuery — @ 触发识别', () => {
  it('行首 @ 触发', () => {
    expect(getMentionQuery('@abc')).toEqual({ query: 'abc', startPos: 0 })
  })

  it('空白后 @ 触发', () => {
    expect(getMentionQuery('hello @abc')).toEqual({ query: 'abc', startPos: 6 })
  })

  it('行中 @ 不触发（邮箱）', () => {
    expect(getMentionQuery('user@example.com')).toBeNull()
  })

  it('空查询', () => {
    expect(getMentionQuery('@')).toEqual({ query: '', startPos: 0 })
  })

  it('光标在中间时只识别光标前', () => {
    expect(getMentionQuery('@abc def', 4)).toEqual({ query: 'abc', startPos: 0 })
    expect(getMentionQuery('@abc def', 5)).toBeNull()
  })

  it('无 @ 不触发', () => {
    expect(getMentionQuery('hello')).toBeNull()
    expect(getMentionQuery('')).toBeNull()
  })
})

describe('filterMentionKbs — 知识库过滤', () => {
  const kbs = [
    { id: 'k1', name: '产品文档', description: '产品需求', documentCount: 10, chunkCount: 100, createdAt: 0 } as KnowledgeBase,
    { id: 'k2', name: '技术方案', description: '架构设计', documentCount: 5, chunkCount: 50, createdAt: 0 } as KnowledgeBase,
    { id: 'k3', name: 'FAQ', description: '常见问题', documentCount: 3, chunkCount: 30, createdAt: 0 } as KnowledgeBase
  ]

  it('空查询返回全部', () => {
    expect(filterMentionKbs(kbs, '')).toHaveLength(3)
    expect(filterMentionKbs(kbs, '  ')).toHaveLength(3)
  })

  it('按名称过滤', () => {
    expect(filterMentionKbs(kbs, '产品')).toHaveLength(1)
    expect(filterMentionKbs(kbs, '技术')).toHaveLength(1)
  })

  it('按描述过滤', () => {
    expect(filterMentionKbs(kbs, '架构')).toHaveLength(1)
  })

  it('不区分大小写', () => {
    expect(filterMentionKbs(kbs, 'faq')).toHaveLength(1)
  })
})

describe('filterMentionFiles — 最近附件过滤', () => {
  const messages = [
    { id: 'm1', role: 'user', attachments: [{ type: 'image', name: '截图.png', mimeType: 'image/png', size: 100, data: 'x' }] } as MessageRecord,
    { id: 'm2', role: 'user', attachments: [{ type: 'text', name: '笔记.md', mimeType: 'text/markdown', size: 200, data: 'y' }] } as MessageRecord,
    { id: 'm3', role: 'user', attachments: [{ type: 'image', name: '截图.png', mimeType: 'image/png', size: 100, data: 'x' }] } as MessageRecord // 重复
  ]

  it('空查询返回去重后的附件', () => {
    const files = filterMentionFiles(messages, '')
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.name)).toEqual(['截图.png', '笔记.md'])
  })

  it('按名称过滤', () => {
    const files = filterMentionFiles(messages, '笔记')
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe('笔记.md')
  })

  it('无匹配返回空', () => {
    expect(filterMentionFiles(messages, '不存在')).toHaveLength(0)
  })
})
