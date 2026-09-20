// 工具调用人工审批服务（shell_exec 等 confirm 级工具）
//
// 主流程：引擎判定需确认 → createApproval() 广播审批事件给渲染端并等待；
// 渲染端弹窗应答 → ipc 调 resolveApproval(id, bool) 放行/拒绝。
// 5 分钟无应答或 Agent 中止 → 自动按「拒绝」处理，防止 Promise 泄漏与悬空审批。
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/types'
import type { ToolApprovalRequestEvent } from '../../shared/types'

type EmitFn = (channel: string, data: unknown) => void

interface PendingApproval {
  settle: (approved: boolean) => void
  timer: NodeJS.Timeout
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const pending = new Map<string, PendingApproval>()

/**
 * 发起一次审批：广播事件并返回用户应答 Promise。
 * @param req 除 approvalId 外的审批内容
 * @param emit 引擎注入的事件广播函数
 * @param signal Agent 中止信号（abort 时按拒绝处理）
 */
export function createApproval(
  req: Omit<ToolApprovalRequestEvent, 'approvalId'>,
  emit: EmitFn,
  signal?: AbortSignal
): Promise<boolean> {
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
      timer: setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(approvalId, entry)

    const event: ToolApprovalRequestEvent = { ...req, approvalId }
    emit(IPC.AGENT_TOOL_APPROVAL_EVENT, event)
  })
}

/** 渲染端应答入口；返回是否匹配到待审批项（幂等：重复应答返回 false） */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  entry.settle(approved)
  return true
}
