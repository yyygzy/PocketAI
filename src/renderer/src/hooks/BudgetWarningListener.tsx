// 预算 80% 软预警广播订阅：每轮对话 usage 落库后主进程检查，跨越阈值时弹一次 toast
// 必须挂在 ToastProvider 内部（useToast 依赖），渲染 null
import { useEffect } from 'react'
import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'
import { currencySymbolOf } from '../../../shared/usage-pricing'

export function BudgetWarningListener() {
  const toast = useToast()
  const { t } = useI18n()

  useEffect(() => {
    let off: (() => void) | undefined
    let offStop: (() => void) | undefined
    try {
      off = window.pocketai.onUsageBudgetWarning((e) => {
        toast.warning(
          t('usage.budgetWarnToast', {
            scope: t(e.scope === 'daily' ? 'usage.scopeDaily' : 'usage.scopeMonthly'),
            // 符号跟着这次估算所用的币种走（事件载荷带的），不再写死 ¥
            symbol: currencySymbolOf(e.currency),
            cost: e.cost.toFixed(2),
            limit: e.limit.toFixed(2),
            pct: Math.round(e.ratio * 100)
          })
        )
      })
      // 金额预算触顶后 Agent 循环已收尾停止：这是"本轮停了"，与 80% 软预警的"快到上限"分开说
      offStop = window.pocketai.onUsageBudgetStop((e) => {
        // 两条分支各用字面量 key：保持动态 key 调用点数量不变（闸门会钉住这个数）
        const scope = e.scope === 'daily' ? t('usage.scopeDaily') : t('usage.scopeMonthly')
        toast.warning(
          t('usage.budgetStopped', {
            scope,
            symbol: currencySymbolOf(e.currency),
            limit: e.limit.toFixed(2)
          })
        )
      })
    } catch (e2) {
      reportIpcError('usage.budgetWarningSubscribe')(e2)
    }
    return () => {
      off?.()
      offStop?.()
    }
  }, [toast, t])

  return null
}
