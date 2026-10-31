// 用户记忆管理面板：查看/添加/编辑/删除长期记忆条目
// 记忆来源：Agent 对话中经 memory_save 工具主动保存 + 用户手动添加
import React, { useCallback, useEffect, useState } from 'react'
import type { UserMemoryRecord } from '../../../../shared/types'
// §333：那道 2000 字上限此前只在 zod 里，输入框不设防 ⇒ 粘一段超长的记忆按「添加」，
// 整条被拒而界面先一步把用户敲的那段清空。数字取 schema 那一份，不在这里重抄。
// §379：注入侧的三档上限（条数／单条／总长）也搬进同一份 shared，让下面那句披露与主进程的预算同源——
// 文案里不写死数字，数字由 params 带出（§361 那族"手抄数字漂移"的正解）。
import {
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_INJECT_MAX_ITEMS,
  MEMORY_INJECT_MAX_ITEM_CHARS,
  MEMORY_INJECT_MAX_TOTAL_CHARS
} from '../../../../shared/schemas/memory'
import { useI18n } from '../../i18n'
import { useConfirm } from '../../components/ConfirmDialog'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { Notice } from './ProviderSettings'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { LoadFailNotice } from '../../components/LoadFailNotice'
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

  /**
   * §273：改前失败侧是 `if (!hasIpcFailed(v)) setItems(v)`＝什么都不做 ⇒ 屏上摆「暂无记忆」，
   * 把通道故障演成"Agent 一条都没记住、你也没手动加过"。这一发的自发重发只在 add／改／删成功之后（`refresh()`），
   * 那是"做完别的事"而不是"想看列表"⇒ 按 §268 判据配一颗重试键。
   */
  const [itemsUnread, setItemsUnread] = useState<{ error?: string } | null>(null)

  const refresh = useCallback(() => {
    window.pocketai
      .listMemories()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setItemsUnread({ error: v.error })
          return
        }
        setItemsUnread(null)
        setItems(v)
      })
      .catch((e: unknown) => {
        setItemsUnread({ error: errText(e, '') })
        logIpcError('memory.list', e)
      })
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
      const added = await window.pocketai.addMemory(content)
      // §333：改前整个返回值不接 ⇒ 内容超 2000 字符被 zod 整条拒（safeHandle 折成 resolve 的 `{ok:false}`，
      // 那句 catch 永不响），屏上照旧弹「已添加」并把用户敲的那段清空＝数据丢了还说成功。
      // 失败时草稿必须留着（原文还在框里才能改短再试），原因走四语字典。
      if (hasIpcFailed(added)) {
        flash(false, ipcFailText(added, t('common.unknownError')))
        return
      }
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
      const updated = await window.pocketai.updateMemory(editingId, content)
      // §333：同上——失败时不收编辑框（关编辑框会把这个输入框整个卸载，刚敲的新内容永久消失）
      if (hasIpcFailed(updated)) {
        flash(false, ipcFailText(updated, t('common.unknownError')))
        return
      }
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
      const res = await window.pocketai.deleteMemory(m.id)
      // §333：改前失败也是 resolve 的值 ⇒ 照旧弹「已删除」，refresh 后那条又回来（看着像闹鬼）。
      // 库里那条没删，这句就得说原因；`reportIpcError` 那句死代码一起换成判据。
      if (hasIpcFailed(res)) {
        flash(false, ipcFailText(res, t('common.unknownError')))
        return
      }
      flash(true, t('set.memoryDeleted'))
      refresh()
    } catch (e) {
      flash(false, errText(e, t('common.unknownError')))
      logIpcError('memory.delete', e)
    }
  }

  return (
    <div>
      <p className="text-xs text-[var(--color-text-muted)] mb-2">
        {t('set.memoryHint', {
          items: MEMORY_INJECT_MAX_ITEMS,
          itemChars: MEMORY_INJECT_MAX_ITEM_CHARS,
          totalChars: MEMORY_INJECT_MAX_TOTAL_CHARS
        })}
      </p>

      <div className="flex gap-2 mb-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && add()}
          maxLength={MEMORY_MAX_CONTENT_CHARS}
          placeholder={t('set.memoryPlaceholder')}
          className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={add}
          disabled={busy || !draft.trim()}
          className="text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] disabled:opacity-50"
        >
          {t('common.add')}
        </button>
      </div>

      {itemsUnread && (
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice what={t('set.memory')} msg={ipcFailText(itemsUnread, t('common.unknownError'))} />
          <button
            data-testid="user-memory-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={refresh}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )}
      {items.length === 0 && !itemsUnread ? (
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
                    maxLength={MEMORY_MAX_CONTENT_CHARS}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveEdit()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                  />
                  <button onClick={saveEdit} disabled={busy || !editDraft.trim()} className="text-[var(--color-accent)] disabled:opacity-50 shrink-0">
                    {t('common.save')}
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-[var(--color-text-muted)] shrink-0">
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 break-words text-[var(--color-text)]">{m.content}</span>
                  <button onClick={() => startEdit(m)} className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] shrink-0">
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
