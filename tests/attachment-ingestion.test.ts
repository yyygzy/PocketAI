// 附件自动入库（attachment-ingestion）测试
//
// 覆盖 src/main/attachment/attachment-ingestion.ts：
// - ingestTextAttachmentsToKb：只处理 text 类型附件、空数据跳过、失败不阻断其余
// - deleteMessageAttachmentDocs：按 source=msg_${messageId} 精确匹配清理
//
// 策略：mock kbDocRepo/ingestionService/logger（logger 依赖 electron）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatAttachment, KbDocument } from '../src/shared/types'

const inserted: Array<{ kbId: string; source: string; sourceType: string; title: string }> = []
let docs: KbDocument[] = []
const ingested: Array<{ kbId: string; docId: string; content: string; name: string }> = []
let ingestFailFor: string | null = null
let nextDocId = 0

vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: {
    insert: (input: { kbId: string; source: string; sourceType: string; title: string }) => {
      inserted.push(input)
      nextDocId += 1
      const doc: KbDocument = {
        id: `doc${nextDocId}`,
        kbId: input.kbId,
        source: input.source,
        sourceType: input.sourceType as KbDocument['sourceType'],
        title: input.title,
        chunkCount: 0,
        status: 'pending',
        error: null,
        contentHash: null,
        enabled: true,
        createdAt: Date.now()
      }
      docs.push(doc)
      return doc
    },
    listAll: () => docs,
    delete: (id: string) => {
      docs = docs.filter((d) => d.id !== id)
    }
  }
}))

vi.mock('../src/main/knowledge/ingestion', () => ({
  ingestionService: {
    ingestText: async (kbId: string, docId: string, content: string, name: string) => {
      if (ingestFailFor && name === ingestFailFor) throw new Error('模拟入库失败')
      ingested.push({ kbId, docId, content, name })
    }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { ingestTextAttachmentsToKb, deleteMessageAttachmentDocs } from '../src/main/attachment/attachment-ingestion'

const textAtt = (name: string, data: string): ChatAttachment => ({
  type: 'text',
  name,
  mimeType: 'text/plain',
  size: data.length,
  data
})

beforeEach(() => {
  inserted.length = 0
  ingested.length = 0
  docs = []
  ingestFailFor = null
  nextDocId = 0
})

describe('ingestTextAttachmentsToKb', () => {
  it('text 附件入库：insert + ingestText 均按序调用', async () => {
    await ingestTextAttachmentsToKb('kb1', 'm1', [textAtt('a.txt', '内容A')])
    expect(inserted).toEqual([{ kbId: 'kb1', source: 'msg_m1', sourceType: 'txt', title: '[附件] a.txt' }])
    expect(ingested).toEqual([{ kbId: 'kb1', docId: 'doc1', content: '内容A', name: 'a.txt' }])
  })

  it('image/kb 类型附件被过滤，不入库', async () => {
    const atts: ChatAttachment[] = [
      { type: 'image', name: 'p.png', mimeType: 'image/png', size: 10, data: 'base64xxx' },
      { type: 'kb', name: 'doc.md', mimeType: 'text/markdown', size: 5, data: 'kb内容' },
      textAtt('b.txt', '内容B')
    ]
    await ingestTextAttachmentsToKb('kb1', 'm2', atts)
    expect(inserted.length).toBe(1)
    expect(inserted[0]!.title).toBe('[附件] b.txt')
  })

  it('data 为空/纯空白的 text 附件跳过', async () => {
    await ingestTextAttachmentsToKb('kb1', 'm3', [textAtt('empty.txt', '   ')])
    expect(inserted.length).toBe(0)
    expect(ingested.length).toBe(0)
  })

  it('无 text 附件时完全不动作', async () => {
    await ingestTextAttachmentsToKb('kb1', 'm4', [])
    expect(inserted.length).toBe(0)
  })

  it('单个附件入库失败不阻断其余附件', async () => {
    ingestFailFor = 'bad.txt'
    await ingestTextAttachmentsToKb('kb1', 'm5', [textAtt('bad.txt', '坏'), textAtt('good.txt', '好')])
    // bad.txt 的 insert 已发生（doc 记录在），但 ingestText 抛错被捕获
    expect(inserted.length).toBe(2)
    expect(ingested.length).toBe(1)
    expect(ingested[0]!.name).toBe('good.txt')
  })

  it('多个 text 附件共享同一 messageId source 前缀', async () => {
    await ingestTextAttachmentsToKb('kb1', 'm6', [textAtt('1.txt', '一'), textAtt('2.txt', '二')])
    expect(inserted.map((i) => i.source)).toEqual(['msg_m6', 'msg_m6'])
    expect(ingested.map((i) => i.docId)).toEqual(['doc1', 'doc2'])
  })
})

describe('deleteMessageAttachmentDocs', () => {
  const mkDoc = (id: string, source: string): KbDocument => ({
    id,
    kbId: 'kb1',
    source,
    sourceType: 'txt',
    title: id,
    chunkCount: 1,
    status: 'ready',
    error: null,
    contentHash: null,
    enabled: true,
    createdAt: 1
  })

  it('按 source 精确匹配删除', () => {
    docs = [mkDoc('d1', 'msg_m1'), mkDoc('d2', 'msg_m2'), mkDoc('d3', '/path/file.pdf')]
    deleteMessageAttachmentDocs('m1')
    expect(docs.map((d) => d.id)).toEqual(['d2', 'd3'])
  })

  it('不误删前缀相似的其他消息文档（msg_m1 vs msg_m11）', () => {
    docs = [mkDoc('d1', 'msg_m1'), mkDoc('d2', 'msg_m11')]
    deleteMessageAttachmentDocs('m1')
    expect(docs.map((d) => d.id)).toEqual(['d2'])
  })

  it('无匹配时安全无操作', () => {
    docs = [mkDoc('d3', '/path/file.pdf')]
    deleteMessageAttachmentDocs('nonexistent')
    expect(docs.length).toBe(1)
  })
})
