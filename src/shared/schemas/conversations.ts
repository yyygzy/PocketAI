// 会话 IPC 入参 schema
import { z } from 'zod'

const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])
const messageStatusSchema = z.enum(['streaming', 'done', 'error', 'aborted'])

const messageRecordSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  status: messageStatusSchema.optional(),
  parentId: z.string().nullable().optional(),
  createdAt: z.number().int().nonnegative().optional()
})

const conversationRecordSchema = z.object({
  id: z.string().min(1),
  assistantId: z.string().nullable(),
  title: z.string(),
  modelLabel: z.string().nullable(),
  status: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

/** CONVERSATION_IMPORT 入参 */
export const conversationExportPayloadSchema = z.object({
  version: z.number().int().positive(),
  exportedAt: z.number().int().nonnegative(),
  conversation: conversationRecordSchema,
  messages: z.array(messageRecordSchema),
  assistant: z.unknown().nullable().optional()
})

/** CONVERSATION_LIST 可选参：(assistantId?, isAgent?) */
export const conversationListArgsSchema = z.tuple([
  z.string().nullable().optional(),
  z.boolean().optional()
])

/** CONVERSATION_CREATE 入参：(assistantId?, title?) */
export const conversationCreateArgsSchema = z.tuple([
  z.string().nullable().optional(),
  z.string().optional()
])
