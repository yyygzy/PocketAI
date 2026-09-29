// 知识库数据健康：完整性探测与修复（Settings「数据健康」面板）
//
// 与 task-scheduler 的 kb_health_check（修「卡在中间态」的文档）分工：
// 这里盯数据一致性 —— vectors.db 孤儿向量（删文档历史泄漏）、孤儿 chunk、
// 缺向量/维度不匹配文档、重复文档、知识库配置引用的 provider 失效。
//
// 探测全部只读；修复动作（清理/去重/重建索引）由 IPC 显式触发。
// 纯函数（findDuplicateGroups / collectProviderIssues）单独导出供 tests 直测。
import { dbService } from '../db/database'
import { kbRepo } from '../db/repositories/kb.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbVecRepo } from '../db/repositories/kb-vec.repo'
import { providerRepo } from '../db/repositories/provider.repo'
import { indexQueue } from './index-queue'
import type {
  KbDocument,
  KnowledgeBase,
  ProviderRecord,
  KbBrokenDoc,
  KbDuplicateGroup,
  KbIntegrityReport,
  KbProviderIssue
} from '../../shared/types'

// ─── 纯函数：重复文档分组 ────────────────────────────────────────

/** 按 (kbId, contentHash) 分组，组内 ≥2 篇才算重复；docs 按创建时间升序（最早在前，去重保留它） */
export function findDuplicateGroups(
  docs: KbDocument[],
  kbNameOf: (kbId: string) => string
): KbDuplicateGroup[] {
  const byKey = new Map<string, KbDocument[]>()
  for (const d of docs) {
    if (!d.contentHash) continue // 旧数据/URL/手工文本无 hash，不参与检测
    const key = `${d.kbId}|${d.contentHash}`
    const arr = byKey.get(key)
    if (arr) arr.push(d)
    else byKey.set(key, [d])
  }
  const out: KbDuplicateGroup[] = []
  for (const arr of byKey.values()) {
    if (arr.length < 2) continue
    const sorted = [...arr].sort((a, b) => a.createdAt - b.createdAt)
    const first = sorted[0]!
    out.push({
      kbId: first.kbId,
      kbName: kbNameOf(first.kbId),
      hash: first.contentHash!,
      docs: sorted.map((d) => ({ id: d.id, title: d.title || d.source, createdAt: d.createdAt }))
    })
  }
  return out.sort((a, b) => a.kbName.localeCompare(b.kbName) || a.hash.localeCompare(b.hash))
}

// ─── 纯函数：provider 引用失效校验 ───────────────────────────────

/**
 * 校验每个知识库 5 个 provider 引用（embedding/rerank/hyde/multiquery/ocr）：
 * 引用了已删除的 provider（missing）/ 已禁用（disabled）/ 模型不在该 provider 模型列表（model-missing）。
 * 未配置的引用（providerId 为空）跳过；provider 未声明模型列表时不做包含性校验（避免误报）。
 */
export function collectProviderIssues(
  kbs: KnowledgeBase[],
  providers: ProviderRecord[]
): KbProviderIssue[] {
  const byId = new Map(providers.map((p) => [p.id, p]))
  const issues: KbProviderIssue[] = []
  for (const kb of kbs) {
    const refs: Array<{ role: string; providerId: string | null; model: string | null }> = [
      { role: 'embedding', providerId: kb.embeddingProviderId, model: kb.embeddingModel },
      { role: 'rerank', providerId: kb.rerankProviderId, model: kb.rerankModel },
      { role: 'hyde', providerId: kb.hydeProviderId, model: kb.hydeModel },
      { role: 'multiquery', providerId: kb.multiQueryProviderId, model: kb.multiQueryModel },
      { role: 'ocr', providerId: kb.ocrProviderId, model: kb.ocrModel }
    ]
    for (const r of refs) {
      if (!r.providerId) continue
      const base = { kbId: kb.id, kbName: kb.name, role: r.role }
      const p = byId.get(r.providerId)
      if (!p) {
        issues.push({ ...base, issue: 'missing' })
        continue
      }
      if (!p.enabled) {
        issues.push({ ...base, issue: 'disabled' })
        continue
      }
      if (r.model && p.models.length > 0 && !p.models.includes(r.model)) {
        issues.push({ ...base, issue: 'model-missing' })
      }
    }
  }
  return issues
}

// ─── DB 探测 ─────────────────────────────────────────────────────

function tableExists(name: string): boolean {
  return !!dbService
    .getHandle()
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name)
}

