// 附件自动入库（attachment-ingestion）测试
//
// 覆盖 src/main/attachment/attachment-ingestion.ts：
// - ingestAttachmentsToKb：text 直接入库、image 需 OCR 配置才入库、kb 跳过、失败不阻断
// - deleteMessageAttachmentDocs：按 source=msg_${messageId} 精确匹配清理
//
// 策略：mock kbDocRepo/ingestionService/ocr/logger（logger 依赖 electron）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatAttachment, KbDocument } from '../src/shared/types'

const inserted: Array<{ kbId: string; source: string; sourceType: string; title: string }> = []
let docs: KbDocument[] = []
const ingested: Array<{ kbId: string; docId: string; content: string; name: string }> = []
let ingestFailFor: string | null = null
let ocrFailFor: string | null = null
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

vi.mock('../src/main/knowledge/ocr', () => ({
  ocrImageDataUrl: async (dataUrl: string, _providerId: string, _model: string) => {
    if (ocrFailFor && dataUrl.includes(ocrFailFor)) throw new Error('模拟 OCR 失败')
    return `OCR识别内容:${dataUrl.slice(0, 20)}`
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { ingestAttachmentsToKb, deleteMessageAttachmentDocs } from '../src/main/attachment/attachment-ingestion'

const textAtt = (name: string, data: string): ChatAttachment => ({
  type: 'text',
  name,
  mimeType: 'text/plain',
  size: data.length,
  data
})

const imgAtt = (name: string, data: string): ChatAttachment => ({
  type: 'image',
  name,
  mimeType: 'image/png',
  size: data.length,
  data: `data:image/png;base64,${data}`
})

const OCR = { providerId: 'p1', model: 'vision-model' }

beforeEach(() => {
  inserted.length = 0
  ingested.length = 0
  docs = []
  ingestFailFor = null
  ocrFailFor = null
  nextDocId = 0
})

describe('ingestAttachmentsToKb', () => {
  it('text 附件入库：insert + ingestText 均按序调用', async () => {
    await ingestAttachmentsToKb('kb1', 'm1', [textAtt('a.txt', '内容A')], null)
    expect(inserted).toEqual([{ kbId: 'kb1', source: 'msg_m1', sourceType: 'txt', title: '[附件] a.txt' }])
    expect(ingested).toEqual([{ kbId: 'kb1', docId: 'doc1', content: '内容A', name: 'a.txt' }])
  })

  it('无 OCR 配置时 image 附件跳过，kb 类型跳过', async () => {
    const atts: ChatAttachment[] = [
      imgAtt('p.png', 'base64xxx'),
      { type: 'kb', name: 'doc.md', mimeType: 'text/markdown', size: 5, data: 'kb内容' },
      textAtt('b.txt', '内容B')
    ]
    await ingestAttachmentsToKb('kb1', 'm2', atts, null)
    expect(inserted.length).toBe(1)
    expect(inserted[0]!.title).toBe('[附件] b.txt')
  })

  it('有 OCR 配置时 image 附件 OCR 后入库', async () => {
    await ingestAttachmentsToKb('kb1', 'm3', [imgAtt('p.png', 'imgdata')], OCR)
    expect(inserted.length).toBe(1)
    expect(inserted[0]!.title).toBe('[附件] p.png')
    expect(ingested.length).toBe(1)
    expect(ingested[0]!.content).toContain('OCR识别内容')
  })

  it('data 为空/纯空白的 text 附件跳过', async () => {
    await ingestAttachmentsToKb('kb1', 'm4', [textAtt('empty.txt', '   ')], null)
    expect(inserted.length).toBe(0)
    expect(ingested.length).toBe(0)
  })

  it('无附件时完全不动作', async () => {
    await ingestAttachmentsToKb('kb1', 'm5', [], null)
    expect(inserted.length).toBe(0)
  })

  it('单个附件入库失败不阻断其余附件', async () => {
    ingestFailFor = 'bad.txt'
    await ingestAttachmentsToKb('kb1', 'm6', [textAtt('bad.txt', '坏'), textAtt('good.txt', '好')], null)
    expect(inserted.length).toBe(2)
    expect(ingested.length).toBe(1)
    expect(ingested[0]!.name).toBe('good.txt')
  })

  it('OCR 失败不阻断同批 text 附件', async () => {
    ocrFailFor = 'bad'
    await ingestAttachmentsToKb('kb1', 'm7', [imgAtt('p.png', 'bad'), textAtt('good.txt', '好')], OCR)
    expect(ingested.length).toBe(1)
    expect(ingested[0]!.name).toBe('good.txt')
  })

  it('多个附件共享同一 messageId source 前缀', async () => {
    await ingestAttachmentsToKb('kb1', 'm8', [textAtt('1.txt', '一'), imgAtt('2.png', '二')], OCR)
    expect(inserted.map((i) => i.source)).toEqual(['msg_m8', 'msg_m8'])
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
