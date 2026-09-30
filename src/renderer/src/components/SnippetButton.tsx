// 提示词片段按钮（Chat / Agent 输入框共用）：📝 触发，弹层三态——
// 列表（搜索过滤/新建/编辑/行内二次确认删除）→ 编辑（标题+正文）→ 变量填充（{{变量}}）→ 插入输入框光标处。
// 弹层用 fixed 定位：Agent 外壳链有 overflow-hidden，absolute 会被裁切。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useToast } from './ToastProvider'
import { errText } from '../utils/error'
import { applyTemplateVars, extractTemplateVars } from '../utils/snippet-template'
import type { PromptSnippetRecord } from '../../../shared/types'

type Mode = 'list' | 'edit' | 'vars'

interface Props {
  /** 把最终文本插入输入框（由各 Composer 实现光标位置拼接） */
  onInsert: (text: string) => void
  disabled?: boolean
}

const POPUP_WIDTH = 304
const POPUP_GAP = 4
const DELETE_CONFIRM_MS = 3000

interface EditingState {
  id: string | null
  title: string
  content: string
}

export const SnippetButton: React.FC<Props> = ({ onInsert, disabled }) => {
  const { t } = useI18n()
  const toast = useToast()
  const btnRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 })
  const [snippets, setSnippets] = useState<PromptSnippetRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [mode, setMode] = useState<Mode>('list')
  const [editing, setEditing] = useState<EditingState>({ id: null, title: '', content: '' })
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 变量填充态
  const [varSnippet, setVarSnippet] = useState<PromptSnippetRecord | null>(null)
  const [varValues, setVarValues] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnippets(await window.pocketai.listPromptSnippets())
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  // 打开时拉取并按按钮位置计算 fixed 坐标（向上展开）
  const openPopup = () => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) {
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH - 8))
      setPos({ bottom: window.innerHeight - rect.top + POPUP_GAP, left })
    }
    setKeyword('')
    setMode('list')
    setConfirmingId(null)
    setOpen(true)
    void refresh()
  }

  const closePopup = () => {
    setOpen(false)
    setMode('list')
    setConfirmingId(null)
  }

  // 点外部关闭 / Esc：编辑或变量态先退回列表，再按 Esc 才整层关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node
      if (popupRef.current?.contains(tgt) || btnRef.current?.contains(tgt)) return
      closePopup()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (mode !== 'list') {
        e.stopPropagation()
        setMode('list')
      } else {
        closePopup()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, mode])

  // 删除二次确认自动复位
  useEffect(() => {
    if (!confirmingId) return
    confirmTimer.current = setTimeout(() => setConfirmingId(null), DELETE_CONFIRM_MS)
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [confirmingId])

  const startCreate = () => {
    setEditing({ id: null, title: '', content: '' })
    setMode('edit')
  }
  const startEdit = (s: PromptSnippetRecord) => {
    setEditing({ id: s.id, title: s.title, content: s.content })
    setMode('edit')
  }

  const saveEditing = async () => {
    const title = editing.title.trim()
    const content = editing.content.trim()
    if (!title || !content) {
      toast.error(t('snippet.required'))
      return
    }
    try {
      if (editing.id) {
        await window.pocketai.updatePromptSnippet(editing.id, { title, content })
      } else {
        await window.pocketai.createPromptSnippet({ title, content })
      }
      await refresh()
      setMode('list')
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  const handleDelete = async (s: PromptSnippetRecord) => {
    if (confirmingId !== s.id) {
      setConfirmingId(s.id)
      return
    }
    try {
      await window.pocketai.deletePromptSnippet(s.id)
      setConfirmingId(null)
      await refresh()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  // 选用：有变量先进填充态，无变量直接插入
  const pickSnippet = (s: PromptSnippetRecord) => {
    const vars = extractTemplateVars(s.content)
    if (vars.length === 0) {
      onInsert(s.content)
      closePopup()
      return
    }
    setVarSnippet(s)
    setVarValues(Object.fromEntries(vars.map((v) => [v, ''])))
    setMode('vars')
  }

  const insertWithVars = () => {
    if (!varSnippet) return
    onInsert(applyTemplateVars(varSnippet.content, varValues))
    closePopup()
  }

  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? snippets.filter((s) => s.title.toLowerCase().includes(kw) || s.content.toLowerCase().includes(kw))
    : snippets

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={t('snippet.button')}
        aria-label={t('snippet.button')}
        disabled={disabled}
        onClick={() => (open ? closePopup() : openPopup())}
        className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[17px] text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors disabled:opacity-30 disabled:pointer-events-none"
      >
        📝
      </button>

      {open && (
        <div
          ref={popupRef}
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, width: POPUP_WIDTH }}
          className="z-[9999] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-2xl overflow-hidden"
        >
          {/* ── 列表态 ── */}
          {mode === 'list' && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
                <span className="text-xs font-semibold text-[var(--color-text)]">{t('snippet.title')}</span>
                <button
                  type="button"
                  onClick={startCreate}
                  className="text-[11px] text-[var(--color-accent)] hover:opacity-80"
                >
                  ＋ {t('snippet.new')}
                </button>
              </div>
              <div className="px-3 pb-2">
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder={t('snippet.search')}
                  className="input text-xs w-full"
                  autoFocus
                />
              </div>
              <div className="max-h-[240px] overflow-y-auto pb-1">
                {loading && snippets.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">…</div>
                )}
                {!loading && filtered.length === 0 && (
                  <div className="px-3 py-4 text-center">
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {kw ? t('snippet.noMatch') : t('snippet.empty')}
                    </p>
                    {!kw && (
                      <button
                        type="button"
                        onClick={startCreate}
                        className="mt-2 text-[11px] text-[var(--color-accent)] hover:opacity-80"
                      >
                        ＋ {t('snippet.new')}
                      </button>
                    )}
                  </div>
                )}
                {filtered.map((s) => (
                  <div
                    key={s.id}
                    className="group flex items-center gap-1 px-3 py-1.5 hover:bg-[var(--color-hover-overlay)]"
                  >
                    <button
                      type="button"
                      title={s.content}
                      onClick={() => pickSnippet(s)}
                      className="flex-1 min-w-0 text-left text-xs text-[var(--color-text)] truncate"
                    >
                      {s.title}
                    </button>
                    <button
                      type="button"
                      title={t('snippet.edit')}
                      onClick={() => startEdit(s)}
                      className="shrink-0 w-5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] opacity-60 group-hover:opacity-100"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      title={t('snippet.delete')}
                      onClick={() => void handleDelete(s)}
                      className={`shrink-0 h-4 px-1 text-[10px] leading-none rounded ${
                        confirmingId === s.id
                          ? 'bg-[var(--color-danger)] text-white'
                          : 'text-[var(--color-text-muted)] hover:text-[var(--color-danger)] opacity-60 group-hover:opacity-100'
                      }`}
                    >
                      {confirmingId === s.id ? t('snippet.confirmDelete') : '×'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 编辑态 ── */}
          {mode === 'edit' && (
            <div className="flex flex-col gap-2 p-3">
              <span className="text-xs font-semibold text-[var(--color-text)]">
                {editing.id ? t('snippet.editTitle') : t('snippet.new')}
              </span>
              <input
                value={editing.title}
                onChange={(e) => setEditing((p) => ({ ...p, title: e.target.value }))}
                placeholder={t('snippet.titlePh')}
                className="input text-xs w-full"
                maxLength={100}
                autoFocus
              />
              <textarea
                value={editing.content}
                onChange={(e) => setEditing((p) => ({ ...p, content: e.target.value }))}
                placeholder={t('snippet.contentPh')}
                rows={6}
                maxLength={20000}
                className="input text-xs w-full resize-none leading-relaxed"
              />
              <p className="text-[10px] text-[var(--color-text-muted)]">{t('snippet.hint')}</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setMode('list')} className="btn-ghost text-xs px-2 py-1">
                  {t('snippet.cancel')}
                </button>
                <button type="button" onClick={() => void saveEditing()} className="btn-primary text-xs px-2 py-1">
                  {t('snippet.save')}
                </button>
              </div>
            </div>
          )}

          {/* ── 变量填充态 ── */}
          {mode === 'vars' && varSnippet && (
            <div className="flex flex-col gap-2 p-3">
              <span className="text-xs font-semibold text-[var(--color-text)]">
                {t('snippet.varTitle', { title: varSnippet.title })}
              </span>
              {extractTemplateVars(varSnippet.content).map((name, i) => (
                <div key={name} className="flex flex-col gap-1">
                  <label className="text-[11px] text-[var(--color-text-muted)]">{name}</label>
                  <input
                    value={varValues[name] ?? ''}
                    onChange={(e) => setVarValues((p) => ({ ...p, [name]: e.target.value }))}
                    placeholder={t('snippet.varPh')}
                    autoFocus={i === 0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        insertWithVars()
                      }
                    }}
                    className="input text-xs w-full"
                  />
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-1">
                <button type="button" onClick={() => setMode('list')} className="btn-ghost text-xs px-2 py-1">
                  {t('snippet.cancel')}
                </button>
                <button type="button" onClick={insertWithVars} className="btn-primary text-xs px-2 py-1">
                  {t('snippet.insert')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
