// 笔记模块：本地 Markdown 笔记的增删改查 / 置顶 / 标签 / 搜索
//
// 数据经 IPC NOTES_* 读写 SQLite（与主库同加密）。
// 编辑器自动保存（防抖 500ms）。从聊天「另存为笔记」会派发
// window 事件 'pocketai:open-note' 来定位到指定笔记。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { errText } from '../../utils/error'
// §332：这一屏改前一个信封判据都没有（只 import 了留痕那一条）——safeHandle 的失败是 resolve 的值，
// `.catch` 与真值判断都挡不住它，于是失败对象被当数据塞进列表 state
import { hasIpcFailed, isIpcFail, ipcFailureText, logIpcError } from '../../utils/ipc'
import type { IpcFailureInput } from '../../utils/ipc'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { useConfirm } from '../../components/ConfirmDialog'

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
  // §311：`load(kw)` 是 async——连着敲两个关键词时前一行那一发可能后到，于是上一次搜索的结果挂在
  // 当前输入框的关键词下面（那一发若是失败还会把新关键词的结果整张清空＋报「读不到」）。
  // 判据同 §309／§264：「这一发是不是还给当前关键词」。ref 在 render 期同步，首次加载不误挡。
  const keywordRef = useRef(keyword)
  keywordRef.current = keyword
  const { notice, show: showNotice } = useTransientNotice<{ ok: boolean; text: string }>(4000)
  const { confirm, dialog } = useConfirm()
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

  /** §332：resolve 面的失败（safeHandle 折出来的 `{ok:false}`）走同一张话术——
   * 登记过的回码换四语，其余原样透出，绝不咽掉（`ipcFailText` 那种"整句换成回码原文"在本屏会把
   * 「自动保存失败：」这个前缀丢掉，而这颗前缀正是用户分辨是哪一发失败了） */
  const noteFailText = useCallback(
    (r: IpcFailureInput, fallbackKey: string): string => t(fallbackKey, { e: ipcFailureText(r, t) }),
    [t]
  )

  const load = useCallback(
    async (kw?: string) => {
      // §311：这一发的归属键（`load('')` 与「当前关键词为空」是同一件事）
      const want = kw ?? ''
      try {
        const list = await withIpcTimeout(
          kw ? window.pocketai.searchNotes(kw) : window.pocketai.listNotes()
        )
        // §311：切走了就不替旧关键词写屏，也不替它把「读不到」关掉
        if (keywordRef.current !== want) return
        // §332：这一发失败的是 **resolve 的 `{ok:false}`**（备份恢复占着库时主进程抛错被 safeHandle 折成它），
        // 而类型里只写着 `Note[]` ⇒ 改前直塞进 `notes`，渲染那行 `n.content.slice(0, 40)` 当场 TypeError＝
        // 整块屏不见（根层边界接住＝笔记屏什么都不剩）。走这一屏本来就有那张「读不到＋重试」的脸，接管到它。
        if (isIpcFail(list)) {
          setLoadError(true)
          setNotes([])
          return
        }
        setNotes(list)
        setLoadError(false)
      } catch (e) {
        logIpcError('notes.load', e)
        // §311：迟到那一发的失败不许替当前关键词清空列表＋报「读不到」（留痕照旧）
        if (keywordRef.current !== want) return
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
  //
  // §332：依赖是**这一条笔记的 id**，不是 `active` 那个对象。改前依赖 `active`＝笔记对象一换就重置草稿，
  // 而自动保存写回（`setNotes(prev => prev.map(...))`）恰好会让它换 ⇒ 保存往返期间用户敲进去的那几个字
  // 被服务端回来的旧副本无条件吞掉，下一次自动保存再把吞后的内容落库（"正在保存"一闪，字就没了）。
  // 时间戳与列表由那一发自己写（不需要这个 effect 兜），切笔记时才重建草稿。
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
    // 只在"换了一条笔记"时重建草稿：故依赖 activeId，而不是派生出来的那个对象
  }, [activeId])

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
          // §332：自动保存那一发有三张到货——成功记录／`null`（笔记不在了）／safeHandle 折出的 `{ok:false}`。
          // 改前只有 `if (updated)` 一个真值判断：失败对象是真值 ⇒ 走成功支，屏上「上次保存」被写成
          // `fmtTime(undefined)`＝**NaN-NaN-NaN NaN:NaN**，而列表里那条还是旧内容（用户以为存上了）。
          // 触发最经常的一张：正文超 100_000 字符（`schemas/notes.ts` 的 NOTE_MAX_CONTENT_CHARS）被 zod 整条拒，
          // 而这一屏的 textarea 没有任何限长文案。失败就说不建成的原因，时间戳与列表都不动。
          if (isIpcFail(updated)) {
            flash(false, noteFailText(updated, 'notes.saveFail'))
            return
          }
          if (!updated) {
            // §332：第三种到货——这条笔记在别处被删了（`note.repo.ts:90`）。改前 `if (updated)` 静默跳过
            // ＝"看着还在编辑，其实每 500ms 白写一发、一个字都落不了库"，屏上连一句都没有
            flash(false, t('notes.gone'))
            return
          }
          setLastSavedAt(updated.updatedAt)
          setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
        } catch (e) {
          flash(false, noteErrorText(e, 'notes.saveFail'))
        } finally {
          setSaving(false)
        }
      }, AUTO_SAVE_DELAY)
    },
    [activeId, errText, flash, noteFailText, t]
  )

  const handleNew = async () => {
    if (creating) return
    setCreating(true)
    try {
      const note = await withIpcTimeout(
        window.pocketai.createNote({ title: t('notes.untitled') })
      )
      // §332：新建那一发的失败同样是 resolve 的值 ⇒ 改前把这个 `{ok:false}` 对象塞进列表首位、
      // 还把 `undefined` 当成 activeId，渲染那行的 `n.content.slice(0, 40)` 当场 TypeError＝整块屏不见
      if (isIpcFail(note)) {
        flash(false, noteFailText(note, 'notes.createFail'))
        return
      }
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
    if (!(await confirm({ message: t('notes.deleteConfirm', { title: active.title || t('notes.untitled') }), danger: true }))) return
    try {
      const res = await withIpcTimeout(window.pocketai.deleteNote(active.id))
      // §332：这一发成功形状是 `{ok:true}`、失败是 `{ok:false}`（`{ok}` 在 preload 里早已声明，改前没人读）
      // ⇒ 改前失败也照样把那一行从列表里抹掉＋退出编辑＝**演成"删掉了"**，库里那条还在、下次开机又回来
      if (hasIpcFailed(res)) {
        flash(false, noteFailText(res, 'notes.deleteFail'))
        return
      }
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
      if (isIpcFail(updated)) {
        // 置顶是"先改屏再落库"的乐观改动 ⇒ 失败必须把那颗图钉退回原样（同下面 catch 那一支），
        // 否则屏上钉着、库里没钉；改前这个失败对象还会被当记录写进列表（同样当场崩屏）
        setDraft((d) => ({ ...d, pinned: !nextPinned }))
        flash(false, noteFailText(updated, 'notes.pinFail'))
        return
      }
      if (!updated) {
        // §332：第三种到货——那条笔记已经不在了（`note.repo.ts:90`）；退回乐观改动并明说，不静默
        setDraft((d) => ({ ...d, pinned: !nextPinned }))
        flash(false, t('notes.gone'))
        return
      }
      setNotes((prev) => {
        const list = prev.map((n) => (n.id === updated.id ? updated : n))
        // 置顶状态变化可能影响排序，但列表由 load 负责排序，这里手动重排
        list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
        return list
      })
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

      {dialog}
    </div>
  )
}
