// 流程模板（runbook）：把一次成功 Agent run 的骨架存成可复用模板。
//
// 与「助手配置导出」不是同一件东西：
//  · 助手导出的是**身份与配置**（系统提示词、模型、技能/知识库绑定）；
//  · 流程模板导出的是**一次运行的流程形状**（工具序列 + 提示词摘要 + 参数名占位 + 引用清单）。
//
// 安全口径（与 SEC-3 一致）：模板**不携带任何工具授权**。
// 导出的 JSON 里没有 `toolPermissions`；导入时即使文件里带了也一律丢弃，
// 由用户在模板面板里逐条重勾。参数只留**键名**，值不进模板（那里可能有密钥/本机路径）。

/** 引用种类：技能 / 知识库 / MCP Server / 绝对路径 */
export type RunbookRefKind = 'skill' | 'knowledge_base' | 'mcp' | 'path'

export interface RunbookRef {
  kind: RunbookRefKind
  /** skill / kb / mcp 的库 id；kind='path' 时是绝对路径 */
  id: string
  /** 展示名（导入到别的机器后 id 失效，也要能说清缺的是什么） */
  label: string
}

export interface RunbookStep {
  /** 模型侧工具名（一次工具步并行多个时已按调用顺序拆开） */
  toolName: string
  /** 授权用的工具 id（`kb.search` / `mcp:<server>:<tool>`）；生成时解析不到为 null */
  toolId: string | null
  /** 原调用里的参数**键名**（值一律不进模板） */
  argKeys: string[]
}

/** 本地模板记录（库里一行）；toolPermissions 只在本机有效，导出时剔除 */
export interface RunbookRecord {
  id: string
  name: string
  promptSummary: string
  steps: RunbookStep[]
  refs: RunbookRef[]
  toolPermissions: string[]
  createdAt: number
  updatedAt: number
}

export const RUNBOOK_EXPORT_VERSION = 1

/** 提示词摘要上限：模板不是对话存档，留一句"当初要做什么"就够 */
export const RUNBOOK_SUMMARY_MAX = 500
export const RUNBOOK_NAME_MAX = 100
export const RUNBOOK_STEPS_MAX = 40
export const RUNBOOK_ARG_KEYS_MAX = 20
export const RUNBOOK_REFS_MAX = 50
/** 一次导入最多接受多少条模板（防畸形文件把库撑爆） */
export const RUNBOOK_IMPORT_MAX = 200

const REF_KINDS: ReadonlyArray<RunbookRef['kind']> = ['skill', 'knowledge_base', 'mcp', 'path']

const asStr = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const asTrimmed = (v: unknown, max: number): string => asStr(v, max).trim()

/** 绝对路径判据（渲染端与主进程共用，不 import node:path） */
export function isAbsolutePathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/**
 * 从 trace 的 `tool_args` 单行里取参数**键名**。
 * 写库格式见 engine.capRedactedToolCallArgs：`<toolName> <json>`，值是脱敏后的原文。
 * 这里只回答"它当时传了哪几个参数"，不保留任何值。
 */
function argKeysOfLine(line: string): string[] {
  const sp = line.indexOf(' ')
  if (sp < 0) return []
  const json = line.slice(sp + 1).trim()
  if (!json.startsWith('{')) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.keys(parsed as Record<string, unknown>).slice(0, RUNBOOK_ARG_KEYS_MAX)
  } catch {
    return []
  }
}

/** 只认工具步：一次工具步可能并行调了多个工具（`toolName` 是逗号分隔），按调用顺序拆开 */
export interface RunbookTraceLike {
  stepType: string
  toolName?: string
  toolArgs?: string
}

