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

// ─── 导入边界常量（外部导出文件 = 不可信输入，普通/加密两条导入路径共用） ──────

/** 单次导入消息条数上限（防伪造超大文件 DoS 写库） */
export const CONVERSATION_IMPORT_MAX_MESSAGES = 10000
/** 单条消息内容字符上限（约 100 万字符，正常长对话远小于此） */
export const CONVERSATION_IMPORT_MAX_CONTENT_CHARS = 1_000_000
/** 会话标题字符上限 */
export const CONVERSATION_IMPORT_MAX_TITLE_CHARS = 500
/** assistantId / provider / model 等短字段字符上限 */
export const CONVERSATION_IMPORT_MAX_LABEL_CHARS = 200

/** 加密导入文件字节上限（解密前；防选中数 GB 文件直接读爆内存） */
export const CONVERSATION_IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024

/**
 * 导入消息宽松结构：兼容旧版本/他端导出（id、时间戳等可缺），
 * 但 role 必须合法、content 必须是字符串且有长度上限，非法结构直接拒绝。
 */
export const conversationImportMessageSchema = z.object({
  id: z.string().min(1).max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).optional(),
  role: messageRoleSchema,
  content: z.string().max(CONVERSATION_IMPORT_MAX_CONTENT_CHARS).default(''),
  provider: z.string().max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).nullable().optional(),
  model: z.string().max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).nullable().optional(),
  status: messageStatusSchema.optional(),
  parentId: z.string().min(1).max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).nullable().optional(),
  createdAt: z.number().int().nonnegative().optional()
})

/** 加密导入的会话元信息（只取落库需要的字段，其余忽略） */
export const conversationImportMetaSchema = z.object({
  assistantId: z.string().min(1).max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).nullable().optional(),
  title: z.string().max(CONVERSATION_IMPORT_MAX_TITLE_CHARS).optional(),
  modelLabel: z.string().max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).nullable().optional()
})

/** CONVERSATION_IMPORT_ENCRYPTED 解密后内容校验（比完整导出 schema 宽松） */
export const conversationImportDataSchema = z.object({
  conversation: conversationImportMetaSchema,
  messages: z.array(conversationImportMessageSchema).max(CONVERSATION_IMPORT_MAX_MESSAGES)
})
export type ConversationImportData = z.infer<typeof conversationImportDataSchema>

/** CONVERSATION_IMPORT 入参（本端完整导出格式，字段齐全；同样受导入上限约束） */
export const conversationExportPayloadSchema = z.object({
  version: z.number().int().positive(),
  exportedAt: z.number().int().nonnegative(),
  conversation: conversationRecordSchema.extend({
    title: z.string().max(CONVERSATION_IMPORT_MAX_TITLE_CHARS)
  }),
  messages: z
    .array(
      messageRecordSchema.extend({
        content: z.string().max(CONVERSATION_IMPORT_MAX_CONTENT_CHARS)
      })
    )
    .max(CONVERSATION_IMPORT_MAX_MESSAGES),
  assistant: z.unknown().nullable().optional()
})

/** CONVERSATION_IMPORT_EXTERNAL 入参：files（渲染端读好的文本，1-10 个/单文件≤30MB）+ 可选归属助手 */
export const conversationImportExternalArgsSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        text: z.string().max(30 * 1024 * 1024)
      })
    )
    .min(1)
    .max(10),
  /** 归属助手 id；null/缺省=自由会话（主进程再校验存在性，无效回落 null） */
  assistantId: z.string().min(1).max(CONVERSATION_IMPORT_MAX_LABEL_CHARS).nullish()
})

/** CONVERSATION_LIST 可选参：(assistantId?, isAgent?, archivedOnly?) */
export const conversationListArgsSchema = z.tuple([
  z.string().nullable().optional(),
  z.boolean().optional(),
  z.boolean().optional()
])

/** CONVERSATION_CREATE 入参：(assistantId?, title?) */
export const conversationCreateArgsSchema = z.tuple([
  z.string().nullable().optional(),
  z.string().optional()
])

/** CONVERSATION_SET_SYSTEM_PROMPT_OVERRIDE 入参：(conversationId, text|null) */
export const conversationSetSystemPromptOverrideArgsSchema = z.tuple([
  z.string().min(1).max(64),
  z.string().max(100_000).nullable()
])
