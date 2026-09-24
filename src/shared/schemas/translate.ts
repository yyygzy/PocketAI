// 翻译 IPC 入参 schema
import { z } from 'zod'

const translateLangSchema = z.enum([
  'auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'ru', 'es', 'zh-TW'
])

const targetLangSchema = translateLangSchema.exclude(['auto'])

const translateStyleSchema = z.enum(['standard', 'fluent', 'literal', 'formal'])

/** TRANSLATE_RUN 入参 */
export const translateRequestSchema = z.object({
  requestId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  sourceLang: translateLangSchema,
  targetLang: targetLangSchema,
  style: translateStyleSchema,
  text: z.string().min(1, '文本不能为空'),
  glossaryEnabled: z.boolean()
})

/** GLOSSARY_SAVE 入参 */
export const glossarySaveSchema = z.object({
  sourceTerm: z.string().min(1, '源术语不能为空'),
  targetTerm: z.string().min(1, '译法不能为空')
})
