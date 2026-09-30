// 入库流水线：解析 → 分块 → 向量化 → 存储
// 失败不中断整个知识库，仅记录单文档错误
import path from 'node:path'
import { kbRepo } from '../db/repositories/kb.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbChunkRepo, type ChunkInsert } from '../db/repositories/kb-chunk.repo'
import { kbAskSessionRepo } from '../db/repositories/kb-ask-session.repo'
import { chunkMarkdown } from './chunker'
import { embedTexts } from './embedding'
import { parseDocument } from './parsers'
import { ocrImageFile } from './ocr'
import { hashFile } from './sync-check'
import type { KbDocument, KnowledgeBase } from '../../shared/types'
import { errMsg } from '../error'
import { mustGet } from '../db/must-get'
import { z } from 'zod'

export class IngestionService {
  /**
   * 处理单个文档：解析 → 分块 → 向量化 → 存储
   * 假定文档记录已插入（status=pending），本方法负责推进到 ready/error
   */
  async ingestDocument(kbId: string, docId: string): Promise<KbDocument> {
    const kb = kbRepo.get(kbId)
    if (!kb) throw new Error('知识库不存在')
    if (!kb.embeddingProviderId || !kb.embeddingModel) {
      throw new Error('知识库未配置 Embedding 模型，请先在知识库设置中选择模型')
    }

    const doc = kbDocRepo.get(docId)
    if (!doc) throw new Error('文档不存在')

    try {
      // 重新索引时先清理旧分块
      kbChunkRepo.deleteByDoc(docId)

      // 1. 解析
      kbDocRepo.setStatus(docId, 'parsing')
      // 记录源内容 hash（增量同步检测用）：仅本地文件可算出，
      // URL/手工文本/文件丢失时 hashFile 失败写 null，天然不参与后续检测
      try {
        kbDocRepo.setContentHash(docId, await hashFile(doc.source))
      } catch {
        kbDocRepo.setContentHash(docId, null)
      }
      const parsed = await parseForIngest(doc.source, doc.sourceType, kb)
      if (!parsed.text.trim()) {
        throw new Error(
          doc.source.toLowerCase().endsWith('.pdf')
            ? 'PDF 未包含可提取文本（可能是扫描版，暂不支持 OCR，请转为图片后导入）'
            : '文档解析后内容为空'
        )
      }

      await this.indexText(kb, docId, parsed.text)
    } catch (err) {
      kbDocRepo.setStatus(docId, 'error', errMsg(err))
    }

    return mustGet(() => kbDocRepo.get(docId), '知识库文档')
  }

  /** 直接注入纯文本（手工录入），跳过文件解析 */
  async ingestText(kbId: string, docId: string, text: string, _title: string): Promise<KbDocument> {
    z.string().min(1).parse(kbId)
    z.string().min(1).parse(docId)
    z.string().min(1, '文本内容不能为空').parse(text)
    const kb = kbRepo.get(kbId)
    if (!kb) throw new Error('知识库不存在')
    if (!kb.embeddingProviderId || !kb.embeddingModel) {
      throw new Error('知识库未配置 Embedding 模型，请先在知识库设置中选择模型')
    }

    try {
      kbChunkRepo.deleteByDoc(docId)
      await this.indexText(kb, docId, text)
    } catch (err) {
      kbDocRepo.setStatus(docId, 'error', errMsg(err))
    }
    return mustGet(() => kbDocRepo.get(docId), '知识库文档')
  }

  /** 分块 → 向量化 → 存储（解析后共用） */
  private async indexText(kb: KnowledgeBase, docId: string, rawText: string): Promise<void> {
    // 2. 分块（Markdown 结构感知：按标题切节 + 标题链前缀）
    const chunkResults = chunkMarkdown(rawText, {
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap
    })
    if (chunkResults.length === 0) {
      throw new Error('分块后无有效内容')
    }

    // 3. 向量化
    kbDocRepo.setStatus(docId, 'indexing')
    const texts = chunkResults.map((c) => c.content)
    const vectors = await embedTexts(kb.embeddingProviderId!, kb.embeddingModel!, texts)

    // 首次入库确定维度并写回知识库
    if (kb.embeddingDim === null && vectors.length > 0) {
      kbRepo.setEmbeddingDim(kb.id, vectors[0]!.length)
    }

    // 4. 存储
    const chunks: ChunkInsert[] = chunkResults.map((c, i) => ({
      docId,
      kbId: kb.id,
      sequence: c.sequence,
      content: c.content,
      embedding: vectors[i]!
    }))
    kbChunkRepo.insertMany(chunks)
    kbDocRepo.setChunkCount(docId, chunks.length)
    kbDocRepo.setStatus(docId, 'ready')
  }

  /** 批量入库（顺序执行，避免压垮 Embedding API） */
  async ingestDocuments(kbId: string, docIds: string[]): Promise<KbDocument[]> {
    const results: KbDocument[] = []
    for (const docId of docIds) {
      results.push(await this.ingestDocument(kbId, docId))
    }
    return results
  }

  /** 删除知识库全部数据 */
  deleteKb(kbId: string): void {
    kbChunkRepo.deleteByKb(kbId)
    kbAskSessionRepo.deleteByKb(kbId) // 问答留痕随库级联清理
    kbRepo.delete(kbId) // documents 通过 ON DELETE CASCADE 级联
  }
}

export const ingestionService = new IngestionService()

/**
 * 按来源类型解析出纯文本。
 * 图片文档走 OCR（需要 KB 配置视觉模型，未配置时给出小白可读的引导错误），
 * 其余类型走常规文件解析器。
 */
async function parseForIngest(
  source: string,
  sourceType: KbDocument['sourceType'],
  kb: KnowledgeBase
): Promise<{ text: string; title: string }> {
  if (sourceType !== 'image') {
    return parseDocument(source, sourceType)
  }
  if (!kb.ocrProviderId || !kb.ocrModel) {
    throw new Error('图片文档需要在知识库设置中配置 OCR 视觉模型')
  }
  return { text: await ocrImageFile(source, kb.ocrProviderId, kb.ocrModel), title: path.basename(source) }
}
