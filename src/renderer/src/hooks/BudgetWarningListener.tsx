// 预算 80% 软预警广播订阅：每轮对话 usage 落库后主进程检查，跨越阈值时弹一次 toast
// 必须挂在 ToastProvider 内部（useToast 依赖），渲染 null
import { useEffect } from 'react'
import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'

export function BudgetWarningListener() {
  const toast = useToast()
  const { t } = useI18n()

  useEffect(() => {
    let off: (() => void) | undefined
    try {
      off = window.pocketai.onUsageBudgetWarning((e) => {
        toast.warning(
          t('usage.budgetWarnToast', {
            scope: t(e.scope === 'daily' ? 'usage.scopeDaily' : 'usage.scopeMonthly'),
            cost: e.cost.toFixed(2),
            limit: e.limit.toFixed(2),
            pct: Math.round(e.ratio * 100)
          })
        )
      })
    } catch (e2) {
      reportIpcError('usage.budgetWarningSubscribe')(e2)
    }
    return () => off?.()
  }, [toast, t])

  return null
}
