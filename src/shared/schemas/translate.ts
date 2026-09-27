// 翻译 IPC 入参 schema
// text 原样进入 LLM 翻译请求（token 消耗面），glossary 术语落库，带宽松上限。
import { z } from 'zod'

const TRANSLATE_MAX_TEXT_CHARS = 20_000
const TRANSLATE_MAX_TERM_CHARS = 200
const TRANSLATE_MAX_ID_CHARS = 64
const TRANSLATE_MAX_MODEL_CHARS = 200

const translateLangSchema = z.enum([
  'auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'ru', 'es', 'zh-TW'
])

const targetLangSchema = translateLangSchema.exclude(['auto'])

const translateStyleSchema = z.enum(['standard', 'fluent', 'literal', 'formal'])

/** TRANSLATE_RUN 入参 */
export const translateRequestSchema = z.object({
  requestId: z.string().min(1).max(TRANSLATE_MAX_ID_CHARS),
  providerId: z.string().min(1).max(TRANSLATE_MAX_ID_CHARS),
  model: z.string().min(1).max(TRANSLATE_MAX_MODEL_CHARS),
  sourceLang: translateLangSchema,
  targetLang: targetLangSchema,
  style: translateStyleSchema,
  text: z.string().min(1, '文本不能为空').max(TRANSLATE_MAX_TEXT_CHARS, '文本过长（最多 20000 字符）'),
  glossaryEnabled: z.boolean()
})

/** GLOSSARY_SAVE 入参 */
export const glossarySaveSchema = z.object({
  sourceTerm: z.string().min(1, '源术语不能为空').max(TRANSLATE_MAX_TERM_CHARS),
  targetTerm: z.string().min(1, '译法不能为空').max(TRANSLATE_MAX_TERM_CHARS)
})
