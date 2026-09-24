// 翻译主进程服务
//
// 职责：
//  - 构造翻译 system 提示词（语言对、风格、术语表、只输出译文约束）；
//  - 复用 providerManager 的 OpenAI 兼容适配器 streamChat 发起流式请求；
//  - 通过 emitter 回调把译文增量广播给渲染端；
//  - 支持 AbortController 中途停止；
//  - 翻译成功后写入历史表（停止/失败不写）。
import { providerManager } from '../providers/manager'
import { errMsg, isAbortError } from '../error'
import { translationRepo } from '../db/repositories/translation.repo'
import type {
  GlossaryTerm,
  TranslateLang,
  TranslateRequestPayload,
  TranslateStyle
} from '../../shared/types'
import { translateRequestSchema } from '../../shared/schemas/translate'

/** 翻译结果（IPC 直接返回给渲染端） */
export type TranslateResult =
  | { ok: true; content: string }
  | { ok: false; aborted: boolean; error: string }

/** 语言代码 → 提示词内使用的中文名称（提示词保持中文，独立于 UI i18n） */
const LANG_NAMES: Record<TranslateLang, string> = {
  auto: '自动检测',
  zh: '简体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
  es: '西班牙语',
  'zh-TW': '繁体中文'
}

/** 风格要求文案 */
const STYLE_HINTS: Record<TranslateStyle, string> = {
  standard: '采用自然、规范且忠实于原文的通用翻译风格',
  fluent: '在忠实原文的前提下优先保证译文流畅地道，符合目标语言母语者的表达习惯',
  literal: '采用贴近原文语序与措辞的直译风格，尽量保留原文的句子结构',
  formal: '采用正式、严谨、书面化的表达，适用于公文与商务场景'
}

/** 流式增量回调（由 IPC 层注入，负责广播到渲染窗口） */
export type TranslateChunkEmitter = (requestId: string, delta: string) => void

/**
 * 构造翻译 system 提示词（导出便于走查）
 * glossary 传空数组即不注入术语段（对应渲染端术语开关关闭）。
 */
export function buildSystemPrompt(opts: {
  sourceLang: TranslateLang
  targetLang: Exclude<TranslateLang, 'auto'>
  style: TranslateStyle
  glossary: GlossaryTerm[]
}): string {
  const { sourceLang, targetLang, style, glossary } = opts

  const sourceLine =
    sourceLang === 'auto'
      ? '源语言：未指定，请先自行识别原文语言，再翻译为目标语言。'
      : `源语言：${LANG_NAMES[sourceLang]}。`

  const glossaryBlock =
    glossary.length > 0
      ? [
          '',
          '术语表（下列术语必须严格使用指定译法，并保持全文一致）：',
          ...glossary.map((g) => `- ${g.sourceTerm} = ${g.targetTerm}`)
        ].join('\n')
      : ''

  return [
    '你是一位资深专业翻译，精通多种语言与跨文化表达。',
    `任务：把用户提供的文本翻译为${LANG_NAMES[targetLang]}。`,
    sourceLine,
    `风格：${STYLE_HINTS[style]}。`,
    '',
    '要求：',
    '1. 只输出译文本身，不要添加任何解释、注释、背景说明，也不要复述原文。',
    '2. 保持原文的段落结构、换行、列表与 Markdown 格式；',
    '   数字、代码、命令、URL、邮箱、占位符（如 {name}、%s）保持原样，不要翻译。',
    '3. 遇到多义词时，选择最符合上下文的常见译法；专有名词已有通用中文/外文写法时采用通用写法。',
    glossaryBlock
  ]
    .filter((s) => s !== '')
    .join('\n')
}

/** 进行中的翻译请求：requestId → AbortController */
const controllers = new Map<string, AbortController>()

/** 发起一次翻译；流式增量通过 emit 广播，最终结果作为 IPC 返回值 */
export async function runTranslate(
  payload: TranslateRequestPayload,
  emit: TranslateChunkEmitter
): Promise<TranslateResult> {
  translateRequestSchema.parse(payload)
  const controller = new AbortController()
  controllers.set(payload.requestId, controller)

  try {
    const adapter = providerManager.getAdapter(payload.providerId)
    const provider = providerManager.getRecord(payload.providerId)
    const glossary = payload.glossaryEnabled ? translationRepo.glossaryList() : []

    const systemPrompt = buildSystemPrompt({
      sourceLang: payload.sourceLang,
      targetLang: payload.targetLang,
      style: payload.style,
      glossary
    })

    const result = await adapter.streamChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: payload.text }
      ],
      { model: payload.model, temperature: 0.3, signal: controller.signal },
      {
        onDelta: (delta) => {
          if (delta) emit(payload.requestId, delta)
        }
      }
    )

    const content = (result.content ?? '').trim()

    // 仅成功完成时写历史；用户停止或请求失败不写
    translationRepo.historyAdd({
      sourceText: payload.text,
      targetText: content,
      sourceLang: payload.sourceLang,
      targetLang: payload.targetLang,
      style: payload.style,
      providerId: payload.providerId,
      providerName: provider.name,
      model: payload.model
    })

    return { ok: true, content }
  } catch (e) {
    return { ok: false, aborted: isAbortError(e), error: errMsg(e) }
  } finally {
    controllers.delete(payload.requestId)
  }
}

/** 中止指定请求；无对应请求时静默忽略 */
export function abortTranslate(requestId: string): void {
  controllers.get(requestId)?.abort()
}
