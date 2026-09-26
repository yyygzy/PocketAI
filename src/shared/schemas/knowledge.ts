// 知识库 IPC 入参 schema
// KB_SAVE 入参为 Partial<KnowledgeBase> & { name: string }；
// 文档摄取的 URL/文本字段需校验，防止恶意 URL 或空内容进入摄取管线。
import { z } from 'zod'

const knowledgeBaseFull = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  embeddingProviderId: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  embeddingDim: z.number().int().nullable(),
  chunkSize: z.number().int().positive(),
  chunkOverlap: z.number().int().nonnegative(),
  topK: z.number().int().positive(),
  topN: z.number().int().positive(),
  rerankProviderId: z.string().nullable(),
  rerankModel: z.string().nullable(),
  hydeProviderId: z.string().nullable(),
  hydeModel: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative()
})

/** KB_SAVE 入参 */
export const kbSaveSchema = knowledgeBaseFull
  .partial()
  .extend({ name: z.string().min(1) })

/** KB_DOC_ADD_URL 入参：(kbId, url, title?) */
export const kbDocAddUrlArgsSchema = z.tuple([
  z.string().min(1),
  z.string().url('URL 不合法'),
  z.string().optional()
])

/** KB_DOC_ADD_TEXT 入参：(kbId, text, title) */
export const kbDocAddTextArgsSchema = z.tuple([
  z.string().min(1),
  z.string().min(1, '文本不能为空'),
  z.string().min(1, '标题不能为空')
])

/** KB_RETRIEVE 入参：(kbIds, query) */
export const kbRetrieveArgsSchema = z.tuple([
  z.array(z.string().min(1)),
  z.string().min(1, '检索 query 不能为空')
])
