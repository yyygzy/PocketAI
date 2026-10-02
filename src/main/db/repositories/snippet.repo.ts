// 提示词片段数据访问
//
// prompt_snippets 表结构（v31 迁移）：
//   id TEXT PK, title TEXT, content TEXT, created_at INTEGER, updated_at INTEGER
// 列表固定按更新时间倒序（最近用/改的在前）；轻量实体不做分类与排序字段。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import type { PromptSnippetRecord } from '../../../shared/types'

interface SnippetRow {
  id: string
  title: string
  content: string
  created_at: number
  updated_at: number
}

export function rowToSnippet(row: SnippetRow): PromptSnippetRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const snippetRepo = {
  /** 列表：更新时间倒序 */
  list(): PromptSnippetRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM prompt_snippets ORDER BY updated_at DESC')
      .all() as SnippetRow[]
    return rows.map(rowToSnippet)
  },

  get(id: string): PromptSnippetRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM prompt_snippets WHERE id=?')
      .get(id) as SnippetRow | undefined
    return row ? rowToSnippet(row) : null
  },

  create(input: { title: string; content: string }): PromptSnippetRecord {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO prompt_snippets (id, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.title, input.content, now, now)
    return mustGet(() => this.get(id), '提示词片段')
  },

  update(
    id: string,
    patch: Partial<Pick<PromptSnippetRecord, 'title' | 'content'>>
  ): PromptSnippetRecord | null {
    const existing = this.get(id)
    if (!existing) return null
    const title = patch.title !== undefined ? patch.title : existing.title
    const content = patch.content !== undefined ? patch.content : existing.content
    dbService
      .getHandle()
      .prepare('UPDATE prompt_snippets SET title=?, content=?, updated_at=? WHERE id=?')
      .run(title, content, Date.now(), id)
    return this.get(id)
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM prompt_snippets WHERE id=?').run(id)
  },

  /** 按 title 查找片段；不存在返回 null */
  findByTitle(title: string): PromptSnippetRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM prompt_snippets WHERE title=?')
      .get(title) as SnippetRow | undefined
    return row ? rowToSnippet(row) : null
  },

  /** 导入用：同 title 覆盖（UPDATE 保留原 id），无同 title 新建（INSERT 新 UUID） */
  createOrUpdateByTitle(title: string, content: string): { record: PromptSnippetRecord; overwritten: boolean } {
    const existing = this.findByTitle(title)
    if (existing) {
      dbService
        .getHandle()
        .prepare('UPDATE prompt_snippets SET content=?, updated_at=? WHERE id=?')
        .run(content, Date.now(), existing.id)
      const updated = mustGet(() => this.get(existing.id), '提示词片段')
      return { record: updated, overwritten: true }
    }
    return { record: this.create({ title, content }), overwritten: false }
  }
}
