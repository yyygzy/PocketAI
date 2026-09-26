// 定时提醒广播订阅：到点弹全局 Toast（系统通知由主进程 scheduler 负责）
// 必须挂在 ToastProvider 内部（useToast 依赖），渲染 null
import { useEffect } from 'react'
import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'

export function ReminderListener() {
  const toast = useToast()
  const { t } = useI18n()

  useEffect(() => {
    let off: (() => void) | undefined
    try {
      off = window.pocketai.onReminderFired((e) => {
        if (e.missed && e.missed > 0) {
          toast.warning(t('reminder.missedSummary', { count: e.missed }))
        } else if (e.text) {
          toast.info(t('reminder.fired', { text: e.text }))
        }
      })
    } catch (e2) {
      reportIpcError('reminder.subscribe')(e2)
    }
    return () => off?.()
  }, [toast, t])

  return null
}
