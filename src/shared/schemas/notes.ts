// 笔记 IPC 入参 schema
// content/title/tags 落库且可能被引用进 LLM 上下文，带宽松资源上限。
import { z } from 'zod'

const NOTE_MAX_TITLE_CHARS = 200
const NOTE_MAX_CONTENT_CHARS = 100_000
const NOTE_MAX_TAG_CHARS = 50
const NOTE_MAX_TAGS = 20

const noteTags = z.array(z.string().max(NOTE_MAX_TAG_CHARS)).max(NOTE_MAX_TAGS)

/** NOTES_CREATE 入参 */
export const notesCreateSchema = z.object({
  title: z.string().max(NOTE_MAX_TITLE_CHARS).optional(),
  content: z.string().max(NOTE_MAX_CONTENT_CHARS).optional(),
  tags: noteTags.optional()
})

/** NOTES_UPDATE 第二参 patch */
export const notesUpdatePatchSchema = z.object({
  title: z.string().max(NOTE_MAX_TITLE_CHARS).optional(),
  content: z.string().max(NOTE_MAX_CONTENT_CHARS).optional(),
  pinned: z.boolean().optional(),
  tags: noteTags.optional()
})

/** NOTES_CREATE_FROM_MESSAGE 入参 */
export const notesCreateFromMessageSchema = z.object({
  title: z.string().max(NOTE_MAX_TITLE_CHARS).optional(),
  content: z.string().max(NOTE_MAX_CONTENT_CHARS)
})
