// 主进程运行态注册表（B-2 / B-3）。
//
// 为什么需要它：渲染层过去只知道「自己发起的那一轮」在不在跑（useStreamSession 按 requestId 过滤），
// 渠道/远程/独立窗口发起的 run 在侧栏完全看不见；`conversations.status` 又已被停写（D7）。
// 这里以「每会话一个活跃 run」为键（与 agent-conversation-guard-459 的并发约束一致），
// 内存是事实来源，事件广播给所有渲染窗口，快照供窗口后开/聚焦时对齐。
//
// 持久化通过 `setRuntimePersistence` 注入（index.ts 在启动时接上 conversation-run.repo）：
// 注册表本身**不 import 数据库**，否则引擎/审批这些纯逻辑模块的单测会被 database→portable→electron
// 的模块初始化拖下水。写库失败不影响运行本身；重启后由 reconcileInterruptedRuns() 把残留的
// running/pending_approval 标成 interrupted。
// 失败态（failed）不自动过期：侧栏一直显示，直到用户打开该会话（clearFailure）才清除。
import { createLogger } from '../logger'
import type { ChatConversationStateEvent, ChatRuntimeState, ChatRuntimeStateEvent } from '../../shared/types'

const logger = createLogger('runtime')

type VisibleState = Exclude<ChatRuntimeState, 'idle'>

export type ConversationRunMode = 'chat' | 'agent'

export interface RuntimeRunSeed {
  requestId: string
  conversationId: string
  mode: ConversationRunMode
  startedAt: number
}

/** 由 index.ts 注入的落地面（conversation-run.repo 结构上满足它） */
export interface RuntimePersistence {
  start(run: RuntimeRunSeed): void
  setStatus(requestId: string, status: 'running' | 'pending_approval'): void
  finish(
    requestId: string,
    status: 'done' | 'failed' | 'aborted' | 'interrupted',
    errorCode?: string | null
  ): void
  interruptActive(): Array<RuntimeRunSeed & { status: string }>
}

interface RuntimeEntry {
  conversationId: string
  requestId: string
  mode: ConversationRunMode
  state: VisibleState
  startedAt: number
  at: number
  pendingApprovals: number
  errorCode?: string
}

const entries = new Map<string, RuntimeEntry>()
/**
 * 由 chat 注册入口注入（只有那里拿得到 BrowserWindow）；测试/启动早期为空时只更新内存。
 * B-4 起这条通道同时承载未读事件（`kind='unread'`），仍是同一个订阅，不另开通道。
 */
let broadcaster: ((event: ChatConversationStateEvent) => void) | null = null
let persistence: RuntimePersistence | null = null
/**
 * B-4：一轮正常结束时的未读钩子。由 index.ts 注入（未读实现要读库，而本文件刻意不 import 数据库，
 * 否则引擎/审批这些纯逻辑单测会被 database→portable→electron 的模块初始化拖下水）。
 */
let unreadHook: ((conversationId: string) => void) | null = null

export function setRuntimeStateBroadcaster(fn: ((event: ChatConversationStateEvent) => void) | null): void {
  broadcaster = fn
}

export function setRuntimePersistence(p: RuntimePersistence | null): void {
  persistence = p
}

export function setConversationUnreadHook(fn: ((conversationId: string) => void) | null): void {
  unreadHook = fn
}

/** 未读事件走运行态同一条广播（供 unread-state 使用） */
export function publishConversationState(event: ChatConversationStateEvent): void {
  broadcaster?.(event)
}

function toEvent(e: RuntimeEntry): ChatRuntimeStateEvent {
  return {
    conversationId: e.conversationId,
    requestId: e.requestId,
    mode: e.mode,
    state: e.state,
    startedAt: e.startedAt,
    at: e.at,
    pendingApprovals: e.pendingApprovals,
    errorCode: e.errorCode
  }
}

function publish(e: RuntimeEntry): void {
  broadcaster?.(toEvent(e))
}

function publishIdle(conversationId: string, requestId: string | null): void {
  broadcaster?.({ conversationId, requestId, state: 'idle', at: Date.now() })
}

