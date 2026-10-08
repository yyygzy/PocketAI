// 工具调用人工审批服务（shell_exec 等 confirm 级工具）
//
// 主流程：引擎判定需确认 → 命中会话级「总是允许」白名单则直接放行；
// 否则 createApproval() 广播审批事件给渲染端并等待；
// 渲染端弹窗应答（可勾选本次会话总是允许）→ ipc 调 resolveApproval(id, bool, alwaysAllow) 放行/拒绝。
// 5 分钟无应答或 Agent 中止 → 自动按「拒绝」处理，防止 Promise 泄漏与悬空审批。
//
// 白名单粒度（SEC-13）：会话 + 工具名 + **规范化参数指纹**。
// 只按工具名放行意味着「同意一次 rm ./build」后同会话的 curl|sh 也免确认；
// 参数指纹把复用限定在「同一工具同一操作」上，用户点一次只放过一次实际动作。
import { randomUUID, createHash } from 'node:crypto'
import { IPC } from '../../shared/types'
import type { ToolApprovalRequestEvent } from '../../shared/types'

type EmitFn = (channel: string, data: unknown) => void

interface PendingApproval {
  settle: (approved: boolean) => void
  timer: NodeJS.Timeout
  conversationId?: string
  /** 白名单键：toolName + 参数指纹（见 toolAllowKey） */
  allowKey?: string
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
/** 单会话「总是允许」的条目上限，防无限增长 */
const SESSION_ALLOW_MAX = 50

const pending = new Map<string, PendingApproval>()
/** 会话级白名单：conversationId → 已允许的 allowKey 集合（不落库，进程生命周期） */
const sessionAllows = new Map<string, Set<string>>()

/** 递归按 key 排序后序列化：模型改写参数顺序/空白不应改变指纹 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(',')}}`
}

/**
 * 参数指纹（纯函数，导出供单测）：解析成功走规范化 JSON，失败退回原文；
 * 空参数与缺省参数统一，避免「同一工具两种键」把白名单撑爆。
 */
export function toolArgsFingerprint(argsJson: string | null | undefined): string {
  const raw = String(argsJson ?? '').trim()
  if (!raw) return 'sha:' + createHash('sha256').update('{}').digest('hex').slice(0, 16)
  let normalized = raw
  try {
    normalized = stableStringify(JSON.parse(raw))
  } catch {
    /* 非法 JSON 由引擎上游 BAD_ARGS 拦截；这里保底用原文，不放大也不缩小复用范围 */
  }
  return 'sha:' + createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** 白名单键：工具名 + 参数指纹（MCP 工具名已按 server 作用域唯一，天然带 server 维度） */
export function toolAllowKey(toolName: string | undefined, argsJson: string | null | undefined): string {
  return `${toolName ?? ''}::${toolArgsFingerprint(argsJson)}`
}

function markSessionAllow(conversationId: string | undefined, allowKey: string | undefined): void {
  if (!conversationId || !allowKey) return
  let set = sessionAllows.get(conversationId)
  if (!set) {
    set = new Set()
    sessionAllows.set(conversationId, set)
  }
  // FIFO 淘汰：超上限时删最旧（Set 迭代按插入序）
  if (set.size >= SESSION_ALLOW_MAX && !set.has(allowKey)) {
    const oldest = set.values().next().value
    if (oldest) set.delete(oldest)
  }
  set.add(allowKey)
}

function isSessionAllowed(conversationId: string | undefined, allowKey: string | undefined): boolean {
  if (!conversationId || !allowKey) return false
  return sessionAllows.get(conversationId)?.has(allowKey) ?? false
}

/** 会话删除/切换时清空白名单，避免残留 */
export function clearSessionAllow(conversationId: string): void {
  sessionAllows.delete(conversationId)
}

/**
 * 发起一次审批：先查会话级白名单（命中则直接放行），否则广播事件并返回用户应答 Promise。
 * @param req 除 approvalId 外的审批内容
 * @param emit 引擎注入的事件广播函数
 * @param signal Agent 中止信号（abort 时按拒绝处理）
 * @param argsJson 本次调用的原始参数 JSON，参与「总是允许」的粒度判定
 */
export function createApproval(
  req: Omit<ToolApprovalRequestEvent, 'approvalId'>,
  emit: EmitFn,
  signal?: AbortSignal,
  argsJson?: string | null
): Promise<boolean> {
  // 会话级「总是允许」：同一会话内同工具同参数不再弹窗
  const allowKey = toolAllowKey(req.toolName, argsJson)
  if (isSessionAllowed(req.conversationId, allowKey)) {
    return Promise.resolve(true)
  }

  const approvalId = randomUUID()

  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearTimeout(entry.timer)
      signal?.removeEventListener('abort', onAbort)
      pending.delete(approvalId)
    }
    const settle = (approved: boolean) => {
      if (!pending.has(approvalId)) return // 已超时/已应答：幂等忽略
      cleanup()
      resolve(approved)
    }

    const onAbort = () => settle(false)

    // 已中止：不登记 pending、不建定时器，直接按拒绝返回
    if (signal?.aborted) {
      resolve(false)
      return
    }

    const entry: PendingApproval = {
      settle,
      timer: setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS),
      conversationId: req.conversationId,
      allowKey
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(approvalId, entry)

    const event: ToolApprovalRequestEvent = { ...req, approvalId }
    emit(IPC.AGENT_TOOL_APPROVAL_EVENT, event)
  })
}

/**
 * 渲染端应答入口；返回是否匹配到待审批项（幂等：重复应答返回 false）。
 * @param alwaysAllow 勾选「本次会话总是允许」时，后续同会话同工具直接放行
 */
export function resolveApproval(
  approvalId: string,
  approved: boolean,
  alwaysAllow = false
): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  if (approved && alwaysAllow) markSessionAllow(entry.conversationId, entry.allowKey)
  entry.settle(approved)
  return true
}

/** 测试用：重置全部状态 */
export function resetApprovalStateForTest(): void {
  pending.forEach((e) => {
    clearTimeout(e.timer)
  })
  pending.clear()
  sessionAllows.clear()
}
