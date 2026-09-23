// 笔记模块：本地 Markdown 笔记的增删改查 / 置顶 / 标签 / 搜索
//
// 数据经 IPC NOTES_* 读写 SQLite（与主库同加密）。
// 编辑器自动保存（防抖 500ms）。从聊天「另存为笔记」会派发
// window 事件 'pocketai:open-note' 来定位到指定笔记。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { errText } from '../../utils/error'
import { useTransientNotice } from '../../hooks/useTransientNotice'

interface NoteDraft {
  title: string
  content: string
  tags: string[]
  pinned: boolean
}

const AUTO_SAVE_DELAY = 500
/** IPC 无响应超时（主进程版本过旧/未注册 handler 时 invoke 会永远挂起） */
const IPC_TIMEOUT_MS = 10_000
const IPC_TIMEOUT = 'IPC_TIMEOUT'

/** 给 IPC 调用加超时，避免主进程无 handler 时 Promise 永久挂起（表现为按钮「点不动」） */
function withIpcTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(IPC_TIMEOUT)), IPC_TIMEOUT_MS)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export const NotesModule: React.FC = () => {
  const { t } = useI18n()
  const [notes, setNotes] = useState<Note[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [draft, setDraft] = useState<NoteDraft>({ title: '', content: '', tags: [], pinned: false })
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [loadError, setLoadError] = useState(false)
  const { notice, show: showNotice } = useTransientNotice<{ ok: boolean; text: string }>(4000)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const active = useMemo(() => notes.find((n) => n.id === activeId) ?? null, [notes, activeId])

  // 组件卸载时清掉未触发的自动保存定时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [])

  const flash = useCallback((ok: boolean, text: string) => showNotice({ ok, text }), [showNotice])

  /** 把超时错误翻译为可读文案 */
  const noteErrorText = useCallback(
    (e: unknown, fallbackKey: string): string => {
      const msg = errText(e, '')
      return msg === IPC_TIMEOUT ? t('notes.serviceTimeout') : t(fallbackKey, { e: msg })
    },
    [t]
  )

  const load = useCallback(
    async (kw?: string) => {
      try {
        const list = await withIpcTimeout(
          kw ? window.pocketai.searchNotes(kw) : window.pocketai.listNotes()
        )
        setNotes(list)
        setLoadError(false)
      } catch {
        setLoadError(true)
        setNotes([])
      }
    },
    []
  )

  useEffect(() => {
    load(keyword)
  }, [keyword, load])

  // 监听「另存为笔记」事件，跳转到新笔记
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail
      if (detail?.id) {
        setKeyword('')
        load('').then(() => setActiveId(detail.id))
      }
    }
    window.addEventListener('pocketai:open-note', handler)
    return () => window.removeEventListener('pocketai:open-note', handler)
  }, [load])

  // 切换激活笔记时，把该笔记内容载入草稿（取消未保存的定时器）
  useEffect(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (active) {
      setDraft({
        title: active.title,
        content: active.content,
        tags: active.tags,
        pinned: active.pinned
      })
      setLastSavedAt(active.updatedAt)
    } else {
      setDraft({ title: '', content: '', tags: [], pinned: false })
      setLastSavedAt(null)
    }
  }, [active])

  const scheduleSave = useCallback(
    (next: NoteDraft) => {
      if (!activeId) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        setSaving(true)
        try {
          const updated = await withIpcTimeout(
            window.pocketai.updateNote(activeId, {
              title: next.title,
              content: next.content,
              tags: next.tags,
              pinned: next.pinned
            })
          )
          if (updated) {
            setLastSavedAt(updated.updatedAt)
            setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
          }
        } catch (e) {
          flash(false, noteErrorText(e, 'notes.saveFail'))
        } finally {
          setSaving(false)
        }
      }, AUTO_SAVE_DELAY)
    },
    [activeId, errText, flash]
  )

  const handleNew = async () => {
    if (creating) return
    setCreating(true)
    try {
      const note = await withIpcTimeout(
        window.pocketai.createNote({ title: t('notes.untitled') })
      )
      setNotes((prev) => [note, ...prev])
      setActiveId(note.id)
    } catch (e) {
      flash(false, noteErrorText(e, 'notes.createFail'))
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!active) return
    if (!window.confirm(t('notes.deleteConfirm', { title: active.title || t('notes.untitled') }))) return
    try {
      await withIpcTimeout(window.pocketai.deleteNote(active.id))
      setNotes((prev) => prev.filter((n) => n.id !== active.id))
      setActiveId(null)
    } catch (e) {
      flash(false, noteErrorText(e, 'notes.deleteFail'))
    }
  }

  const handleTogglePin = async () => {
    if (!active) return
    const nextPinned = !draft.pinned
    const next = { ...draft, pinned: nextPinned }
    setDraft(next)
    try {
      const updated = await withIpcTimeout(
        window.pocketai.updateNote(active.id, { pinned: nextPinned })
      )
      if (updated) {
        setNotes((prev) => {
          const list = prev.map((n) => (n.id === updated.id ? updated : n))
          // 置顶状态变化可能影响排序，但列表由 load 负责排序，这里手动重排
          list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
          return list
        })
      }
    } catch (e) {
      // 失败则回退置顶态
      setDraft((d) => ({ ...d, pinned: !nextPinned }))
      flash(false, noteErrorText(e, 'notes.pinFail'))
    }
  }

  const onDraftChange = (patch: Partial<NoteDraft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    scheduleSave(next)
  }

  const fmtTime = (ms: number) => {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return (
    <div className="flex h-full gap-0">
      {/* 左侧列表 */}
      <div className="w-64 shrink-0 border-r border-[var(--color-border)] flex flex-col">
        <div className="p-2 border-b border-[var(--color-border)] space-y-2">
          <button
            className="w-full btn-primary text-xs py-1.5 disabled:opacity-50"
            onClick={handleNew}
            disabled={creating || loadError}
          >
            {creating ? t('notes.creating') : `+ ${t('notes.new')}`}
          </button>
          <input
            className="input text-xs py-1"
            placeholder={t('notes.searchPlaceholder')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {notice && (
            <div
              className={`text-[11px] px-2 py-1 rounded break-words ${
                notice.ok
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
              }`}
            >
              {notice.text}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadError ? (
            <div className="p-4 text-xs text-center text-[var(--color-danger)] space-y-2">
              <p>{t('notes.loadFail')}</p>
              <button className="btn-ghost text-[11px] py-0.5" onClick={() => load(keyword)}>
                {t('notes.retry')}
              </button>
            </div>
          ) : notes.length === 0 ? (
            <div className="p-4 text-xs text-center text-[var(--color-text-muted)]">
              {keyword ? t('notes.noMatch') : t('notes.empty')}
            </div>
          ) : (
            notes.map((n) => (
              <button
                key={n.id}
                onClick={() => setActiveId(n.id)}
                className={`w-full text-left px-3 py-2 border-b border-[var(--color-border)]/40 hover:bg-[var(--color-hover-overlay)] transition-colors ${
                  activeId === n.id ? 'bg-[var(--color-accent-soft)]' : ''
                }`}
              >
                <div className="flex items-center gap-1 text-sm">
                  {n.pinned && <span className="text-[var(--color-warning)] text-xs">📌</span>}
                  <span className={`truncate ${activeId === n.id ? 'text-[var(--color-accent)]' : ''}`}>
                    {n.title || t('notes.untitled')}
                  </span>
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 truncate">
                  {n.content.slice(0, 40) || t('notes.emptyContent')}
                </div>
                {n.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {n.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="text-[9px] px-1 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)] text-[var(--color-text-muted)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* 右侧编辑器 */}
      <div className="flex-1 flex flex-col min-w-0">
        {active ? (
          <>
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)]">
              <button
                onClick={handleTogglePin}
                className={`text-sm px-1.5 py-0.5 rounded ${
                  draft.pinned ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
                title={t('notes.pin')}
              >
                📌
              </button>
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {saving
                  ? t('notes.saving')
                  : lastSavedAt
                    ? `${t('notes.lastSaved')} ${fmtTime(lastSavedAt)}`
                    : ''}
              </span>
              <div className="flex-1" />
              <button
                onClick={handleDelete}
                className="text-xs text-[var(--color-danger)] hover:opacity-80"
              >
                🗑 {t('common.delete')}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <input
                className="w-full text-xl font-bold bg-transparent outline-none border-b border-transparent focus:border-[var(--color-border)] pb-1 text-[var(--color-text)]"
                value={draft.title}
                onChange={(e) => onDraftChange({ title: e.target.value })}
                placeholder={t('notes.titlePlaceholder')}
              />
              <textarea
                className="w-full flex-1 min-h-[60vh] resize-none bg-transparent outline-none text-sm leading-relaxed text-[var(--color-text)]"
                value={draft.content}
                onChange={(e) => onDraftChange({ content: e.target.value })}
                placeholder={t('notes.contentPlaceholder')}
                spellCheck={false}
              />
            </div>

            <div className="px-4 py-2 border-t border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)] shrink-0">{t('notes.tags')}</span>
                <input
                  className="input text-xs py-1 flex-1"
                  value={draft.tags.join(', ')}
                  onChange={(e) =>
                    onDraftChange({
                      tags: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    })
                  }
                  placeholder={t('notes.tagsPlaceholder')}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-text-muted)]">
            <div className="text-5xl mb-3">📝</div>
            <p className="text-sm">{t('notes.selectOrNew')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
