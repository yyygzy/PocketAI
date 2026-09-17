// 知识库文档数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
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
  created_at: number
}

function rowToRecord(row: KbDocRow): KbDocument {
  return {
    id: row.id,
    kbId: row.kb_id,
    source: row.source ?? '',
    sourceType: (row.source_type ?? 'txt') as KbSourceType,
    title: row.title ?? '',
    chunkCount: row.chunk_count,
    status: row.status as KbDocStatus,
    error: row.error,
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
    return this.get(id)!
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

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM kb_documents WHERE id=?').run(id)
  },

  deleteByKb(kbId: string): void {
    dbService.getHandle().prepare('DELETE FROM kb_documents WHERE kb_id=?').run(kbId)
  }
}
