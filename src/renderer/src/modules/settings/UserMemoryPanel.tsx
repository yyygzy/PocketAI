// 用户记忆管理面板：查看/添加/编辑/删除长期记忆条目
// 记忆来源：Agent 对话中经 memory_save 工具主动保存 + 用户手动添加
import React, { useCallback, useEffect, useState } from 'react'
import type { UserMemoryRecord, UserMemorySource } from '../../../../shared/types'
// §333：那道 2000 字上限此前只在 zod 里，输入框不设防 ⇒ 粘一段超长的记忆按「添加」，
// 整条被拒而界面先一步把用户敲的那段清空。数字取 schema 那一份，不在这里重抄。
// §379：注入侧的三档上限（条数／单条／总长）也搬进同一份 shared，让下面那句披露与主进程的预算同源——
// 文案里不写死数字，数字由 params 带出（§361 那族"手抄数字漂移"的正解）。
import {
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_INJECT_MAX_ITEMS,
  MEMORY_INJECT_MAX_ITEM_CHARS,
  MEMORY_INJECT_MAX_TOTAL_CHARS,
  MEMORY_MAX_ROWS
} from '../../../../shared/schemas/memory'
import { useI18n } from '../../i18n'
import { useConfirm } from '../../components/ConfirmDialog'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { Notice } from './ProviderSettings'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { errText } from '../../utils/error'
import { formatDateTime } from '../../utils/time'

/** 来源短语：用户手写 / Agent 写入 / 历史条目（迁移前的行无法回溯写入者） */
const sourceLabel = (
  source: UserMemorySource,
  t: (key: string, params?: Record<string, string | number>) => string
): string => {
  if (source === 'agent') return t('set.memorySource.agent')
  if (source === 'legacy') return t('set.memorySource.legacy')
  return t('set.memorySource.user')
}

const MemoryMeta: React.FC<{
  item: UserMemoryRecord
  conversationTitle?: string
  deleted?: boolean
}> = ({ item, conversationTitle, deleted }) => {
  const { t } = useI18n()
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-muted)]">
      <span>{sourceLabel(item.source, t)}</span>
      <span aria-hidden="true">·</span>
      <span>{t('set.memoryWrittenAt', { time: formatDateTime(item.createdAt) })}</span>
      {/* 会话读不到就不显示这颗指向，不造「无来源」空态 */}
      {conversationTitle && (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('set.memoryFromConversation', { title: conversationTitle })}</span>
        </>
      )}
      {deleted && item.deletedAt != null && (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('set.memoryDeletedAt', { time: formatDateTime(item.deletedAt) })}</span>
        </>
      )}
    </div>
  )
}