export function extractRunbookSteps(
  traces: ReadonlyArray<RunbookTraceLike>,
  resolveToolId?: (toolName: string) => string | null
): RunbookStep[] {
  const out: RunbookStep[] = []
  for (const trace of traces) {
    if (out.length >= RUNBOOK_STEPS_MAX) break
    if (trace.stepType !== 'tools') continue
    const names = (trace.toolName ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    if (names.length === 0) continue
    const lines = (trace.toolArgs ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0)
    names.forEach((name, i) => {
      if (out.length >= RUNBOOK_STEPS_MAX) return
      const line = lines[i] ?? ''
      out.push({
        toolName: name.slice(0, 200),
        toolId: resolveToolId ? (resolveToolId(name) ?? null) : null,
        argKeys: line ? argKeysOfLine(line) : []
      })
    })
  }
  return out
}

/** 提示词摘要：压平空白后截断，避免把整段粘贴内容搬进模板 */
export function summarizePrompt(text: string | null | undefined, max = RUNBOOK_SUMMARY_MAX): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 步骤里去重后的工具（授权勾选项的来源；同一工具只出现一次） */
export function uniqueRunbookTools(steps: ReadonlyArray<RunbookStep>): Array<{ toolName: string; toolId: string }> {
  const seen = new Set<string>()
  const out: Array<{ toolName: string; toolId: string }> = []
  for (const s of steps) {
    const id = s.toolId ?? s.toolName
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ toolName: s.toolName, toolId: id })
  }
  return out
}

// ---------- 导出 ----------

export interface RunbookExportItem {
  name: string
  promptSummary: string
  steps: RunbookStep[]
  refs: RunbookRef[]
}

export interface RunbookExportPayload {
  version: number
  /** 与资源管理器里的「助手配置导出」区分：这里只描述流程 */
  kind: 'pocketai.runbooks'
  runbooks: RunbookExportItem[]
}

/**
 * 导出载荷：字段白名单。
 * `id` / `createdAt` / `updatedAt` / `toolPermissions` 一律不写——
 * 授权是「这台机器上的这个人」的决定，不随文件走（SEC-3）。
 */
export function buildRunbookExportPayload(records: ReadonlyArray<RunbookRecord>): RunbookExportPayload {
  return {
    version: RUNBOOK_EXPORT_VERSION,
    kind: 'pocketai.runbooks',
    runbooks: records.map((r) => ({
      name: r.name,
      promptSummary: r.promptSummary,
      steps: r.steps.map((s) => ({
        toolName: s.toolName,
        toolId: s.toolId ?? null,
        argKeys: [...s.argKeys]
      })),
      refs: r.refs.map((ref) => ({ kind: ref.kind, id: ref.id, label: ref.label }))
    }))
  }
}

// ---------- 导入 ----------

export interface RunbookImportDraft {
  name: string
  promptSummary: string
  steps: RunbookStep[]
  refs: RunbookRef[]
  /** 恒为空：导入不携带授权 */
  toolPermissions: string[]
}

export interface RunbookImportResolved {
  draft: RunbookImportDraft
  /** 文件里声明过、但被丢弃的工具授权条数（用于如实告诉用户"要重勾"） */
  droppedTools: number
  /** 无法识别的引用条数（坏数据只丢这一条，不整单失败） */
  droppedRefs: number
}

function parseSteps(raw: unknown): { steps: RunbookStep[]; dropped: number } {
  if (!Array.isArray(raw)) return { steps: [], dropped: 0 }
  const steps: RunbookStep[] = []
  let dropped = 0
  for (const item of raw.slice(0, RUNBOOK_STEPS_MAX)) {
    if (!item || typeof item !== 'object') {
      dropped++
      continue
    }
    const o = item as Record<string, unknown>
    const toolName = asTrimmed(o.toolName, 200)
    if (!toolName) {
      dropped++
      continue
    }
    const toolId = typeof o.toolId === 'string' && o.toolId.trim() ? asTrimmed(o.toolId, 200) : null
    const argKeys = Array.isArray(o.argKeys)
      ? o.argKeys.filter((k): k is string => typeof k === 'string').map((k) => k.slice(0, 100)).slice(0, RUNBOOK_ARG_KEYS_MAX)
      : []
    steps.push({ toolName, toolId, argKeys })
  }
  return { steps, dropped }
}

