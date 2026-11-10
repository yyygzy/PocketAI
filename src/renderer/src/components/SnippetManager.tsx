// 提示词片段管理器：列表（搜索过滤/新建/编辑/行内二次确认删除）→ 编辑（标题+正文）→ 变量填充（{{变量}}）。
// 「写入」仍只走 prompt_snippets 那张表；本组件不碰助手系统提示词。
//
// 两个落点共用这一份实现：
// · 助手编辑页「提示词 → 我的片段」页签：内嵌在页面里，选中一条追加到系统提示词末尾；
// · 曾经的输入框 📝 弹层已并入「+ → 提示词片段」（片段插入会话输入框）。
// 变量填充的 Enter 判定照旧必须带 `isComposing`（见 tests/enter-composing-gate-340）。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useToast } from './ToastProvider'
import { errText } from '../utils/error'
import { hasIpcFailed, ipcFailText } from '../utils/ipc'
import { applyTemplateVars, extractTemplateVars } from '../utils/snippet-template'
import type { PromptSnippetRecord } from '../../../shared/types'

type Mode = 'list' | 'edit' | 'vars'

interface Props {
  /** 把最终文本交给宿主（会话输入框：光标处插入；助手编辑页：追加到系统提示词） */
  onInsert: (text: string) => void
}

const DELETE_CONFIRM_MS = 3000

interface EditingState {
  id: string | null
  title: string
  content: string
}

export const SnippetManager: React.FC<Props> = ({ onInsert }) => {
  const { t } = useI18n()
  const toast = useToast()

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
      const list = await window.pocketai.listPromptSnippets()
      // §223：`setSnippets(await …)` 把失败对象写进列表 state ⇒ 菜单重建时那句 `.map`／`.filter` 当场崩；
      // 这一发是用户点按钮拉起的，按旁边那个 catch 的同一口径说出来并保持原列表
      if (hasIpcFailed(list)) {
        toast.error(t('common.opFailed', { msg: ipcFailText(list, t('common.unknownError')) }))
        return
      }
      setSnippets(list)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Esc：编辑或变量态先退回列表（列表态不拦，交给外层页面/浮层处理）
  useEffect(() => {
    if (mode === 'list') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMode('list')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [mode])

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

  // 导出全部片段为 JSON
  const handleExport = async () => {
    try {
      const res = await window.pocketai.exportPromptSnippets()
      if (res.ok && res.path) toast.success(t('snippet.exported', { path: res.path }))
      else if (!res.ok) toast.error(t('snippet.exportFailed', { msg: res.error ?? 'unknown' }))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  // 导入 JSON 文件，成功后刷新列表
  const handleImport = async () => {
    try {
      const res = await window.pocketai.importPromptSnippets()
      if (!res.ok) {
        if (res.error) toast.error(t('snippet.importFailed', { msg: res.error }))
        return
      }
      if (res.canceled) return
      toast.success(t('snippet.imported', { n: res.imported ?? 0, m: res.overwritten ?? 0 }))
      await refresh()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  // 选用：有变量先进填充态，无变量直接交给宿主
  const pickSnippet = (s: PromptSnippetRecord) => {
    const vars = extractTemplateVars(s.content)
    if (vars.length === 0) {
      onInsert(s.content)
      return
    }
    setVarSnippet(s)
    setVarValues(Object.fromEntries(vars.map((v) => [v, ''])))
    setMode('vars')
  }

  const insertWithVars = () => {
    if (!varSnippet) return
    onInsert(applyTemplateVars(varSnippet.content, varValues))
    setMode('list')
  }

  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? snippets.filter((s) => s.title.toLowerCase().includes(kw) || s.content.toLowerCase().includes(kw))
    : snippets

  return (
    <div
      data-testid="snippet-manager"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] overflow-hidden"
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
          {/* 底部工具行 */}
          <div className="flex items-center justify-between px-3 pt-2 pb-2 border-t border-[var(--color-border)]">
            <button type="button" onClick={() => void handleExport()} className="btn-ghost text-[11px] px-2 py-1">
              ⬇ {t('snippet.exportTitle')}
            </button>
            <button type="button" onClick={() => void handleImport()} className="btn-ghost text-[11px] px-2 py-1">
              ⬆ {t('snippet.importTitle')}
            </button>
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
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
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
  )
}
