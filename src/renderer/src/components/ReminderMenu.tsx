// 「提醒我」锚点浮层：4 个时间预设 + 自定义分钟。纯展示/输入组件，
// IPC 调用与文本截取由 ChatModule 统一处理（需要会话 id 与消息正文）。
import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { buildReminderPresets, clampReminderMinutes } from '../utils/reminder-presets'

interface Props {
  anchor: { x: number; y: number }
  onPick: (fireAt: number) => void
  onClose: () => void
}

export const ReminderMenu: React.FC<Props> = ({ anchor, onPick, onClose }) => {
  const { t } = useI18n()
  const presets = buildReminderPresets()
  const [minutes, setMinutes] = useState('60')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submitCustom = () => {
    const m = clampReminderMinutes(Number(minutes))
    onPick(Date.now() + m * 60_000)
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        className="fixed z-50 w-48 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        style={{
          left: Math.min(anchor.x, window.innerWidth - 200),
          top: Math.min(anchor.y, window.innerHeight - 220)
        }}
      >
        <div className="px-3 pt-1 pb-1 text-[11px] text-[var(--color-text-muted)]">{t('reminder.menu.remindMe')}</div>
        {presets.map((p) => (
          <button
            key={p.key}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
            onClick={() => onPick(p.fireAt)}
          >
            {t(`reminder.menu.${p.key}`)}
          </button>
        ))}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-[var(--color-border)] mt-1">
          <input
            type="number"
            min={1}
            max={43200}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitCustom() }
            }}
            className="w-16 px-1.5 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-input-bg,var(--color-sidebar))] outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
            {t('reminder.menu.customMinutes')}
          </span>
          <button
            onClick={submitCustom}
            className="ml-auto text-[11px] px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
          >
            {t('reminder.menu.create')}
          </button>
        </div>
      </div>
    </>
  )
}