function parseRefs(raw: unknown): { refs: RunbookRef[]; dropped: number } {
  if (!Array.isArray(raw)) return { refs: [], dropped: 0 }
  const refs: RunbookRef[] = []
  let dropped = 0
  for (const item of raw.slice(0, RUNBOOK_REFS_MAX)) {
    if (!item || typeof item !== 'object') {
      dropped++
      continue
    }
    const o = item as Record<string, unknown>
    const kind = asTrimmed(o.kind, 40) as RunbookRef['kind']
    const id = asTrimmed(o.id, 500)
    if (!id || !REF_KINDS.includes(kind)) {
      dropped++
      continue
    }
    refs.push({ kind, id, label: asTrimmed(o.label, 300) || id })
  }
  return { refs, dropped }
}

/**
 * 解析单条导入项。缺 name 返回 null（调用方计 skipped）。
 * 关键行为：文件里若带 `toolPermissions`，只计数、不采纳（SEC-3）。
 */
export function resolveRunbookImportItem(raw: unknown): RunbookImportResolved | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = asTrimmed(o.name, RUNBOOK_NAME_MAX)
  if (!name) return null
  const parsedSteps = parseSteps(o.steps)
  const parsedRefs = parseRefs(o.refs)
  const declaredTools = Array.isArray(o.toolPermissions)
    ? o.toolPermissions.filter((t): t is string => typeof t === 'string')
    : []
  return {
    draft: {
      name,
      promptSummary: summarizePrompt(asStr(o.promptSummary, RUNBOOK_SUMMARY_MAX)),
      steps: parsedSteps.steps,
      refs: parsedRefs.refs,
      toolPermissions: []
    },
    droppedTools: declaredTools.length,
    droppedRefs: parsedRefs.dropped
  }
}

// ---------- 启动前校验 ----------

export interface RunbookRefLookup {
  skillIds: ReadonlySet<string>
  knowledgeBaseIds: ReadonlySet<string>
  mcpServerIds: ReadonlySet<string>
  /** 绝对路径是否存在（主进程传 fs.existsSync；渲染端不调用本函数） */
  pathExists: (path: string) => boolean
}

/** 列出当前机器上找不到的引用（空数组＝全部可解析） */
export function missingRunbookRefs(
  refs: ReadonlyArray<RunbookRef>,
  lookup: RunbookRefLookup
): RunbookRef[] {
  const missing: RunbookRef[] = []
  for (const ref of refs) {
    let ok = false
    switch (ref.kind) {
      case 'skill':
        ok = lookup.skillIds.has(ref.id)
        break
      case 'knowledge_base':
        ok = lookup.knowledgeBaseIds.has(ref.id)
        break
      case 'mcp':
        ok = lookup.mcpServerIds.has(ref.id)
        break
      case 'path':
        ok = isAbsolutePathLike(ref.id) && lookup.pathExists(ref.id)
        break
      default:
        ok = false
    }
    if (!ok) missing.push(ref)
  }
  return missing
}

export interface RunbookApplyGate {
  missingRefs: RunbookRef[]
  /** 模板有工具序列、但本地一个工具授权都没勾 */
  toolPermissionsEmpty: boolean
  /** true ⇒ 不允许套用（渲染端必须把原因列出来，不能静默失败） */
  blocked: boolean
}

/**
 * 套用前的唯一闸门：缺引用 / 授权为空都拦下。
 * 授权为空必须拦：模板本来就不带授权，不勾就等于让 Agent 在无授权下跑一条它跑不动的序列。
 */
export function evaluateRunbookApply(
  runbook: Pick<RunbookRecord, 'steps' | 'toolPermissions'>,
  missingRefs: ReadonlyArray<RunbookRef>
): RunbookApplyGate {
  const toolPermissionsEmpty = runbook.steps.length > 0 && runbook.toolPermissions.length === 0
  return {
    missingRefs: [...missingRefs],
    toolPermissionsEmpty,
    blocked: missingRefs.length > 0 || toolPermissionsEmpty
  }
}
