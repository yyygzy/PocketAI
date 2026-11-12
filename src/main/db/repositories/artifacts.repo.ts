// 成品文件仓储（v67 artifacts 表）；文件本体在 DATA_DIR/generated/
import { dbService } from '../database'
import { artifactRelPath } from '../../../shared/artifacts'
import type { ArtifactKind, ArtifactMeta } from '../../../shared/types'

interface ArtifactRow {
  id: string
  kind: string
  title: string
  file_name: string
  size: number
  conversation_id: string | null
  request_id: string | null
  step_index: number | null
  created_at: number
}

const COLS =
  'id, kind, title, file_name, size, conversation_id, request_id, step_index, created_at'

function toMeta(r: ArtifactRow): ArtifactMeta {
  return {
    id: r.id,
    // 表上有 CHECK 约束，这里仍按白名单收窄，避免库被外部改写后把未知 kind 漏给渲染端
    kind: (r.kind === 'md' ? 'md' : 'pptx') as ArtifactKind,
    title: r.title,
    fileName: r.file_name,
    relPath: artifactRelPath(r.file_name),
    size: r.size,
    createdAt: r.created_at,
    conversationId: r.conversation_id,
    requestId: r.request_id,
    stepIndex: r.step_index
  }
}

/** 单次列表上限（渲染端一次拿最近 300 条足够；不做分页，产物不是会话量级） */
const LIST_LIMIT = 300

export const artifactsRepo = {
  list(conversationId?: string | null): ArtifactMeta[] {
    const db = dbService.getHandle()
    const rows = conversationId
      ? (db
          .prepare(
            `SELECT ${COLS} FROM artifacts WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`
          )
          .all(conversationId, LIST_LIMIT) as ArtifactRow[])
      : (db
          .prepare(`SELECT ${COLS} FROM artifacts ORDER BY created_at DESC LIMIT ?`)
          .all(LIST_LIMIT) as ArtifactRow[])
    return rows.map(toMeta)
  },

  get(id: string): ArtifactMeta | null {
    const r = dbService
      .getHandle()
      .prepare(`SELECT ${COLS} FROM artifacts WHERE id = ?`)
      .get(id) as ArtifactRow | undefined
    return r ? toMeta(r) : null
  },

  /** 重启重放时的幂等查找：同一次运行、同一步、同 kind + 同标题视为同一份产物 */
  findByRunStep(
    requestId: string,
    stepIndex: number,
    kind: ArtifactKind,
    title: string
  ): ArtifactMeta | null {
    const r = dbService
      .getHandle()
      .prepare(
        `SELECT ${COLS} FROM artifacts
         WHERE request_id = ? AND step_index = ? AND kind = ? AND title = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(requestId, stepIndex, kind, title) as ArtifactRow | undefined
    return r ? toMeta(r) : null
  },

  insert(meta: ArtifactMeta): void {
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO artifacts
         (id, kind, title, file_name, size, conversation_id, request_id, step_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meta.id,
        meta.kind,
        meta.title,
        meta.fileName,
        meta.size,
        meta.conversationId,
        meta.requestId,
        meta.stepIndex,
        meta.createdAt
      )
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM artifacts WHERE id = ?').run(id)
  },

  /** 已登记产物的磁盘字节总量（配额判定用；不含已被外部删掉的文件） */
  sumSize(): number {
    const r = dbService
      .getHandle()
      .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM artifacts')
      .get() as { total: number } | undefined
    return r?.total ?? 0
  }
}
