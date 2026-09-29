// 知识库 IPC 入参 schema
// KB_SAVE 入参为 Partial<KnowledgeBase> & { name: string }；
// 文档摄取的 URL/文本字段需校验，防止恶意 URL 或空内容进入摄取管线。
// URL 抓取下游走 safeFetch（SSRF 已收口），此处仅补协议白名单与资源上限。
import { z } from 'zod'

// ─── 资源上限（宽松，正常使用不可达） ────────────────────────────
const KB_MAX_NAME_CHARS = 100
const KB_MAX_DESC_CHARS = 500
const KB_MAX_ID_CHARS = 64
const KB_MAX_MODEL_CHARS = 200
/** 分块参数上限（rag 常规 256~2048，宽松给足） */
const KB_MAX_CHUNK_SIZE = 8192
const KB_MAX_CHUNK_OVERLAP = 2048
const KB_MAX_TOP = 100
const KB_MAX_URL_CHARS = 2048
const KB_MAX_TITLE_CHARS = 500
/** 纯文本摄入上限：与单条会话 content 对齐（进 embedding + 落库） */
const KB_MAX_TEXT_CHARS = 1_000_000
const KB_MAX_QUERY_CHARS = 4000
const KB_MAX_RETRIEVE_KBS = 20

/** http(s) URL：KB_DOC_ADD_URL 只接受网页抓取（下游 safeFetch），禁 ftp/file 等奇异协议 */
const kbHttpUrlSchema = z
  .string()
  .max(KB_MAX_URL_CHARS)
  .url('URL 不合法')
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, '仅支持 http(s) URL')

const knowledgeBaseFull = z.object({
  id: z.string().min(1).max(KB_MAX_ID_CHARS),
  name: z.string().min(1).max(KB_MAX_NAME_CHARS),
  description: z.string().max(KB_MAX_DESC_CHARS),
  embeddingProviderId: z.string().max(KB_MAX_ID_CHARS).nullable(),
  embeddingModel: z.string().max(KB_MAX_MODEL_CHARS).nullable(),
  embeddingDim: z.number().int().positive().max(8192).nullable(),
  chunkSize: z.number().int().positive().max(KB_MAX_CHUNK_SIZE),
  chunkOverlap: z.number().int().nonnegative().max(KB_MAX_CHUNK_OVERLAP),
  topK: z.number().int().positive().max(KB_MAX_TOP),
  topN: z.number().int().positive().max(KB_MAX_TOP),
  rerankProviderId: z.string().max(KB_MAX_ID_CHARS).nullable(),
  rerankModel: z.string().max(KB_MAX_MODEL_CHARS).nullable(),
  hydeProviderId: z.string().max(KB_MAX_ID_CHARS).nullable(),
  hydeModel: z.string().max(KB_MAX_MODEL_CHARS).nullable(),
  multiQueryProviderId: z.string().max(KB_MAX_ID_CHARS).nullable(),
  multiQueryModel: z.string().max(KB_MAX_MODEL_CHARS).nullable(),
  documentCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative()
})

/** KB_SAVE 入参 */
export const kbSaveSchema = knowledgeBaseFull
  .partial()
  .extend({ name: z.string().min(1).max(KB_MAX_NAME_CHARS) })

/** KB_DOC_ADD_URL 入参：(kbId, url, title?) */
export const kbDocAddUrlArgsSchema = z.tuple([
  z.string().min(1).max(KB_MAX_ID_CHARS),
  kbHttpUrlSchema,
  z.string().max(KB_MAX_TITLE_CHARS).optional()
])

/** KB_DOC_ADD_TEXT 入参：(kbId, text, title) */
export const kbDocAddTextArgsSchema = z.tuple([
  z.string().min(1).max(KB_MAX_ID_CHARS),
  z.string().min(1, '文本不能为空').max(KB_MAX_TEXT_CHARS),
  z.string().min(1, '标题不能为空').max(KB_MAX_TITLE_CHARS)
])

/** KB_RETRIEVE 入参：(kbIds, query) */
export const kbRetrieveArgsSchema = z.tuple([
  z.array(z.string().min(1).max(KB_MAX_ID_CHARS)).max(KB_MAX_RETRIEVE_KBS),
  z.string().min(1, '检索 query 不能为空').max(KB_MAX_QUERY_CHARS)
])
