// P1-5：per-run 工具授权通道（第三刀）。
//
// 现状（v74 及以前）：模板确认只落在模板行的 `tool_permissions`，套用只填提示词；
// run 侧每次从助手配置重算授权面，两者是两条线。这一刀把「这一轮确认过哪些工具」
// 变成 run 起点的**有效工具集快照** E，写进 `conversation_runs.tool_scope_json`：
//   · 新 run（开关打开 + 带 grant）：E = 用户勾选集 R，且必须逐条通过助手基线 B 的复核；
//   · 无 grant / 开关关闭：E = B，与旧 run 完全一致（scope 不写，续跑走旧口径）；
//   · 续跑：E 用落库的 scope，不再按「当前助手」重算——助手后来增删工具不会悄悄改工具面。
//
// 判权只走注册表的 `isToolAllowedBy`：`'*'` 只覆盖内置，MCP 必须逐条 id。
// 这里不复制那条规则，避免和 filterByPermissions / classify / execute 三处分叉。
import { dbService } from '../db/database'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { isToolAllowedBy, toolRegistry } from '../tools/registry'
import type { RunToolGrant, RunToolScope, ChatResumeBlockCode } from '../../shared/types'

/** 开关键：默认关闭；关闭时渲染端不发 grant、主进程也不认，行为与 v74 一致 */
export const PER_RUN_TOOL_GRANT_KEY = 'agent.perRunToolGrant'

/**
 * 开关读取。
 * 读不出来（库没开/配置表异常）一律按关闭处理：这属于"新路径"，
 * 不能因为读失败就把用户没确认过的工具放开。
 */
export function isPerRunToolGrantEnabled(): boolean {
  try {
    if (!dbService.isOpen()) return false
    return appConfigRepo.get(PER_RUN_TOOL_GRANT_KEY) === '1'
  } catch {
    return false
  }
}

/** 启动前复核失败的两个回码（渲染端按 code 出四语文案） */
export type RunToolGrantCode = 'RUN_TOOL_NOT_GRANTED' | 'RUN_TOOL_UNAVAILABLE'

/**
 * 回码错误统一走 `CODE:说明` 形状（与 chat-service 其余拒绝一致）。
 * 每个分支写整串字面量而不是拼 `code`：回码对账闸门只认源码里的完整字面量。
 */
function grantError(code: RunToolGrantCode, toolIds: string[]): Error {
  switch (code) {
    case 'RUN_TOOL_NOT_GRANTED':
      return new Error(`RUN_TOOL_NOT_GRANTED:${toolIds.join(',')}`)
    case 'RUN_TOOL_UNAVAILABLE':
      return new Error(`RUN_TOOL_UNAVAILABLE:${toolIds.join(',')}`)
  }
}

/** 容错解析：NULL/空串/坏 JSON 都回 null（调用方用原始字符串是否为空来区分"旧 run"与"坏数据"） */
export function parseRunToolScope(json: string | null | undefined): RunToolScope | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<RunToolScope>
    if (!parsed || parsed.v !== 1) return null
    if (parsed.mode !== 'assistant' && parsed.mode !== 'runbook') return null
    if (!Array.isArray(parsed.toolIds)) return null
    const toolIds = parsed.toolIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (toolIds.length !== parsed.toolIds.length) return null
    return {
      v: 1,
      mode: parsed.mode,
      runbookId: typeof parsed.runbookId === 'string' ? parsed.runbookId : undefined,
      toolIds
    }
  } catch {
    return null
  }
}

/** 两个工具集是否一致（去重、排序后比较；续跑时用来判断模板勾选有没有被改） */
export function sameToolSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  const norm = (ids: ReadonlyArray<string>): string[] => Array.from(new Set(ids)).sort()
  const x = norm(a)
  const y = norm(b)
  return x.length === y.length && x.every((id, i) => id === y[i])
}

/**
 * 启动前把渲染端的 grant 复核成 run 的 scope + 有效工具集。
 * 三条红线：
 * 1) 只收窄、绝不放大：每个 id 必须被当前助手基线允许（`isToolAllowedBy`）；
 * 2) 不静默求交集：勾了没权限/不存在的工具 → 抛错，让用户回到确认页改勾选；
 * 3) 空勾选不收：UI 已有 `unconfirmed` 拦截，后端再兜一层，避免出现"0 个工具"的 run。
 */
export function resolveRunToolScope(
  basePermissions: string[],
  grant: RunToolGrant
): { scope: RunToolScope; effective: string[] } {
  const ids = Array.from(new Set(grant.toolIds))
  if (ids.length === 0) throw grantError('RUN_TOOL_NOT_GRANTED', [])
  const allowed = new Set(basePermissions)
  const byId = new Map(toolRegistry.listAll().map((t) => [t.id, t]))
  const notGranted: string[] = []
  const unavailable: string[] = []
  for (const id of ids) {
    const schema = byId.get(id)
    if (!schema) {
      unavailable.push(id)
      continue
    }
    if (!isToolAllowedBy(allowed, schema)) notGranted.push(id)
  }
  if (notGranted.length > 0) throw grantError('RUN_TOOL_NOT_GRANTED', notGranted)
  if (unavailable.length > 0) throw grantError('RUN_TOOL_UNAVAILABLE', unavailable)
  return {
    scope: { v: 1, mode: 'runbook', runbookId: grant.runbookId, toolIds: ids },
    effective: ids
  }
}

/**
 * 续跑时按落库的 scope 复核（不做哈希，哈希一致性由调用方按既有口径比）。
 * 返回 null 表示可续；否则给出**分档后**的回码：
 * · 工具不在注册表（被删/MCP 未启动）→ `RESUME_TOOL_UNAVAILABLE`；
 * · 助手收回了 run 已确认的权限 → `RESUME_TOOL_PERMISSIONS_REVOKED`。
 * 模板勾选是否被改由调用方查 runbook 行后判 `RESUME_TOOL_GRANT_CHANGED`。
 */
export function checkRunToolScopeForResume(
  scope: RunToolScope,
  basePermissions: string[]
): ChatResumeBlockCode | null {
  if (scope.mode !== 'runbook') return null
  const allowed = new Set(basePermissions)
  const byId = new Map(toolRegistry.listAll().map((t) => [t.id, t]))
  for (const id of scope.toolIds) {
    const schema = byId.get(id)
    if (!schema) return 'RESUME_TOOL_UNAVAILABLE'
    if (!isToolAllowedBy(allowed, schema)) return 'RESUME_TOOL_PERMISSIONS_REVOKED'
  }
  return null
}
