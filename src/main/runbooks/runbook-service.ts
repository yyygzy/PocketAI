// P1-5 第一刀：从一次成功的 run 生成流程模板，并在套用前校验引用。
//
// 取舍：
//  · 只从**成功结束**的 run 生成（`conversation_runs.status='done'`，老数据回落成"trace 没有 error 步"）；
//  · 模板只存形状：工具序列、参数键名、提示词摘要、引用清单；
//    授权恒为空（导入/新建都一样），由用户在面板里重勾——SEC-3 同口径；
//  · 引用不在导入时过滤（与助手导入相反）：模板缺引用是"跑不出那条流程"，
//    要留到套用前把缺的清单列出来，而不是悄悄删掉让模板看起来没问题。
import fs from 'node:fs'
import { agentTraceRepo } from '../db/repositories/agent-trace.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { conversationRunRepo } from '../db/repositories/conversation-run.repo'
import { kbRepo } from '../db/repositories/kb.repo'
import { mcpServerRepo } from '../db/repositories/mcp-server.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { runbookRepo, type RunbookInsert } from '../db/repositories/runbook.repo'
import { skillRepo } from '../db/repositories/skill.repo'
import {
  extractRunbookSteps,
  isAbsolutePathLike,
  missingRunbookRefs,
  summarizePrompt,
  uniqueRunbookTools,
  type RunbookRecord,
  type RunbookRef
} from '../../shared/runbook'

/** 工具名 → 授权 id / MCP Server id 的解析器（主进程由 toolRegistry 提供；测试注入假实现） */
export interface RunbookToolResolver {
  toolId: (toolName: string) => string | null
  mcpServerId: (toolName: string) => string | null
}

export interface CreateRunbookInput {
  requestId: string
  /** 展示名；空则回落到会话标题 */
  name?: string
}

export interface CreateRunbookDeps {
  resolveTool?: RunbookToolResolver
}

/**
 * 从一次 run 生成模板。
 * 失败一律抛 Error（IPC 层转成 `{ok:false,error}`）——生成不出模板时不能返回半份数据。
 */
export function createRunbookFromRun(input: CreateRunbookInput, deps: CreateRunbookDeps = {}): RunbookRecord {
  const requestId = String(input.requestId ?? '').trim()
  if (!requestId) throw new Error('缺少运行标识')

  const run = conversationRunRepo.getByRequest(requestId)
  if (run && run.status !== 'done') {
    throw new Error('这次运行没有成功结束，不能存成模板')
  }

  const traces = agentTraceRepo.listByRequest(requestId)
  if (traces.length === 0) throw new Error('这次运行没有留下步骤记录')
  // 老库可能没有 conversation_runs 行：退化成看 trace 有没有失败步（子 run 的步不参与判定）
  if (!run && traces.some((t) => t.status === 'error')) {
    throw new Error('这次运行有失败步骤，不能存成模板')
  }

  const resolver = deps.resolveTool
  const steps = extractRunbookSteps(traces, resolver ? (name) => resolver.toolId(name) : undefined)
  if (steps.length === 0) throw new Error('这次运行没有工具步骤，存不成流程模板')

  const conversationId = run?.conversationId ?? traces[0]!.conversationId
  const conversation = conversationRepo.get(conversationId)
  const anchor = run?.anchorUserMessageId ? messageRepo.getById(run.anchorUserMessageId) : null
  const promptSummary = summarizePrompt(anchor?.content ?? conversation?.title ?? '')

  const refs: RunbookRef[] = []
  const seen = new Set<string>()
  const pushRef = (ref: RunbookRef): void => {
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key) || refs.length >= 50) return
    seen.add(key)
    refs.push(ref)
  }

  const assistant = conversation?.assistantId ? assistantRepo.get(conversation.assistantId) : null
  for (const skillId of assistant?.skillIds ?? []) {
    pushRef({ kind: 'skill', id: skillId, label: skillRepo.get(skillId)?.name ?? skillId })
  }
  for (const kbId of assistant?.knowledgeBaseIds ?? []) {
    pushRef({ kind: 'knowledge_base', id: kbId, label: kbRepo.get(kbId)?.name ?? kbId })
  }
  if (resolver) {
    for (const tool of uniqueRunbookTools(steps)) {
      const serverId = resolver.mcpServerId(tool.toolName)
      if (!serverId) continue
      pushRef({ kind: 'mcp', id: serverId, label: mcpServerRepo.get(serverId)?.name ?? serverId })
    }
  }
  if (run?.workspaceDir && isAbsolutePathLike(run.workspaceDir)) {
    pushRef({ kind: 'path', id: run.workspaceDir, label: run.workspaceDir })
  }

  const name =
    String(input.name ?? '').trim().slice(0, 100) ||
    (conversation?.title ?? '').trim().slice(0, 100) ||
    'Runbook'

  const insert: RunbookInsert = {
    name,
    promptSummary,
    steps,
    refs,
    // 模板不携带授权：本地新建同样从空开始（用户在面板里逐条勾）
    toolPermissions: []
  }
  return runbookRepo.insert(insert)
}

/** 套用前校验：只回答"哪些引用在这台机器上找不到"，不修改模板 */
export function checkRunbookRefs(id: string): RunbookRef[] {
  const runbook = runbookRepo.get(id)
  if (!runbook) throw new Error('模板不存在')
  return missingRunbookRefs(runbook.refs, {
    skillIds: new Set(skillRepo.list().map((s) => s.id)),
    knowledgeBaseIds: new Set(kbRepo.list().map((k) => k.id)),
    mcpServerIds: new Set(mcpServerRepo.list().map((m) => m.id)),
    pathExists: (p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    }
  })
}