export const UserMemoryPanel: React.FC = () => {
  const { t } = useI18n()
  const [items, setItems] = useState<UserMemoryRecord[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirm()
  const { notice, show: showNotice } = useTransientNotice<{ ok: boolean; text: string }>(2500)

  const [view, setView] = useState<'active' | 'deleted'>('active')
  const [deletedItems, setDeletedItems] = useState<UserMemoryRecord[]>([])
  const [deletedLoaded, setDeletedLoaded] = useState(false)
  const [deletedUnread, setDeletedUnread] = useState<{ error?: string } | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [conversationTitles, setConversationTitles] = useState<Record<string, string>>({})
  /** 恢复失败（含达上限）必须留在面板内，不能走几秒就消失的 notice */
  const [actionError, setActionError] = useState<string | null>(null)

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

  const refreshDeleted = useCallback(() => {
    setDeletedUnread(null)
    window.pocketai
      .listDeletedMemories()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setDeletedUnread({ error: v.error })
          setDeletedLoaded(false)
          return
        }
        setDeletedItems(v)
        setDeletedLoaded(true)
        setSelected((prev) => prev.filter((id) => v.some((m) => m.id === id)))
      })
      .catch((e: unknown) => {
        setDeletedUnread({ error: errText(e, '') })
        setDeletedLoaded(false)
        logIpcError('memory.listDeleted', e)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Agent 写入的条目若能在会话列表里找到标题，就显示「来自会话」；读不到就整颗不渲染
  useEffect(() => {
    const ids = new Set(
      [...items, ...deletedItems]
        .filter((m) => m.source === 'agent' && m.conversationId)
        .map((m) => m.conversationId as string)
    )
    if (ids.size === 0) return
    let cancelled = false
    Promise.all([
      window.pocketai.listConversations(),
      window.pocketai.listConversations(undefined, undefined, true)
    ])
      .then(([active, archived]) => {
        if (cancelled) return
        const titles: Record<string, string> = {}
        for (const c of [...active, ...archived]) {
          if (ids.has(c.id) && c.title) titles[c.id] = c.title
        }
        setConversationTitles(titles)
      })
      .catch((e: unknown) => {
        // 读不到会话标题不是记忆面板的故障：隐藏指向即可，不打扰用户
        if (!cancelled) setConversationTitles({})
        logIpcError('memory.conversationTitles', e)
      })
    return () => {
      cancelled = true
    }
  }, [items, deletedItems])

  const flash = (ok: boolean, text: string) => showNotice({ ok, text })

  const atLimit = items.length >= MEMORY_MAX_ROWS
  const nearLimit = !atLimit && items.length >= Math.ceil(MEMORY_MAX_ROWS * 0.8)

  const add = async () => {
    const content = draft.trim()
    if (!content || busy || atLimit) return
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
      setSelected((prev) => prev.filter((id) => id !== m.id))
      setDeletedLoaded(false)
      refresh()
    } catch (e) {
      flash(false, errText(e, t('common.unknownError')))
      logIpcError('memory.delete', e)
    }
  }

  const openDeleted = () => {
    setView('deleted')
    setActionError(null)
    refreshDeleted()
  }

  const restore = async (m: UserMemoryRecord) => {
    if (busy) return
    setActionError(null)
    // 上限判定放在本地：主进程也会拒，但这里能给出四语的明确原因
    if (items.length >= MEMORY_MAX_ROWS) {
      setActionError(t('set.memoryRestoreAtLimit', { max: MEMORY_MAX_ROWS }))
      return
    }
    setBusy(true)
    try {
      const res = await window.pocketai.restoreMemory(m.id)
      if (hasIpcFailed(res)) {
        setActionError(t('set.memoryRestoreFailed', { msg: ipcFailText(res, t('common.unknownError')) }))
        return
      }
      flash(true, t('set.memoryRestored'))
      setSelected((prev) => prev.filter((id) => id !== m.id))
      refresh()
      refreshDeleted()
    } catch (e) {
      setActionError(t('set.memoryRestoreFailed', { msg: errText(e, t('common.unknownError')) }))
      logIpcError('memory.restore', e)
    } finally {
      setBusy(false)
    }
  }

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const purgeSelected = async () => {
    if (selected.length === 0 || busy) return
    const count = selected.length
    if (
      !(await confirm({
        message: t('set.memoryPurgeConfirm', { count }),
        confirmText: t('set.memoryPurgeConfirmAction'),
        danger: true
      }))
    ) {
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const res = await window.pocketai.purgeMemories(selected)
      if (hasIpcFailed(res)) {
        setActionError(t('set.memoryPurgeFailed', { msg: ipcFailText(res, t('common.unknownError')) }))
        return
      }
      flash(true, t('set.memoryPurged', { count: res.deleted }))
      setSelected([])
      refreshDeleted()
    } catch (e) {
      setActionError(t('set.memoryPurgeFailed', { msg: errText(e, t('common.unknownError')) }))
      logIpcError('memory.purge', e)
    } finally {
      setBusy(false)
    }
  }

  const allSelected = deletedItems.length > 0 && selected.length === deletedItems.length

  return (
    <div>
      <p className="text-xs text-[var(--color-text-muted)] mb-2">
        {t('set.memoryHint', {
          items: MEMORY_INJECT_MAX_ITEMS,
          itemChars: MEMORY_INJECT_MAX_ITEM_CHARS,
          totalChars: MEMORY_INJECT_MAX_TOTAL_CHARS
        })}
      </p>

      {!itemsUnread && (nearLimit || atLimit) && (
        <p
          data-testid="user-memory-limit"
          className={`text-xs mb-2 ${atLimit ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
        >
          {atLimit
            ? t('set.memoryLimitReached', { count: items.length, max: MEMORY_MAX_ROWS })
            : t('set.memoryLimitNear', { count: items.length, max: MEMORY_MAX_ROWS })}
        </p>
      )}

      <div className="flex items-center gap-3 mb-2 text-xs">
        <button
          data-testid="user-memory-tab-active"
          onClick={() => setView('active')}
          className={view === 'active' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
        >
          {t('set.memoryTabActive', { count: items.length })}
        </button>
        <button
          data-testid="user-memory-tab-deleted"
          onClick={openDeleted}
          className={view === 'deleted' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
        >
          {deletedLoaded
            ? t('set.memoryTabDeletedCount', { count: deletedItems.length })
            : t('set.memoryDeletedList')}
        </button>
      </div>

      {actionError && (
        <div data-testid="user-memory-action-error" className="mb-2">
          <Notice ok={false} text={actionError} />
        </div>
      )}

      {view === 'active' ? (
        <>
          <div className="flex gap-2 mb-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && add()}
              maxLength={MEMORY_MAX_CONTENT_CHARS}
              disabled={atLimit}
              placeholder={t('set.memoryPlaceholder')}
              className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
            />
            <button
              onClick={add}
              disabled={busy || !draft.trim() || atLimit}
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
                <li key={m.id} className="py-1.5 border-b border-[var(--color-border)] last:border-0">
                  {editingId === m.id ? (
                    <div className="flex items-center gap-2 text-xs">
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
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 text-xs">
                      <span className="flex-1 min-w-0 break-words text-[var(--color-text)]">{m.content}</span>
                      <button onClick={() => startEdit(m)} className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] shrink-0">
                        {t('common.edit')}
                      </button>
                      <button onClick={() => remove(m)} className="text-[var(--color-text-muted)] hover:text-red-500 shrink-0">
                        {t('common.delete')}
                      </button>
                    </div>
                  )}
                  <MemoryMeta item={m} conversationTitle={m.conversationId ? conversationTitles[m.conversationId] : undefined} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {deletedUnread && (
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <LoadFailNotice what={t('set.memoryDeletedList')} msg={ipcFailText(deletedUnread, t('common.unknownError'))} />
              <button className="text-xs underline text-[var(--color-text-muted)]" onClick={refreshDeleted}>
                {t('set.memoryReloadDeleted')}
              </button>
            </div>
          )}

          {atLimit && !deletedUnread && (
            <p className="text-xs mb-2 text-[var(--color-text-muted)]">
              {t('set.memoryRestoreAtLimit', { max: MEMORY_MAX_ROWS })}
            </p>
          )}

          {deletedLoaded && deletedItems.length > 0 && !deletedUnread && (
            <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
              <label className="flex items-center gap-1 text-[var(--color-text-muted)]">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? [] : deletedItems.map((m) => m.id))
                  }
                />
                {t('set.memorySelectAll')}
              </label>
              <button
                data-testid="user-memory-purge"
                onClick={purgeSelected}
                disabled={busy || selected.length === 0}
                className="ml-auto px-2 py-1 rounded border border-[var(--color-danger)] text-[var(--color-danger)] disabled:opacity-50"
              >
                {t('set.memoryPurgeSelected', { count: selected.length })}
              </button>
            </div>
          )}

          {deletedLoaded && deletedItems.length === 0 && !deletedUnread ? (
            <p className="text-xs text-[var(--color-text-muted)]">{t('set.memoryDeletedEmpty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {deletedItems.map((m) => (
                <li key={m.id} className="py-1.5 border-b border-[var(--color-border)] last:border-0">
                  <div className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.includes(m.id)}
                      onChange={() => toggleSelected(m.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="block break-words text-[var(--color-text)]">{m.content}</span>
                      <MemoryMeta
                        item={m}
                        conversationTitle={m.conversationId ? conversationTitles[m.conversationId] : undefined}
                        deleted
                      />
                    </div>
                    <button
                      onClick={() => restore(m)}
                      disabled={busy}
                      className="text-[var(--color-accent)] disabled:opacity-50 shrink-0"
                    >
                      {t('set.memoryRestore')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {notice && <Notice ok={notice.ok} text={notice.text} />}
      {dialog}
    </div>
  )
}
