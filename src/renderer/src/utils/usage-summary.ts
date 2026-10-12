// 会话级用量汇总（渲染端聚合，零 IPC）：
// 对当前会话全部 assistant 消息的 usage 求和——与 usage-service 账单口径一致，
// 分支重跑产生的多批次消息各自真实计费，全部计入（用户看到的是「这个会话实际花了多少」）。
import type { MessageRecord, UsagePricing } from '../../../shared/types'
import { computeUsageCost, priceKey, roundCost } from '../../../shared/usage-pricing'

export interface SessionUsageSummary {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  cost: number
  /** 计入统计的 assistant 消息条数（带 usage 的 done 消息） */
  counted: number
}

export function sumMessagesUsage(
  messages: MessageRecord[],
  pricing?: UsagePricing | null
): SessionUsageSummary {
  const sum: SessionUsageSummary = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    cost: 0,
    counted: 0
  }
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue
    sum.counted += 1
    sum.promptTokens += m.usage.promptTokens || 0
    sum.completionTokens += m.usage.completionTokens || 0
    sum.cachedTokens += m.usage.cachedTokens || 0
    sum.totalTokens += m.usage.totalTokens || 0
    if (pricing && m.provider && m.model) {
      const price = pricing.prices[priceKey(m.provider, m.model)]
      if (price) sum.cost += computeUsageCost(m.usage, price)
    }
  }
  sum.cost = roundCost(sum.cost)
  return sum
}

/**
 * 每条 assistant 消息「到本条为止的会话累计 token」（按消息列表顺序前缀和）。
 *
 * 为什么单独算：累计口径与 `sumMessagesUsage` 完全一致（含分支重跑的每一批），只是**截到某一条**，
 * 这样每个回答后面能就地看到"到目前为止花了多少"，不必滚回消息流顶部。
 * 无 usage 的消息（user、流式中、老数据）不推进累计，也不进表 ⇒ 调用方按 `get(id)` 缺省即不显示。
 */
export function cumulativeTokensByMessage(messages: MessageRecord[]): Map<string, number> {
  const out = new Map<string, number>()
  let running = 0
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue
    running += m.usage.totalTokens || 0
    out.set(m.id, running)
  }
  return out
}
