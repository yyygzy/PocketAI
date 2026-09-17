import React, { useRef, useState } from 'react'
import { useI18n } from '../../i18n'

interface Props {
  streaming: boolean
  canSend: boolean
  onSend: (text: string) => void
  onStop: () => void
}

export const Composer: React.FC<Props> = ({ streaming, canSend, onSend, onStop }) => {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }

  const submit = () => {
    const t = text.trim()
    if (!t || !canSend || streaming) return
    onSend(t)
    setText('')
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto'
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-end gap-2 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-2xl p-2 focus-within:border-[var(--color-accent)] transition-colors">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            resize()
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={canSend ? t('composer.ph') : t('composer.noProvider')}
          className="flex-1 bg-transparent resize-none outline-none text-[14px] leading-relaxed px-2 py-1.5 max-h-[200px]"
        />
        {streaming ? (
          <button
            onClick={onStop}
            className="shrink-0 h-9 px-4 rounded-xl bg-[var(--color-danger)] hover:opacity-90 text-white text-sm font-medium"
          >
            {t('common.stop')}
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend || !text.trim()}
            className="shrink-0 h-9 px-4 rounded-xl bg-[var(--color-accent)] text-[var(--color-on-accent)] text-sm font-medium disabled:opacity-30 hover:opacity-90"
          >
            {t('common.send')}
          </button>
        )}
      </div>
    </div>
  )
}
