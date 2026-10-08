// 助手配置导入导出纯函数（供单测；IPC handler 只做 IO 与编排）
// 导出：剔除 id/createdAt/isBuiltin/isPinned（导入侧重新生成；内置助手不导出，重装自带）。
// 导入：kbIds/skillIds 按目标库现存 id 过滤丢弃（跨机必然失效），provider/model 原样保留。
import type { AssistantRecord } from './types'

export const ASSISTANT_EXPORT_VERSION = 1

/** 导出文件中单个助手的可移植字段（白名单） */
export interface AssistantExportItem {
  name: string
  description: string
  avatar: string
  systemPrompt: string
  welcomeMessage: string
  defaultProviderId: string | null
  defaultModel: string | null
  defaultParams: Record<string, unknown> | null
  toolPermissions: string[]
  skillIds: string[]
  knowledgeBaseIds: string[]
}

export interface AssistantExportPayload {
  version: number
  assistants: AssistantExportItem[]
}

/** 从记录列表构建导出载荷（只收非内置助手，字段白名单） */
export function buildAssistantExportPayload(records: AssistantRecord[]): AssistantExportPayload {
  return {
    version: ASSISTANT_EXPORT_VERSION,
    assistants: records
      .filter((r) => !r.isBuiltin)
      .map((r) => ({
        name: r.name,
        description: r.description,
        avatar: r.avatar,
        systemPrompt: r.systemPrompt,
        welcomeMessage: r.welcomeMessage,
        defaultProviderId: r.defaultProviderId,
        defaultModel: r.defaultModel,
        defaultParams: r.defaultParams,
        toolPermissions: r.toolPermissions,
        skillIds: r.skillIds,
        knowledgeBaseIds: r.knowledgeBaseIds
      }))
  }
}

export interface AssistantImportDraft {
  name: string
  description: string
  avatar: string
  systemPrompt: string
  welcomeMessage: string
  defaultProviderId: string | null
  defaultModel: string | null
  defaultParams: Record<string, unknown> | null
  toolPermissions: string[]
  skillIds: string[]
  knowledgeBaseIds: string[]
}

export interface AssistantImportResolved {
  draft: AssistantImportDraft
  /** 因目标库不存在而被丢弃的知识库/技能 id 数 */
  droppedKb: number
  droppedSkills: number
  /** 导入文件里声明但被清空的教学工具授权数（SEC-3：导入不携带授权） */
  droppedTools: number
}

const asStr = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''
const asStrOrNull = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v ? v.slice(0, max) : null
const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const asParams = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * 解析单条导入项：非法（缺 name）返回 null（调用方计 skipped）；
 * 合法项按现存 kb/skill id 过滤，返回 draft 与丢弃计数。
 */
export function resolveAssistantImportItem(
  raw: unknown,
  existingKbIds: ReadonlySet<string>,
  existingSkillIds: ReadonlySet<string>
): AssistantImportResolved | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = asStr(o.name, 100).trim()
  if (!name) return null

  const kbIds = asStrArray(o.knowledgeBaseIds)
  const skillIds = asStrArray(o.skillIds)
  const keptKb = kbIds.filter((id) => existingKbIds.has(id))
  const keptSkills = skillIds.filter((id) => existingSkillIds.has(id))
  // SEC-3：导入的助手一律不携带工具授权。文件里的 toolPermissions 可以是 ['*']
  // （含 shell_exec / fs_write / js_eval），而系统提示词与描述同样随文件进来，
  // 等于「拿到一个助手 JSON 就拿到一个全授权 Agent」。授权必须由用户在助手编辑器里逐条重勾。
  const declaredTools = asStrArray(o.toolPermissions)

  return {
    draft: {
      name,
      description: asStr(o.description, 500),
      avatar: asStr(o.avatar, 100) || '🤖',
      systemPrompt: asStr(o.systemPrompt, 100_000),
      welcomeMessage: asStr(o.welcomeMessage, 2000),
      defaultProviderId: asStrOrNull(o.defaultProviderId, 64),
      defaultModel: asStrOrNull(o.defaultModel, 200),
      defaultParams: asParams(o.defaultParams),
      toolPermissions: [],
      skillIds: keptSkills,
      knowledgeBaseIds: keptKb
    },
    droppedKb: kbIds.length - keptKb.length,
    droppedSkills: skillIds.length - keptSkills.length,
    droppedTools: declaredTools.length
  }
}
