import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useI18n } from '../../i18n'
import { SnippetButton } from '../../components/SnippetButton'
import { loadHistory, pushHistory } from '../../utils/input-history'
import type { ChatAttachment, MessageRecord } from '../../../../shared/types'

interface Props {
  streaming: boolean
  canSend: boolean
  onSend: (text: string, attachments?: ChatAttachment[], replyToId?: string | null) => void
  onStop: () => void
  /** 当前待回复的引用消息（显示引用条） */
  replyTo?: MessageRecord | null
  /** 取消引用 */
  onCancelReply?: () => void
  /** 草稿归属会话 id（切换时触发旧会话提交 + 新会话回填） */
  draftKey: string
  /** 当前会话已保存的草稿文本（draftKey 变化后生效） */
  draft?: string
  /** 文本每次变化（防抖落库由父级负责；空串=立即清除） */
  onDraftChange?: (text: string) => void
  /** 切换会话：把旧会话最新文本同步交父级立即落库 */
  onDraftCommit?: (convId: string, text: string) => void
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript', 'application/x-yaml', 'text/x-yaml']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log', '.ini', '.conf', '.toml']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_TEXT_SIZE = 2 * 1024 * 1024 // 2MB

export const Composer: React.FC<Props> = ({ streaming, canSend, onSend, onStop, replyTo, onCancelReply, draftKey, draft, onDraftChange, onDraftCommit }) => {
  const { t } = useI18n()
  const [text, setText] = useState(draft ?? '')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 最新文本镜像：切会话 effect 里提交旧会话草稿时读取（effect 闭包里的 text 是旧值不可靠）
  const textRef = useRef(text)
  // 上一个草稿归属会话：draftKey 变化时先把旧会话文本同步提交
  const prevKeyRef = useRef(draftKey)
  // 输入历史导航：historyRef 惰性加载（首次按 ↑）；navIndex=null=未导航，0=最新一条，越大越早
  const historyRef = useRef<string[] | null>(null)
  const [navIndex, setNavIndex] = useState<number | null>(null)

  // draftKey 变化（切会话）或 draft 异步加载到达：提交旧会话 → 回填新会话草稿。
  // 同一次渲染内 draft 已随父级清空为 ''，异步加载完成后再次触发本 effect。
  useEffect(() => {
    if (prevKeyRef.current !== draftKey) {
      if (prevKeyRef.current) onDraftCommit?.(prevKeyRef.current, textRef.current)
      prevKeyRef.current = draftKey
    }
    setText(draft ?? '')
    textRef.current = draft ?? ''
    setNavIndex(null) // 切会话/草稿回填时退出历史导航，避免 ↑↓ 覆盖草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, draft])

  /** 更新文本并同步草稿回调（片段插入/历史召回也走这里） */
  const updateText = (next: string) => {
    setText(next)
    textRef.current = next
    onDraftChange?.(next)
  }

  const resize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }

  const submit = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || !canSend || streaming) return
    // 发送前推入历史（只推正文，附件/引用不加入历史）
    if (trimmed) pushHistory(trimmed)
    onSend(trimmed, attachments.length > 0 ? attachments : undefined, replyTo?.id ?? null)
    // 清空并立即删除草稿（空串走父级立即清除分支，不经防抖）
    updateText('')
    setAttachments([])
    setNavIndex(null)
    onCancelReply?.()
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto'
    })
  }

  /** 历史导航：↑ 召回更旧，↓ 更新，Esc 退出；仅限空输入时由 ↑ 进入 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
      return
    }
    // 编辑中不拦截方向键（中文候选栏期间也放行）
    if (e.nativeEvent.isComposing) return
    // 历史导航：空输入时 ↑ 进入；导航中继续 ↑↓（此时文本非空，须放行 navIndex 分支）
    if (e.key === 'ArrowUp') {
      if (text.trim() === '' || navIndex !== null) {
        if (navIndex === null) {
          const hist = historyRef.current ?? loadHistory()
          if (!historyRef.current) historyRef.current = hist
          if (hist.length > 0) {
            e.preventDefault()
            const idx = hist.length - 1 // 最新一条（索引最大）
            setNavIndex(idx)
            updateText(hist[idx] ?? '')
            requestAnimationFrame(resize)
          }
        } else if (navIndex !== null && navIndex > 0) {
          e.preventDefault()
          const idx = navIndex - 1
          setNavIndex(idx)
          updateText(historyRef.current?.[idx] ?? '')
          requestAnimationFrame(resize)
        }
      }
      return
    }
    if (e.key === 'ArrowDown') {
      if (navIndex !== null && historyRef.current) {
        e.preventDefault()
        if (navIndex < historyRef.current.length - 1) {
          const idx = navIndex + 1
          setNavIndex(idx)
          updateText(historyRef.current[idx] ?? '')
        } else {
          // 最新一条后再按 ↓ 回空串
          setNavIndex(null)
          updateText('')
        }
        requestAnimationFrame(resize)
      }
      return
    }
    if (e.key === 'Escape') {
      if (navIndex !== null) {
        e.preventDefault()
        setNavIndex(null)
        updateText('')
        requestAnimationFrame(resize)
      }
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

  // 提示词片段：在 textarea 光标处替换选区插入（受控组件，走 setText 而非直接改 DOM）
  const insertAtCursor = (insert: string) => {
    const ta = taRef.current
    const start = ta?.selectionStart ?? text.length
    const end = ta?.selectionEnd ?? start
    const next = text.slice(0, start) + insert + text.slice(end)
    updateText(next)
    requestAnimationFrame(() => {
      ta?.focus()
      const pos = start + insert.length
      ta?.setSelectionRange(pos, pos)
      resize()
    })
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto">
        {/* 附件预览 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1.5">
            {attachments.map((att, i) => (
              <div key={`${att.name}-${att.size}`} className="relative group flex items-center gap-1.5 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg pl-1.5 pr-7 py-1 text-xs">
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

        {/* 引用回复条：显示被引用消息的角色+内容预览，可取消 */}
        {replyTo && (
          <div className="flex items-start gap-2 mb-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-hover-overlay)] border-l-2 border-[var(--color-accent)]">
            <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${replyTo.role === 'user' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
              {replyTo.role === 'user' ? t('chat.you') : t('chat.assistant')}
            </span>
            <span className="flex-1 text-[12px] text-[var(--color-text-muted)] line-clamp-2 break-all">
              {replyTo.content || t('chat.replyEmpty')}
            </span>
            <button
              onClick={onCancelReply}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title={t('common.cancel')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
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

          <SnippetButton onInsert={insertAtCursor} />

          <textarea
            ref={taRef}
            data-chat-composer-input
            value={text}
            onChange={(e) => {
              // 用户主动输入（非导航回填）：退出历史导航，视为新文本
              if (navIndex !== null) setNavIndex(null)
              updateText(e.target.value)
              resize()
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={canSend ? t('composer.ph') : t('composer.noProvider')}
            className="flex-1 bg-transparent resize-none outline-none text-[var(--chat-font-size)] leading-relaxed px-2 py-1.5 max-h-[200px]"
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
