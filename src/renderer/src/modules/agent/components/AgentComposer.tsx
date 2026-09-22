// Agent 底部输入区：附件预览/拖拽/选择 + 输入框 + 发送/停止
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import type { useAttachments } from '../hooks/useAttachments'

interface Props {
  running: boolean
  canSend: boolean
  att: ReturnType<typeof useAttachments>
  onSend: (text: string) => void
  onAbort: () => void
}

export const AgentComposer: React.FC<Props> = ({ running, canSend, att, onSend, onAbort }) => {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const { attachments, dragOver, removeAt, clear, openPicker, fileInputProps, dropZoneProps } = att

  const doSend = () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !canSend || running) return
    onSend(text)
    // 乐观清空（与原实现一致，不等待 IPC）
    setInput('')
    clear()
  }

  return (
    <>
      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2">
          {attachments.map((attachment, i) => (
            <div key={i} className="relative group flex items-center gap-1.5 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg pl-1.5 pr-7 py-1 text-xs">
              {attachment.type === 'image' ? (
                <img src={attachment.data} alt={attachment.name} className="w-6 h-6 rounded object-cover" />
              ) : (
                <span>📄</span>
              )}
              <span className="max-w-[120px] truncate text-[var(--color-text)]">{attachment.name}</span>
              <button
                onClick={() => removeAt(i)}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* 输入 */}
      <div
        className={`flex gap-2 pt-2 border-t border-[var(--color-border)] mt-2 rounded-b-xl ${
          dragOver ? 'ring-2 ring-[var(--color-accent)]' : ''
        }`}
        {...dropZoneProps}
      >
        <input {...fileInputProps} />
        <button
          onClick={openPicker}
          title={t('common.attachFile')}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          className="input flex-1 text-sm min-h-[40px] max-h-[120px] resize-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              doSend()
            }
          }}
          placeholder={t('agent.inputPh')}
          disabled={running}
        />
        {running ? (
          <button className="btn-ghost" onClick={onAbort}>{t('common.stop')}</button>
        ) : (
          <button
            className="btn-primary"
            onClick={doSend}
            disabled={(!input.trim() && attachments.length === 0) || !canSend}
          >
            {t('common.send')}
          </button>
        )}
      </div>
    </>
  )
}
