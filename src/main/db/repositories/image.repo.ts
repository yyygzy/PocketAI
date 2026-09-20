// 绘图模块数据访问（v13 迁移）
//
// images：生成图片历史（提示词/模型/Provider/尺寸/文件相对路径/大小/时间）。
// 图片文件本体存 DATA_DIR/images/，DB 只存相对 posix 路径，删除记录时由服务层连带删文件。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { ImageRecord } from '../../../shared/types'

interface ImageRow {
  id: string
  prompt: string
  model: string
  provider_id: string
  provider_name: string
  size: string
  file_name: string
  bytes: number
  created_at: number
}

/** 历史上限（滚动删除最旧记录，服务层连带删文件） */
export const IMAGE_HISTORY_LIMIT = 200

function rowToImage(row: ImageRow): ImageRecord {
  return {
    id: row.id,
    prompt: row.prompt,
    model: row.model,
    providerId: row.provider_id,
    providerName: row.provider_name,
    size: row.size,
    fileName: row.file_name,
    bytes: row.bytes,
    createdAt: row.created_at
  }
}

export const imageRepo = {
  /** 最近 N 条历史，时间倒序 */
  list(limit = IMAGE_HISTORY_LIMIT): ImageRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM images ORDER BY created_at DESC LIMIT ?')
      .all(limit) as ImageRow[]
    return rows.map(rowToImage)
  },

  get(id: string): ImageRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM images WHERE id=?')
      .get(id) as ImageRow | undefined
    return row ? rowToImage(row) : null
  },

  /** 最旧的 N 条记录（时间正序，滚动删除用） */
  listOldest(limit: number): ImageRecord[] {
    if (limit <= 0) return []
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM images ORDER BY created_at ASC LIMIT ?')
      .all(limit) as ImageRow[]
    return rows.map(rowToImage)
  },

  add(input: Omit<ImageRecord, 'id' | 'createdAt'>): ImageRecord {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO images
           (id, prompt, model, provider_id, provider_name, size, file_name, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.prompt,
        input.model,
        input.providerId,
        input.providerName,
        input.size,
        input.fileName,
        input.bytes,
        now
      )
    return { ...input, id, createdAt: now }
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM images WHERE id=?').run(id)
  },

  count(): number {
    const row = dbService.getHandle().prepare('SELECT COUNT(*) AS c FROM images').get() as {
      c: number
    }
    return row.c
  }
}
