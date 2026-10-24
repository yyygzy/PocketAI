// §281：内置助手的 name / description / welcomeMessage 在四本字典里有本地化版本；
// 渲染层不再读 DB 里的原始中文串，走这三个 helper。非内置走原值（用户自己起的名字不许翻译）。
//
// 键**逐字枚举**而不是拼模板：`i18n-dead-keys` 对 `assistant.builtin.${id}.name` 这种动态族是整族免检的
// （§156 那次 `judgement.reason.${code}` 就是这么漏过 94 把键的）——写死成 Record 里每一项，
// 扫描器看得见每一把键、也能反向钉"不许少一把"。
import type { AssistantRecord } from '../../../../shared/types'

export const BUILTIN_ASSISTANT_IDS = [
  'asst-default',
  'asst-writer',
  'asst-academic',
  'asst-analyst',
  'asst-pm',
  'asst-translator',
  'asst-tutor',
  'asst-coder'
] as const

export type BuiltinAssistantId = (typeof BUILTIN_ASSISTANT_IDS)[number]

type KeyTriple = { name: string; description: string; welcomeMessage: string }

export const BUILTIN_I18N_KEYS: Record<BuiltinAssistantId, KeyTriple> = {
  'asst-default': {
    name: 'assistant.builtin.asst-default.name',
    description: 'assistant.builtin.asst-default.description',
    welcomeMessage: 'assistant.builtin.asst-default.welcomeMessage'
  },
  'asst-writer': {
    name: 'assistant.builtin.asst-writer.name',
    description: 'assistant.builtin.asst-writer.description',
    welcomeMessage: 'assistant.builtin.asst-writer.welcomeMessage'
  },
  'asst-academic': {
    name: 'assistant.builtin.asst-academic.name',
    description: 'assistant.builtin.asst-academic.description',
    welcomeMessage: 'assistant.builtin.asst-academic.welcomeMessage'
  },
  'asst-analyst': {
    name: 'assistant.builtin.asst-analyst.name',
    description: 'assistant.builtin.asst-analyst.description',
    welcomeMessage: 'assistant.builtin.asst-analyst.welcomeMessage'
  },
  'asst-pm': {
    name: 'assistant.builtin.asst-pm.name',
    description: 'assistant.builtin.asst-pm.description',
    welcomeMessage: 'assistant.builtin.asst-pm.welcomeMessage'
  },
  'asst-translator': {
    name: 'assistant.builtin.asst-translator.name',
    description: 'assistant.builtin.asst-translator.description',
    welcomeMessage: 'assistant.builtin.asst-translator.welcomeMessage'
  },
  'asst-tutor': {
    name: 'assistant.builtin.asst-tutor.name',
    description: 'assistant.builtin.asst-tutor.description',
    welcomeMessage: 'assistant.builtin.asst-tutor.welcomeMessage'
  },
  'asst-coder': {
    name: 'assistant.builtin.asst-coder.name',
    description: 'assistant.builtin.asst-coder.description',
    welcomeMessage: 'assistant.builtin.asst-coder.welcomeMessage'
  }
}

type T = (key: string, params?: Record<string, string | number>) => string

// `t()` 找不到键时原样返回键名（`dicts[lang]?.[key] ?? dicts.zh?.[key] ?? key`），
// 这一层再兜底一次回落到 DB 里的原始串——新加的内置助手在字典补上前不该显示裸键。
function resolve(a: AssistantRecord, field: keyof KeyTriple, raw: string, t: T): string {
  if (!a.isBuiltin) return raw
  const k = BUILTIN_I18N_KEYS[a.id as BuiltinAssistantId]?.[field]
  if (!k) return raw
  const v = t(k)
  return v === k ? raw : v
}

export function assistantDisplayName(a: AssistantRecord, t: T): string {
  return resolve(a, 'name', a.name, t)
}

export function assistantDisplayDescription(a: AssistantRecord, t: T): string {
  return resolve(a, 'description', a.description, t)
}

export function assistantDisplayWelcome(a: AssistantRecord, t: T): string {
  return resolve(a, 'welcomeMessage', a.welcomeMessage, t)
}

/**
 * §281：只有 assistantId、没有整条 AssistantRecord 的场合（用量排行里的聚合行）
 * —— 命中内置 id 就返回字典里本地化的 name，否则 null 让调用方回落到 DB 里的原始串。
 */
export function builtinAssistantNameById(assistantId: string | null | undefined, t: T): string | null {
  if (!assistantId) return null
  const k = BUILTIN_I18N_KEYS[assistantId as BuiltinAssistantId]?.name
  if (!k) return null
  const v = t(k)
  return v === k ? null : v
}
