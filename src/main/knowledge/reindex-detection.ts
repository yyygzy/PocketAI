// 知识库配置变更 → 重建提示判定（纯函数，便于单测；不引 electron / db）
import type { KbDocument, KnowledgeBase } from '../../shared/types'

type KbConfigFields = Pick<
  KnowledgeBase,
  'embeddingProviderId' | 'embeddingModel' | 'embeddingDim' | 'chunkSize' | 'chunkOverlap'
>

export interface KbConfigChangeResult {
  /** Embedding provider/model 变更（且旧库已有向量维度，旧向量会按维度分片失效） */
  embeddingChanged: boolean
  /** 分块大小/重叠变更（旧分块边界与新配置不一致） */
  chunkingChanged: boolean
  /** 任一需要重建索引的配置发生变更 */
  needReindex: boolean
}

/**
 * 对比保存前 / 保存后的知识库配置，判断旧索引是否需要重建。
 * 只比较显式传入的字段：KB_SAVE 是 partial 入参，未传字段沿用旧值，不算变更。
 */
export function detectKbConfigChanges(
  existing: KbConfigFields | null,
  next: Partial<KbConfigFields>
): KbConfigChangeResult {
  if (!existing) return { embeddingChanged: false, chunkingChanged: false, needReindex: false }

  const providerChanged =
    next.embeddingProviderId !== undefined &&
    next.embeddingProviderId !== existing.embeddingProviderId
  const modelChanged =
    next.embeddingModel !== undefined && next.embeddingModel !== existing.embeddingModel
  // 与旧实现一致：旧库还没有向量维度时谈不上"旧向量失配"，不提示
  const embeddingChanged = existing.embeddingDim !== null && (providerChanged || modelChanged)

  const chunkingChanged =
    (next.chunkSize !== undefined && next.chunkSize !== existing.chunkSize) ||
    (next.chunkOverlap !== undefined && next.chunkOverlap !== existing.chunkOverlap)

  return {
    embeddingChanged,
    chunkingChanged,
    needReindex: embeddingChanged || chunkingChanged
  }
}

/** 需要重建的文档数：已索引（ready）或尚留有分块的文档；pending/空文档不算"受影响" */
export function countDocsNeedingReindex(docs: KbDocument[]): number {
  return docs.filter((d) => d.status === 'ready' || d.chunkCount > 0).length
}
