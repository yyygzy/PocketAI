// 笔记数据访问
//
// notes 表结构（v11 迁移）：
//   id TEXT PK, title TEXT, content TEXT, tags TEXT,
//   pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
// 标签以逗号分隔字符串存储（轻量，不建关联表）。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { Note } from '../../../shared/types'

interface NoteRow {
  id: string
  title: string
  content: string
  tags: string
  pinned: number
  created_at: number
  updated_at: number
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags ? row.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function tagsToStr(tags: string[] | undefined): string {
  if (!tags) return ''
  return tags.map((t) => t.trim()).filter(Boolean).join(',')
}

export const noteRepo = {
  /** 列表：置顶在前，其余按更新时间倒序 */
  list(): Note[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC')
      .all() as NoteRow[]
    return rows.map(rowToNote)
  },

  get(id: string): Note | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM notes WHERE id=?')
      .get(id) as NoteRow | undefined
    return row ? rowToNote(row) : null
  },

  create(input: { title?: string; content?: string; tags?: string[] }): Note {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO notes (id, title, content, tags, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.title ?? '',
        input.content ?? '',
        tagsToStr(input.tags),
        now,
        now
      )
    return this.get(id)!
  },

  /** 从消息另存为笔记：标题取内容前 30 字 */
  createFromMessage(input: { title?: string; content: string }): Note {
    const title = input.title && input.title.trim()
      ? input.title
      : input.content.slice(0, 30).replace(/\s+/g, ' ').trim() || '未命名笔记'
    return this.create({ title, content: input.content })
  },

  update(
    id: string,
    patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>> & { tags?: string[] }
  ): Note | null {
    const existing = this.get(id)
    if (!existing) return null
    const title = patch.title !== undefined ? patch.title : existing.title
    const content = patch.content !== undefined ? patch.content : existing.content
    const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned ? 1 : 0
    const tags = patch.tags !== undefined ? tagsToStr(patch.tags) : tagsToStr(existing.tags)
    dbService
      .getHandle()
      .prepare(
        `UPDATE notes SET title=?, content=?, tags=?, pinned=?, updated_at=? WHERE id=?`
      )
      .run(title, content, tags, pinned, Date.now(), id)
    return this.get(id)
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM notes WHERE id=?').run(id)
  },

  /** 全文搜索：标题 / 内容 / 标签任意匹配 */
  search(keyword: string): Note[] {
    const kw = keyword.trim()
    if (!kw) return this.list()
    const like = `%${kw}%`
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT * FROM notes
         WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
         ORDER BY pinned DESC, updated_at DESC`
      )
      .all(like, like, like) as NoteRow[]
    return rows.map(rowToNote)
  }
}
