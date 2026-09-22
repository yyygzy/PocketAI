import React, { useRef, useState, useCallback } from 'react'
import { useI18n } from '../../i18n'
import type { ChatAttachment } from '../../../../shared/types'

interface Props {
  streaming: boolean
  canSend: boolean
  onSend: (text: string, attachments?: ChatAttachment[]) => void
  onStop: () => void
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript', 'application/x-yaml', 'text/x-yaml']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log', '.ini', '.conf', '.toml']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_TEXT_SIZE = 2 * 1024 * 1024 // 2MB

export const Composer: React.FC<Props> = ({ streaming, canSend, onSend, onStop }) => {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const resize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }

  const submit = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || !canSend || streaming) return
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
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

  const readFile = (file: File): Promise<ChatAttachment | null> => {
    return new Promise((resolve) => {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      const isImage = IMAGE_TYPES.includes(file.type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
      const isText = TEXT_TYPES.includes(file.type) || TEXT_EXTS.includes(ext)

      if (isImage) {
        if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
        const reader = new FileReader()
        reader.onload = () => {
          resolve({
            type: 'image',
            name: file.name,
            mimeType: file.type || 'image/png',
            size: file.size,
            data: reader.result as string
          })
        }
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(file)
      } else if (isText) {
        if (file.size > MAX_TEXT_SIZE) { resolve(null); return }
        const reader = new FileReader()
        reader.onload = () => {
          resolve({
            type: 'text',
            name: file.name,
            mimeType: file.type || 'text/plain',
            size: file.size,
            data: reader.result as string
          })
        }
        reader.onerror = () => resolve(null)
        reader.readAsText(file)
      } else {
        resolve(null)
      }
    })
  }

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files)
    const results = await Promise.all(fileArr.map(readFile))
    const valid = results.filter((r): r is ChatAttachment => r !== null)
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid].slice(0, 8))
  }, [])

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files)
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto">
        {/* 附件预览 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1.5">
            {attachments.map((att, i) => (
              <div key={i} className="relative group flex items-center gap-1.5 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg pl-1.5 pr-7 py-1 text-xs">
                {att.type === 'image' ? (
                  <img src={att.data} alt={att.name} className="w-6 h-6 rounded object-cover" />
                ) : (
                  <span className="text-[var(--color-text-muted)]">📄</span>
                )}
                <span className="max-w-[120px] truncate text-[var(--color-text)]">{att.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] leading-none"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={`flex items-end gap-2 bg-[var(--color-sidebar)] border rounded-2xl p-2 transition-colors ${
            dragOver ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragOver(false)}
        >
          {/* 文件选择按钮 */}
          <button
            onClick={() => fileRef.current?.click()}
            title={t('common.attachFile')}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.html,.xml,.py,.js,.ts,.tsx,.jsx,.yaml,.yml,.sh,.sql,.log,.ini,.conf,.toml"
            className="hidden"
            onChange={handleFilePick}
          />

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
              disabled={!canSend || (!text.trim() && attachments.length === 0)}
              className="shrink-0 h-9 px-4 rounded-xl bg-[var(--color-accent)] text-[var(--color-on-accent)] text-sm font-medium disabled:opacity-30 hover:opacity-90"
            >
              {t('common.send')}
            </button>
          )}
        </div>
        {dragOver && (
          <div className="text-[11px] text-[var(--color-accent)] mt-1 text-center">
            松开以添加文件
          </div>
        )}
      </div>
    </div>
  )
}
