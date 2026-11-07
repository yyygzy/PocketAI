// 入库流水线：解析 → 分块 → 向量化 → 存储
// 失败不中断整个知识库，仅记录单文档错误
// 性能埋点：各阶段耗时经 perf-probe 入环形缓冲（数据健康面板「最近慢操作」可见）
import path from 'node:path'
import { kbRepo } from '../db/repositories/kb.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../db/repositories/kb-chunk.repo'
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

/** 每批向量化的分块数：embed 完一批就写进暂存表，避免整篇向量堆在 JS 堆里 */
const EMBED_BATCH_CHUNKS = 64

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
        markDocumentFailure(
          docId,
          new Error('该文本录入于旧版本，原文未保存，无法重建，请删除后重新添加')
        )
        return mustGet(() => kbDocRepo.get(docId), '知识库文档')
      }
      return this.ingestText(kbId, docId, rawText, doc.title)
    }

    try {
      // 旧分块不在这里删：解析/嵌入全部成功后，由 indexText 在单个事务里整体替换

      // 1. 解析
      kbDocRepo.setStatus(docId, 'parsing')
      // 先算好源内容 hash（增量同步检测用）：仅本地文件可算出，URL/手工文本/文件丢失时为 null。
      // **不在这里落库**——只有新索引成功替换后才写，失败时旧 hash 与旧块保持同一口径。
      let contentHash: string | null = null
      try {
        contentHash = await hashFile(doc.source)
      } catch {
        contentHash = null
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
      const it = await this.indexText(kb, docId, parsed.text, { contentHash })
      const totalMs = parseMs + (performance.now() - t1)
      const detail = `parse=${Math.round(parseMs)} chunk=${Math.round(it.chunkMs)} embed=${Math.round(it.embedMs)} store=${Math.round(it.storeMs)} chunks=${it.chunks} title=${doc.title}`
      if (totalMs >= SLOW_INGEST_MS) recordPerf('kb.ingest', totalMs, detail)
      else logPerfDebug('kb.ingest', totalMs, detail)
    } catch (err) {
      markDocumentFailure(docId, err)
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
      // raw_text 与分块一起在成功事务里更新：重建失败时旧原文与旧索引保持原样
      const it = await this.indexText(kb, docId, text, { rawText: text })
      const totalMs = it.chunkMs + it.embedMs + it.storeMs
      const detail = `chunk=${Math.round(it.chunkMs)} embed=${Math.round(it.embedMs)} store=${Math.round(it.storeMs)} chunks=${it.chunks}`
      if (totalMs >= SLOW_INGEST_MS) recordPerf('kb.ingestText', totalMs, detail)
      else logPerfDebug('kb.ingestText', totalMs, detail)
    } catch (err) {
      markDocumentFailure(docId, err)
    }
    return mustGet(() => kbDocRepo.get(docId), '知识库文档')
  }

  /** 分块 → 向量化 → 原子替换存储（解析后共用）；返回各阶段耗时供入口埋点 */
  private async indexText(
    kb: KnowledgeBase,
    docId: string,
    rawText: string,
    commitMeta?: { contentHash?: string | null; rawText?: string }
  ): Promise<IndexTimings> {
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

    // 3. 向量化：按批写入 TEMP 暂存表。embedding 全部成功前不碰旧分块，
    //    也不把整篇向量一次性留在 JS 堆里。
    kbDocRepo.setStatus(docId, 'indexing')
    const stageId = kbChunkRepo.createVectorStage()
    let embedMs = 0
    let storeMs = 0
    try {
      const te = performance.now()
      let vectorDim: number | null = null
      for (let i = 0; i < chunkResults.length; i += EMBED_BATCH_CHUNKS) {
        const batch = chunkResults.slice(i, i + EMBED_BATCH_CHUNKS)
        const vectors = await embedTexts(
          kb.embeddingProviderId!,
          kb.embeddingModel!,
          batch.map((c) => c.content)
        )
        if (vectors.length !== batch.length) {
          throw new Error(`向量化返回数量不匹配：期望 ${batch.length}，实际 ${vectors.length}`)
        }
        for (const vec of vectors) {
          if (vectorDim === null) vectorDim = vec.length
          else if (vec.length !== vectorDim) throw new Error('同一文档的向量维度不一致')
        }
        kbChunkRepo.appendStageVectors(
          stageId,
          batch.map((c, j) => ({ sequence: c.sequence, embedding: vectors[j]! }))
        )
      }
      embedMs = performance.now() - te

      // 4. 存储：删旧块、写新块、写向量映射、更新文档状态/计数在同一个事务里
      const ts = performance.now()
      kbChunkRepo.replaceDocChunksAtomically({
        docId,
        kbId: kb.id,
        stageId,
        chunks: chunkResults,
        updateDoc: () => {
          // 写回实际向量维度：首次入库确定维度；换模型重建后记录仍停在旧值时也要纠正，
          // 否则数据健康会一直按旧维度判定为「不匹配」，重建按钮点了也不会消失。
          // 放在事务内：替换失败时维度不能先跳到新值，否则旧向量会被当成维度不匹配。
          if (vectorDim !== null && kb.embeddingDim !== vectorDim) {
            kbRepo.setEmbeddingDim(kb.id, vectorDim)
          }
          kbDocRepo.setChunkCount(docId, chunkResults.length)
          if (commitMeta?.contentHash !== undefined) {
            kbDocRepo.setContentHash(docId, commitMeta.contentHash)
          }
          if (commitMeta?.rawText !== undefined) {
            kbDocRepo.setRawText(docId, commitMeta.rawText)
          }
          kbDocRepo.setStatus(docId, 'ready')
        }
      })
      storeMs = performance.now() - ts
    } finally {
      kbChunkRepo.dropVectorStage(stageId)
    }

    return { chunkMs, embedMs, storeMs, chunks: chunkResults.length }
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
 * 索引失败的唯一收尾口：按**真实旧块数**决定状态，别让「旧索引还在」被写成笼统的 error。
 * - 旧块 > 0：状态保持 ready（文档仍可检索），error 文本说明重建失败且旧索引保留；
 * - 旧块 = 0：首次入库失败，按 error 记录。
 * 队列兜底 catch 也复用这里，覆盖事务开始前的失败（如 KB 未配置 Embedding）。
 */
export function markDocumentFailure(docId: string, err: unknown): void {
  const reason = errMsg(err)
  let oldChunks = 0
  try {
    oldChunks = kbChunkRepo.countByDoc(docId)
  } catch {
    // 库本身不可用：只能退回 error，避免在错误处理里再抛一次
  }
  if (oldChunks > 0) {
    try {
      // chunk_count 是派生列，失败时校正为真实旧块数，避免「ready 但显示 0 块」
      kbDocRepo.setChunkCount(docId, oldChunks)
    } catch {
      /* 计数校正失败不影响错误说明 */
    }
    kbDocRepo.setStatus(docId, 'ready', `重建失败，旧索引已保留（${oldChunks} 块）：${reason}`)
  } else {
    kbDocRepo.setStatus(docId, 'error', reason)
  }
}

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
