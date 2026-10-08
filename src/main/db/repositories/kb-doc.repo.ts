// 知识库文档数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import { kbChunkRepo } from './kb-chunk.repo'
import type { KbDocument, KbDocStatus, KbSourceType } from '../../../shared/types'

interface KbDocRow {
  id: string
  kb_id: string
  source: string | null
  source_type: string | null
  title: string | null
  chunk_count: number
  status: string
  error: string | null
  content_hash: string | null
  enabled: number
  created_at: number
}

export function rowToRecord(row: KbDocRow): KbDocument {
  return {
    id: row.id,
    kbId: row.kb_id,
    source: row.source ?? '',
    sourceType: (row.source_type ?? 'txt') as KbSourceType,
    title: row.title ?? '',
    chunkCount: row.chunk_count,
    status: row.status as KbDocStatus,
    error: row.error,
    contentHash: row.content_hash,
    enabled: row.enabled === 1,
    createdAt: row.created_at
  }
}

export const kbDocRepo = {
  list(kbId: string): KbDocument[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM kb_documents WHERE kb_id=? ORDER BY created_at DESC')
      .all(kbId) as KbDocRow[]
    return rows.map(rowToRecord)
  },

  /** 列出所有知识库的所有文档（供健康检查等后台任务使用） */
  listAll(): KbDocument[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM kb_documents ORDER BY created_at DESC')
      .all() as KbDocRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): KbDocument | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM kb_documents WHERE id=?')
      .get(id) as KbDocRow | undefined
    return row ? rowToRecord(row) : null
  },

  insert(input: {
    kbId: string
    source: string
    sourceType: KbSourceType
    title?: string
  }): KbDocument {
    const id = randomUUID()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO kb_documents (id, kb_id, source, source_type, title, chunk_count, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 'pending', NULL, ?)`
      )
      .run(id, input.kbId, input.source, input.sourceType, input.title ?? input.source, Date.now())
    return mustGet(() => this.get(id), '知识库文档')
  },

  setStatus(id: string, status: KbDocStatus, error?: string | null): void {
    dbService
      .getHandle()
      .prepare('UPDATE kb_documents SET status=?, error=? WHERE id=?')
      .run(status, error ?? null, id)
  },

  setChunkCount(id: string, count: number): void {
    dbService
      .getHandle()
      .prepare('UPDATE kb_documents SET chunk_count=? WHERE id=?')
      .run(count, id)
  },

  /** 记录 file 文档内容 hash（增量同步检测用；传 null 清除） */
  setContentHash(id: string, hash: string | null): void {
    dbService
      .getHandle()
      .prepare('UPDATE kb_documents SET content_hash=? WHERE id=?')
      .run(hash, id)
  },

  /**
   * 文本类文档原文（v42 起；手工录入/消息附件）。
   * 单独查询而非挂在 rowToRecord：list 全量携带大文本会拖垮库文档列表。
   * 文件/URL 类与 v42 前录入的文本返回 null。
   */
  getRawText(id: string): string | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT raw_text AS rawText FROM kb_documents WHERE id=?')
      .get(id) as { rawText: string | null } | undefined
    return row?.rawText ?? null
  },

  /** 保存文本类文档原文（重建索引时复用，独立于 chunks 生命周期） */
  setRawText(id: string, text: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE kb_documents SET raw_text=? WHERE id=?')
      .run(text, id)
  },

  /** 重命名文档标题（不触发重建：标题不进向量；source 保持不动，msg_* 级联清理依赖它） */
  rename(id: string, title: string): KbDocument | null {
    dbService
      .getHandle()
      .prepare('UPDATE kb_documents SET title=? WHERE id=?')
      .run(title, id)
    return this.get(id)
  },

  /** 文档级检索开关：enabled=false 临时排除出检索范围（不删除、不重索引） */
  setEnabled(id: string, enabled: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE kb_documents SET enabled=? WHERE id=?')
      .run(enabled ? 1 : 0, id)
  },

  delete(id: string): void {
    // 收口清理：kb_vec_map/vec 表无 FK，若只删文档行，分块虽级联删除但 vectors.db 会残留孤儿向量
    kbChunkRepo.deleteByDoc(id)
    dbService.getHandle().prepare('DELETE FROM kb_documents WHERE id=?').run(id)
  },

  deleteByKb(kbId: string): void {
    dbService.getHandle().prepare('DELETE FROM kb_documents WHERE kb_id=?').run(kbId)
  }
}
