// 提示词片段 IPC 入参 schema
// title 是弹层列表里的短标题；content 是要插进输入框的提示词正文，上限宽松。
import { z } from 'zod'

const SNIPPET_MAX_TITLE_CHARS = 100
const SNIPPET_MAX_CONTENT_CHARS = 20_000

const titleField = z.string().trim().min(1).max(SNIPPET_MAX_TITLE_CHARS)
const contentField = z.string().trim().min(1).max(SNIPPET_MAX_CONTENT_CHARS)

/** SNIPPETS_CREATE 入参 */
export const snippetCreateSchema = z.object({
  title: titleField,
  content: contentField
})

/** SNIPPETS_UPDATE 第二参 patch（至少带一个字段，由 handler 合并现有值） */
export const snippetUpdatePatchSchema = z
  .object({
    title: titleField.optional(),
    content: contentField.optional()
  })
  .refine((p) => p.title !== undefined || p.content !== undefined, {
    message: 'patch must contain title or content'
  })
