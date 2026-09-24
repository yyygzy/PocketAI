// 笔记 IPC 入参 schema
import { z } from 'zod'

/** NOTES_CREATE 入参 */
export const notesCreateSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional()
})

/** NOTES_UPDATE 第二参 patch */
export const notesUpdatePatchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string()).optional()
})

/** NOTES_CREATE_FROM_MESSAGE 入参 */
export const notesCreateFromMessageSchema = z.object({
  title: z.string().optional(),
  content: z.string()
})
