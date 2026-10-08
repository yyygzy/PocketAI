// 待发提醒中心：pending 提醒列表 + 取消（消息右键/Agent 创建的提醒统一在此管理）
// 挂载于主窗口 App.tsx；打开期间到点/取消的广播会触发自动重拉
import React, { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useToast } from './ToastProvider'
import { reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'
import type { ReminderRecord } from '../../../shared/types'

interface Props {
  onClose: () => void
}

/** 完整本地时间（含年月日，跨天提醒看得清） */
function formatFireAt(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** 提醒数据变更（取消/创建）后通知角标等外部 UI 刷新 */
function notifyChanged(): void {
  window.dispatchEvent(new Event('pocketai:reminders-changed'))
}

export const RemindersModal: React.FC<Props> = ({ onClose }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [items, setItems] = useState<ReminderRecord[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setItems(await window.pocketai.listReminders())
    } catch (e) {
      reportIpcError('reminder.list')(e)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 打开期间订阅到点广播与本地变更事件：触发后该条消失、取消后即时反映
  useEffect(() => {
    const off = window.pocketai.onReminderFired(() => {
      void reload()
    })
    const onLocalChanged = () => void reload()
    window.addEventListener('pocketai:reminders-changed', onLocalChanged)
    return () => {
      off()
      window.removeEventListener('pocketai:reminders-changed', onLocalChanged)
    }
  }, [reload])

  const handleCancel = async (id: string) => {
    setBusyId(id)
    try {
      const r = await window.pocketai.cancelReminder(id)
      if (r.ok) {
        toast.success(t('reminder.center.cancelOk'))
        notifyChanged()
      }
      await reload()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-[520px] max-w-[95vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold">⏰ {t('reminder.center.title')}</h3>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="p-3 overflow-y-auto flex-1">
          {items === null ? (
            <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">{t('common.loading')}</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">{t('reminder.center.empty')}</p>
          ) : (
            <div className="space-y-1.5">
              {items.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 px-3 py-2 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" title={r.text}>{r.text}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {formatFireAt(r.fireAt)}
                      {r.conversationId && (
                        <span className="ml-1.5 px-1 py-px rounded text-[10px] bg-[var(--color-accent)] bg-opacity-15 text-[var(--color-accent)]">
                          {t('reminder.center.fromChat')}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => void handleCancel(r.id)}
                    disabled={busyId === r.id}
                    className="btn-ghost text-[11px] text-[var(--color-danger)] disabled:opacity-50 shrink-0"
                  >
                    {t('reminder.center.cancel')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
