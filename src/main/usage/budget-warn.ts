// 预算 80% 软预警接线：usage 落库成功后调用，新跨越阈值的周期广播给所有窗口 toast。
// 纯判定与周期去重在 usageService（KV 标记）；本文件只负责广播，异常绝不影响对话主链路。
import { IPC } from '../../shared/types'
import type { BudgetWarnBroadcastEvent } from '../../shared/types'
import { broadcast } from '../ipc/broadcast'
import { createLogger } from '../logger'
import { usageService } from './usage-service'
import { getUsagePricing } from './pricing-config'

const log = createLogger('budget-warn')

export function checkAndBroadcastBudgetWarnings(): void {
  try {
    const pricing = getUsagePricing()
    const events = usageService.consumeBudgetWarnings(pricing.prices)
    for (const ev of events) {
      // 币种与金额同源（都出自这一次 getUsagePricing）⇒ 渲染端文案的符号不会与估算口径错位
      const payload: BudgetWarnBroadcastEvent = { ...ev, currency: pricing.currency }
      broadcast(IPC.USAGE_BUDGET_WARNING_EVENT, payload)
    }
  } catch (e) {
    log.warn('预算软预警检查失败（不影响对话）:', e)
  }
}
