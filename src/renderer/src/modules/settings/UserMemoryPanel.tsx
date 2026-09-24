// 用户记忆管理面板：查看/添加/编辑/删除长期记忆条目
// 记忆来源：Agent 对话中经 memory_save 工具主动保存 + 用户手动添加
import React, { useCallback, useEffect, useState } from 'react'
import type { UserMemoryRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useConfirm } from '../../components/ConfirmDialog'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { Notice } from './ProviderSettings'
import { reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'

export const UserMemoryPanel: React.FC = () => {
  const { t } = useI18n()
  const [items, setItems] = useState<UserMemoryRecord[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirm()
  const { notice, show: showNotice } = useTransientNotice<{ ok: boolean; text: string }>(2500)

  const refresh = useCallback(() => {
    window.pocketai.listMemories().then(setItems).catch(reportIpcError('memory.list'))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const flash = (ok: boolean, text: string) => showNotice({ ok, text })

  const add = async () => {
    const content = draft.trim()
    if (!content || busy) return
    setBusy(true)
    try {
      await window.pocketai.addMemory(content)
      setDraft('')
      flash(true, t('set.memoryAdded'))
      refresh()
    } catch (e) {
      flash(false, errText(e, t('common.unknownError')))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (m: UserMemoryRecord) => {
    setEditingId(m.id)
    setEditDraft(m.content)
  }

  const saveEdit = async () => {
    const content = editDraft.trim()
    if (!content || !editingId || busy) return
    setBusy(true)
    try {
      await window.pocketai.updateMemory(editingId, content)
      setEditingId(null)
      flash(true, t('set.memoryUpdated'))
      refresh()
    } catch (e) {
      flash(false, errText(e, t('common.unknownError')))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (m: UserMemoryRecord) => {
    if (!(await confirm({ message: t('set.memoryDeleteConfirm'), danger: true }))) return
    try {
      await window.pocketai.deleteMemory(m.id)
      flash(true, t('set.memoryDeleted'))
      refresh()
    } catch (e) {
      reportIpcError('memory.delete')(e)
    }
  }

  return (
    <div>
      <p className="text-xs text-[var(--color-text-muted)] mb-2">{t('set.memoryHint')}</p>

      <div className="flex gap-2 mb-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder={t('set.memoryPlaceholder')}
          className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
        />
        <button
          onClick={add}
          disabled={busy || !draft.trim()}
          className="text-xs px-3 py-1.5 rounded bg-[var(--color-primary)] text-white disabled:opacity-50"
        >
          {t('common.add')}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">{t('set.memoryEmpty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-xs">
              {editingId === m.id ? (
                <>
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
                  />
                  <button onClick={saveEdit} disabled={busy || !editDraft.trim()} className="text-[var(--color-primary)] disabled:opacity-50 shrink-0">
                    {t('common.save')}
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-[var(--color-text-muted)] shrink-0">
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 break-words text-[var(--color-text)]">{m.content}</span>
                  <button onClick={() => startEdit(m)} className="text-[var(--color-text-muted)] hover:text-[var(--color-primary)] shrink-0">
                    {t('common.edit')}
                  </button>
                  <button onClick={() => remove(m)} className="text-[var(--color-text-muted)] hover:text-red-500 shrink-0">
                    {t('common.delete')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {notice && <Notice ok={notice.ok} text={notice.text} />}
      {dialog}
    </div>
  )
}
