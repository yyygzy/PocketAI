// 入库流水线：解析 → 分块 → 向量化 → 存储
// 失败不中断整个知识库，仅记录单文档错误
// 性能埋点：各阶段耗时经 perf-probe 入环形缓冲（数据健康面板「最近慢操作」可见）
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
import { recordPerf, logPerfDebug } from '../steward/perf-probe'
import type { KbDocument, KnowledgeBase } from '../../shared/types'
import { errMsg } from '../error'
import { mustGet } from '../db/must-get'
import { z } from 'zod'

/** 入库总耗时入慢操作缓冲的阈值（日志无条件记） */
const SLOW_INGEST_MS = 500

/** indexText 阶段耗时（私有回传，供 ingest 入口汇总埋点） */
interface IndexTimings {
  chunkMs: number
  embedMs: number
  storeMs: number
  chunks: number
}

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

    // 文本类文档（手工录入/消息附件）的 source 是标题或 msg_* 标记而非文件路径，
    // parseDocument 会把它当路径读文件必失败——分流到 ingestText 用留存原文重建。
    // v42 前录入的文本没有 raw_text：给小白明确引导，而非抛底层 ENOENT。
    if (doc.sourceType === 'txt') {
      const rawText = kbDocRepo.getRawText(docId)
      if (!rawText) {
        const err = new Error('该文本录入于旧版本，原文未保存，无法重建，请删除后重新添加')
        kbDocRepo.setStatus(docId, 'error', errMsg(err))
        return mustGet(() => kbDocRepo.get(docId), '知识库文档')
      }
      return this.ingestText(kbId, docId, rawText, doc.title)
    }

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
      const t0 = performance.now()
      const parsed = await parseForIngest(doc.source, doc.sourceType, kb)
      const parseMs = performance.now() - t0
      if (!parsed.text.trim()) {
        throw new Error(
          doc.source.toLowerCase().endsWith('.pdf')
            ? 'PDF 未包含可提取文本（可能是扫描版，暂不支持 OCR，请转为图片后导入）'
            : '文档解析后内容为空'
        )
      }

      const t1 = performance.now()
      const it = await this.indexText(kb, docId, parsed.text)
      const totalMs = parseMs + (performance.now() - t1)
      const detail = `parse=${Math.round(parseMs)} chunk=${Math.round(it.chunkMs)} embed=${Math.round(it.embedMs)} store=${Math.round(it.storeMs)} chunks=${it.chunks} title=${doc.title}`
      if (totalMs >= SLOW_INGEST_MS) recordPerf('kb.ingest', totalMs, detail)
      else logPerfDebug('kb.ingest', totalMs, detail)
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
      // 留存原文：重建索引（KB_DOC_REINDEX/健康检查）统一走 ingestDocument，
      // txt 类分流时靠它恢复（raw_text 独立于 chunks，deleteByDoc 不影响）
      kbDocRepo.setRawText(docId, text)
      kbChunkRepo.deleteByDoc(docId)
      const it = await this.indexText(kb, docId, text)
      const totalMs = it.chunkMs + it.embedMs + it.storeMs
      const detail = `chunk=${Math.round(it.chunkMs)} embed=${Math.round(it.embedMs)} store=${Math.round(it.storeMs)} chunks=${it.chunks}`
      if (totalMs >= SLOW_INGEST_MS) recordPerf('kb.ingestText', totalMs, detail)
      else logPerfDebug('kb.ingestText', totalMs, detail)
    } catch (err) {
      kbDocRepo.setStatus(docId, 'error', errMsg(err))
    }
    return mustGet(() => kbDocRepo.get(docId), '知识库文档')
  }

  /** 分块 → 向量化 → 存储（解析后共用）；返回各阶段耗时供入口埋点 */
  private async indexText(kb: KnowledgeBase, docId: string, rawText: string): Promise<IndexTimings> {
    // 2. 分块（Markdown 结构感知：按标题切节 + 标题链前缀）
    const tc = performance.now()
    const chunkResults = chunkMarkdown(rawText, {
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap
    })
    const chunkMs = performance.now() - tc
    if (chunkResults.length === 0) {
      throw new Error('分块后无有效内容')
    }

    // 3. 向量化
    kbDocRepo.setStatus(docId, 'indexing')
    const texts = chunkResults.map((c) => c.content)
    const te = performance.now()
    const vectors = await embedTexts(kb.embeddingProviderId!, kb.embeddingModel!, texts)
    const embedMs = performance.now() - te

    // 首次入库确定维度并写回知识库
    if (kb.embeddingDim === null && vectors.length > 0) {
      kbRepo.setEmbeddingDim(kb.id, vectors[0]!.length)
    }

    // 4. 存储
    const ts = performance.now()
    const chunks: ChunkInsert[] = chunkResults.map((c, i) => ({
      docId,
      kbId: kb.id,
      sequence: c.sequence,
      content: c.content,
      embedding: vectors[i]!
    }))
    kbChunkRepo.insertMany(chunks)
    const storeMs = performance.now() - ts
    kbDocRepo.setChunkCount(docId, chunks.length)
    kbDocRepo.setStatus(docId, 'ready')
    return { chunkMs, embedMs, storeMs, chunks: chunks.length }
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
