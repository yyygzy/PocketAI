// 运行中排队条的结算规则（P2 / V4-Iter-459）。
//
// 背景（方案 §5 的第二条冲突）：队列原先靠 Agent 壳自己的 `onAgentDone/onAgentError` 订阅结算。
// 过渡期两个壳都会保活，若把结算挪到「观测 hook」的 `onStreamsSettled` 上，观测 hook 不订阅
// （对话页没挂载、或只挂了消息流）就会让队列永远 drain 不了。定稿走另一条允许支路：
// **队列由持有队列的 hook 自己订阅结算**，并按 `(requestId, clientRef)` 幂等——
// 两个订阅各自结算一次也不会重复发下一条。
//
// 这里的两个函数都是纯函数：结算需要的队列快照、是否自动发、能不能发全部由调用方传入，
// 幂等账本由调用方持有。这样队列规则可以被确定性用例钉住（`agent-queue-settlement-459.test.ts`），
// 不依赖 React 挂载或真实 IPC 事件。

/** 运行中排队的一条消息（渲染层内存态，不落库） */
export interface AgentQueueItem {
  /** 渲染层生成的本地 id，随插队请求交给引擎，再原样回到 step 事件里（对账用） */
  clientRef: string
  /** 排队项属于哪条会话：切会话不丢，切回来还在条上 */
  conversationId: string
  text: string
  /**
   * true = 已经交给引擎、等它在下个步边界收下。
   * 只有 `interject` 事件能把它消掉；运行结束（DONE/ERROR）时还挂着的一律视为**没送到**，
   * 退回排队等自动发送——宁可重发一次，也不能让用户那句话凭空消失。
   */
  interjecting: boolean
}

/** `(requestId, clientRef)` 幂等账本：同一轮最多自动发一条、同一条排队项最多被发一次 */
export interface RunSettlementLedger {
  /** 已经为这一轮挑过自动发送项的 requestId（一个 DONE/ERROR 只驱动一次 drain） */
  settledRuns: Set<string>
  /** 已自动发出过的 `(requestId, clientRef)` */
  sent: Set<string>
}

export function createRunSettlementLedger(): RunSettlementLedger {
  return { settledRuns: new Set(), sent: new Set() }
}

function settleKey(requestId: string, clientRef: string): string {
  return `${requestId}\u0000${clientRef}`
}

/**
 * 插队事件对账：引擎已把这句话收进这一轮（`interject` 步事件带同一个 clientRef）。
 *
 * 幂等：按 clientRef 过滤本身就是幂等操作——同一个事件重复到达时第二次结果不变；
 * 即使调用方拿到的是旧队列快照，也不会因为"上次已经删过"而把新条目留下。
 * (requestId 对账由调用方在收事件前用 `fromThisRun` 完成。)
 */
export function applyInterjectEvent(queue: AgentQueueItem[], clientRef: string): AgentQueueItem[] {
  return queue.filter((q) => q.clientRef !== clientRef)
}

export interface SettleRunQueueOptions {
  /** 只结算这条会话的排队项 */
  conversationId: string
  /** 刚结束的这一轮（幂等键的一半） */
  requestId: string
  /** 只有正常跑完、且用户正看着这条会话时才自动发下一条；中止/出错/后台会话都不发 */
  autoSend: boolean
  /** 发送前置条件（模型/会话仍在、没有别的运行在跑）；不满足时只归位，不弹出条目 */
  canAutoSend: boolean
}

export interface SettleRunQueueResult {
  /** 归位后的队列（插队中但没收到事件的一律退回普通排队） */
  queue: AgentQueueItem[]
  /** 本轮要自动发出的那一条；null = 不发 */
  next: AgentQueueItem | null
}

/**
 * 一轮结束后的结算：
 * ① 还挂着「已交给引擎」的项归回排队——没收到 `interject` 事件就是没落库，不归回会永远消失；
 * ② `autoSend && canAutoSend` 时取这条会话最早的一条普通排队项，登记 `(requestId, clientRef)`
 *    后从队列里摘掉，交给调用方发送。第二个订阅者再结算同一轮时：队列里已经没有它，
 *    即使拿到旧快照，账本也会拦住重复发送。
 */
export function settleRunQueue(
  queue: AgentQueueItem[],
  opts: SettleRunQueueOptions,
  ledger: RunSettlementLedger
): SettleRunQueueResult {
  const normalized = queue.map((q) =>
    q.conversationId === opts.conversationId && q.interjecting ? { ...q, interjecting: false } : q
  )
  if (!opts.autoSend || !opts.canAutoSend) return { queue: normalized, next: null }
  // 一个 DONE/ERROR 只驱动一次 drain：两个订阅各结算一次时，第二次不再把下一条也发出去
  if (ledger.settledRuns.has(opts.requestId)) return { queue: normalized, next: null }
  ledger.settledRuns.add(opts.requestId)
  const next = normalized.find(
    (q) =>
      q.conversationId === opts.conversationId &&
      !q.interjecting &&
      !ledger.sent.has(settleKey(opts.requestId, q.clientRef))
  )
  if (!next) return { queue: normalized, next: null }
  ledger.sent.add(settleKey(opts.requestId, next.clientRef))
  return { queue: normalized.filter((q) => q.clientRef !== next.clientRef), next }
}