/** run 开始：登记并落 running。同会话已有活跃 run 时不覆盖（并发守卫正常会先拦住） */
export function markRunStarted(args: {
  conversationId: string
  requestId: string
  mode: ConversationRunMode
}): void {
  const prev = entries.get(args.conversationId)
  if (prev && prev.requestId !== args.requestId && prev.state !== 'failed' && prev.state !== 'interrupted') {
    logger.warn(`会话 ${args.conversationId} 已有活跃 run ${prev.requestId}，忽略新 run ${args.requestId} 的登记`)
    return
  }
  const startedAt = prev?.requestId === args.requestId ? prev.startedAt : Date.now()
  const entry: RuntimeEntry = {
    conversationId: args.conversationId,
    requestId: args.requestId,
    mode: args.mode,
    state: 'running',
    startedAt,
    at: Date.now(),
    pendingApprovals: 0
  }
  entries.set(args.conversationId, entry)
  persistence?.start({ ...args, startedAt })
  publish(entry)
}

/** 审批挂起：待确认计数 +1，状态切 pending_approval */
export function markApprovalPending(conversationId: string | undefined, requestId: string): void {
  if (!conversationId) return
  const e = entries.get(conversationId)
  if (!e || e.requestId !== requestId) return
  if (e.state !== 'running' && e.state !== 'pending_approval') return
  e.pendingApprovals += 1
  e.state = 'pending_approval'
  e.at = Date.now()
  persistence?.setStatus(requestId, 'pending_approval')
  publish(e)
}

/** 审批已裁决（允许/拒绝/超时/中止）：计数 -1，归零后回到 running */
export function markApprovalSettled(conversationId: string | undefined, requestId: string): void {
  if (!conversationId) return
  const e = entries.get(conversationId)
  if (!e || e.requestId !== requestId) return
  if (e.pendingApprovals > 0) e.pendingApprovals -= 1
  if (e.pendingApprovals === 0 && e.state === 'pending_approval') {
    e.state = 'running'
    persistence?.setStatus(requestId, 'running')
  }
  e.at = Date.now()
  publish(e)
}

/**
 * run 结束：done/aborted 移出注册表（角标消失）；failed 保留到用户打开会话。
 * 与 requestId 不匹配的迟到回调只落库、不动当前登记。
 */
export function markRunFinished(
  conversationId: string,
  requestId: string,
  status: 'done' | 'failed' | 'aborted',
  errorCode?: string
): void {
  persistence?.finish(requestId, status, errorCode ?? null)
  const e = entries.get(conversationId)
  if (!e || e.requestId !== requestId) return
  if (status === 'failed') {
    e.state = 'failed'
    e.at = Date.now()
    e.pendingApprovals = 0
    e.errorCode = errorCode
    publish(e)
    return
  }
  // B-4：一轮正常结束＝多了一条助手消息。是否真的记未读（正在读/子会话/写库失败）由钩子判断；
  // 放在「requestId 匹配」之后，迟到的旧 run 回调不会把新一轮的会话误标未读。
  if (status === 'done') unreadHook?.(conversationId)
  entries.delete(conversationId)
  publishIdle(conversationId, requestId)
}

/** 用户打开会话时清除「失败/已中断」角标；返回是否真的清掉了 */
export function clearFailure(conversationId: string): boolean {
  const e = entries.get(conversationId)
  if (!e || (e.state !== 'failed' && e.state !== 'interrupted')) return false
  entries.delete(conversationId)
  publishIdle(conversationId, e.requestId)
  return true
}

/** 窗口挂载/聚焦时的快照（含未清除的失败与上次启动遗留的已中断） */
export function getRuntimeSnapshot(): ChatRuntimeStateEvent[] {
  return [...entries.values()].map(toEvent)
}

/**
 * 启动对账：把上一进程残留的 running/pending_approval 标成 interrupted，并种进注册表，
 * 让侧栏能显示一次「已中断」。只允许在「进程刚独占数据」的启动路径调用（同 sweepStaleStreamingMessages）。
 * @returns 本次改到的 run 数
 */
export function reconcileInterruptedRuns(): number {
  const rows = persistence?.interruptActive() ?? []
  for (const r of rows) {
    entries.set(r.conversationId, {
      conversationId: r.conversationId,
      requestId: r.requestId,
      mode: r.mode,
      state: 'interrupted',
      startedAt: r.startedAt,
      at: Date.now(),
      pendingApprovals: 0
    })
  }
  if (rows.length > 0) logger.info(`标记中断的运行 ${rows.length} 条`)
  return rows.length
}

/** 测试用：清空内存登记与广播器 */
export function resetRuntimeRegistryForTest(): void {
  entries.clear()
  broadcaster = null
}
