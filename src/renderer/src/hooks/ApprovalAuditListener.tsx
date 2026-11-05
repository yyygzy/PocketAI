// 审批审计写失败广播订阅（P0-2c-1）：fail-open，不阻断工具执行，但绝不能静默
// 主进程每进程只广播一次（见 src/main/agent/approval-audit.ts），这里弹一条可见的 warning toast；
// 失败计数常驻在「设置 → 数据健康」里，不靠 toast 消失后的记忆。
// 与 BudgetWarningListener 同款：必须挂在 ToastProvider 内部（useToast 依赖），渲染 null。
import { useEffect } from 'react'
import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'

export function ApprovalAuditListener() {
  const toast = useToast()
  const { t } = useI18n()

  useEffect(() => {
    let off: (() => void) | undefined
    try {
      off = window.pocketai.onApprovalAuditWarn((e) => {
        toast.warning(t('approval.auditWriteFailed', { count: e.failures }))
      })
    } catch (e2) {
      reportIpcError('approval.auditWarnSubscribe')(e2)
    }
    return () => off?.()
  }, [toast, t])

  return null
}