/** 完整性探测（只读，逐项容错：单项失败按安全缺省值处理） */
export function getKbIntegrityReport(): KbIntegrityReport {
  const kbNameById = new Map(kbRepo.list().map((k) => [k.id, k.name]))
  const kbNameOf = (kbId: string) => kbNameById.get(kbId) ?? '(未知库)'
  const docs = kbDocRepo.listAll()
  const docById = new Map(docs.map((d) => [d.id, d]))

  // 1. 孤儿向量：kb_vec_map 中 chunk 已不存在（删文档历史泄漏；vec 从未启用时表不存在）
  let orphanVectors = 0
  try {
    if (tableExists('kb_vec_map')) {
      const row = dbService
        .getHandle()
        .prepare(
          `SELECT COUNT(*) AS n FROM kb_vec_map m
           LEFT JOIN kb_chunks c ON c.id = m.chunk_id WHERE c.id IS NULL`
        )
        .get() as { n: number }
      orphanVectors = Number(row.n)
    }
  } catch { /* 探测失败按 0 */ }

  // 2. 孤儿 chunk：所属文档已不存在（FK ON 正常为 0，防御性探测）
  let orphanChunks = 0
  try {
    const row = dbService
      .getHandle()
      .prepare(
        `SELECT COUNT(*) AS n FROM kb_chunks c
         LEFT JOIN kb_documents d ON d.id = c.doc_id WHERE d.id IS NULL`
      )
      .get() as { n: number }
    orphanChunks = Number(row.n)
  } catch { /* 探测失败按 0 */ }

  // 3. 缺向量 / 维度不匹配文档（均为「需重建索引」；缺向量仅在 vec 扩展可用时探测）
  const broken = new Map<string, KbBrokenDoc['reason']>()
  try {
    if (dbService.isVecEnabled() && tableExists('kb_vec_map')) {
      const rows = dbService
        .getHandle()
        .prepare(
          `SELECT DISTINCT c.doc_id FROM kb_chunks c
           WHERE c.embedding IS NOT NULL
             AND c.id NOT IN (SELECT chunk_id FROM kb_vec_map)`
        )
        .all() as Array<{ doc_id: string }>
      for (const r of rows) broken.set(r.doc_id, 'missing-vec')
    }
  } catch { /* 探测失败忽略 */ }
  try {
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT DISTINCT c.doc_id FROM kb_chunks c
         JOIN knowledge_bases k ON k.id = c.kb_id
         WHERE k.embedding_dim IS NOT NULL AND c.embedding IS NOT NULL
           AND length(c.embedding) != k.embedding_dim * 4`
      )
      .all() as Array<{ doc_id: string }>
    for (const r of rows) broken.set(r.doc_id, 'dim-mismatch') // 维度不匹配优先级更高（检索必漏）
  } catch { /* 探测失败忽略 */ }

  const brokenDocs: KbBrokenDoc[] = []
  for (const [docId, reason] of broken) {
    const doc = docById.get(docId)
    if (!doc) continue // 探测间隙被删除
    brokenDocs.push({ id: docId, kbName: kbNameOf(doc.kbId), title: doc.title || doc.source, reason })
  }
  brokenDocs.sort((a, b) => a.kbName.localeCompare(b.kbName) || a.title.localeCompare(b.title))

  return {
    orphanVectors,
    orphanChunks,
    brokenDocs,
    duplicates: findDuplicateGroups(docs, kbNameOf),
    providerIssues: collectProviderIssues(kbRepo.list(), providerRepo.list())
  }
}

// ─── 修复动作 ────────────────────────────────────────────────────

/** 清理孤儿数据：先删孤儿向量映射（含 vec 表行），再删孤儿 chunk 行（同样先清其向量） */
export function cleanOrphans(): { removedVectors: number; removedChunks: number } {
  const db = dbService.getHandle()
  let removedVectors = 0

  // 孤儿向量：chunk 已不存在的 kb_vec_map 行（deleteByChunk 按映射删 vec 表行 + map 行）
  if (tableExists('kb_vec_map')) {
    const rows = db
      .prepare(
        `SELECT m.chunk_id FROM kb_vec_map m
         LEFT JOIN kb_chunks c ON c.id = m.chunk_id WHERE c.id IS NULL`
      )
      .all() as Array<{ chunk_id: string }>
    for (const r of rows) {
      try {
        kbVecRepo.deleteByChunk(r.chunk_id)
        removedVectors++
      } catch {
        // vec 表缺失等异常：映射行已无意义，兜底直接删映射
        try { db.prepare('DELETE FROM kb_vec_map WHERE chunk_id=?').run(r.chunk_id) } catch { /* ignore */ }
      }
    }
  }

  // 孤儿 chunk：先按 doc 清向量（此时 chunk 行还在，JOIN 可命中），再删 chunk 行
  const orphanDocIds = (
    db
      .prepare(
        `SELECT DISTINCT c.doc_id FROM kb_chunks c
         LEFT JOIN kb_documents d ON d.id = c.doc_id WHERE d.id IS NULL`
      )
      .all() as Array<{ doc_id: string }>
  ).map((r) => r.doc_id)
  for (const docId of orphanDocIds) {
    try { kbVecRepo.deleteByDoc(docId) } catch { /* ignore */ }
  }
  const removedChunks = db
    .prepare('DELETE FROM kb_chunks WHERE doc_id NOT IN (SELECT id FROM kb_documents)')
    .run().changes

  return { removedVectors, removedChunks }
}

/** 重建索引：重置 pending 并入队（复用 KB_DOC_REINDEX 同款链路，ingestion 内部先清旧分块） */
export function reindexDocs(docIds: string[]): { enqueued: number } {
  let enqueued = 0
  for (const docId of docIds) {
    const doc = kbDocRepo.get(docId)
    if (!doc) continue
    kbDocRepo.setStatus(docId, 'pending')
    indexQueue.enqueue({ kbId: doc.kbId, docId, kind: 'reindex' })
    enqueued++
  }
  return { enqueued }
}

/** 重复文档去重：保留指定文档，删除同库同内容 hash 的其余文档 */
export function deduplicate(keepDocId: string): { removed: number } {
  const keep = kbDocRepo.get(keepDocId)
  if (!keep) throw new Error('要保留的文档不存在')
  if (!keep.contentHash) throw new Error('该文档无内容指纹，无法去重')
  const dupes = kbDocRepo
    .list(keep.kbId)
    .filter((d) => d.id !== keepDocId && d.contentHash === keep.contentHash)
  for (const d of dupes) kbDocRepo.delete(d.id) // delete 已收口：先清分块与向量
  return { removed: dupes.length }
}
