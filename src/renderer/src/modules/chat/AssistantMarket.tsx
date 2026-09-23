import React, { useEffect, useState } from 'react'
import type { AssistantRecord, ProviderRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { AssistantEditor } from './AssistantEditor'
import { reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { useTransientNotice } from '../../hooks/useTransientNotice'

interface Props {
  providers: ProviderRecord[]
  onClose: () => void
  onChanged: () => void
  /** 使用某个助手（内置或自定义）：选中并新建对话 */
  onUse?: (id: string) => void
  /** 打开市场时直接进入该助手的详情页 */
  initialDetailId?: string
}

type View =
  | { mode: 'grid' }
  | { mode: 'detail'; id: string }
  | { mode: 'edit'; id: string }
  | { mode: 'create' }

export const AssistantMarket: React.FC<Props> = ({ providers, onClose, onChanged, onUse, initialDetailId }) => {
  const { t } = useI18n()
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [view, setView] = useState<View>(initialDetailId ? { mode: 'detail', id: initialDetailId } : { mode: 'grid' })
  const { notice: toast, show: flash } = useTransientNotice<string>(2000)

  const load = () => window.pocketai.listAssistants().then(setAssistants).catch(reportIpcError('assistantMarket.list'))
  useEffect(() => {
    load()
  }, [])

  const current = view.mode === 'detail' || view.mode === 'edit'
    ? assistants.find((a) => a.id === view.id) ?? null
    : null

  const handleDuplicate = async (id: string) => {
    try {
      await window.pocketai.duplicateAssistant(id)
    } catch (e) {
      flash(errText(e))
      return
    }
    await load()
    onChanged()
    flash(t('am.duplicated'))
    setView({ mode: 'grid' })
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('am.deleteConfirm'))) return
    await window.pocketai.deleteAssistant(id)
    await load()
    onChanged()
    setView({ mode: 'grid' })
  }

  const handleTogglePin = async (a: AssistantRecord) => {
    await window.pocketai.setAssistantPinned(a.id, !a.isPinned)
    await load()
  }

  const modelNameOf = (a: AssistantRecord) => {
    if (!a.defaultProviderId || !a.defaultModel) return null
    const p = providers.find((x) => x.id === a.defaultProviderId)
    return p ? `${p.name} / ${a.defaultModel}` : a.defaultModel
  }

  const builtinBadge = `text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]`
  const mineBadge = `text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]`

  return (
    <div className="fixed inset-0 z-50 bg-[var(--color-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="shrink-0 flex items-center justify-between px-5 h-14 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            {(view.mode === 'detail' || view.mode === 'edit' || view.mode === 'create') && (
              <button onClick={() => setView({ mode: 'grid' })} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg" title={t('common.back')}>
                ←
              </button>
            )}
            <h2 className="font-semibold">
              {view.mode === 'grid' && t('am.market')}
              {view.mode === 'detail' && t('am.detail')}
              {view.mode === 'edit' && t('am.edit')}
              {view.mode === 'create' && t('am.create')}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {view.mode === 'grid' && (
              <button className="btn-primary text-xs" onClick={() => setView({ mode: 'create' })}>
                {t('am.new')}
              </button>
            )}
            <button onClick={onClose} title={t('common.close')} className="w-8 h-8 rounded hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] text-lg leading-none">×</button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {view.mode === 'grid' && (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {assistants.map((a) => (
                <div
                  key={a.id}
                  onClick={() => setView({ mode: 'detail', id: a.id })}
                  className="cursor-pointer rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] p-4 hover:border-[var(--color-accent)] transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <span className="text-3xl">{a.avatar}</span>
                    <div className="flex gap-1">
                      {a.isPinned && <span title={t('am.pinned')}>📌</span>}
                      {a.isBuiltin ? (
                        <span className={builtinBadge}>{t('am.builtin')}</span>
                      ) : (
                        <span className={mineBadge}>{t('am.mine')}</span>
                      )}
                    </div>
                  </div>
                  <h3 className="mt-2 font-medium text-sm">{a.name}</h3>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-3 leading-relaxed">{a.description}</p>
                </div>
              ))}
            </div>
          )}

          {view.mode === 'detail' && current && (
            <div className="max-w-2xl">
              <div className="flex items-start gap-4">
                <span className="text-5xl">{current.avatar}</span>
                <div className="flex-1">
                  <h3 className="text-xl font-semibold flex items-center gap-2">
                    {current.name}
                    {current.isBuiltin ? (
                      <span className="badge badge-accent">{t('am.builtin')}</span>
                    ) : (
                      <span className="badge badge-muted">{t('am.mine')}</span>
                    )}
                  </h3>
                  <p className="text-sm text-[var(--color-text-muted)] mt-1">{current.description}</p>
                </div>
              </div>

              <dl className="mt-5 space-y-3 text-sm">
                {modelNameOf(current) && (
                  <div>
                    <dt className="text-xs text-[var(--color-text-muted)] mb-0.5">{t('am.defaultModel')}</dt>
                    <dd className="font-mono text-xs">{modelNameOf(current)}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-[var(--color-text-muted)] mb-0.5">{t('am.welcome')}</dt>
                  <dd className="bg-[var(--color-input-bg)] rounded-lg p-3 text-[13px]">{current.welcomeMessage || t('am.noWelcome')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-muted)] mb-0.5">System Prompt</dt>
                  <dd className="bg-[var(--color-input-bg)] rounded-lg p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-60 overflow-y-auto">
                    {current.systemPrompt || t('am.noPrompt')}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2 mt-5">
                {onUse && (
                  <button
                    className="btn-primary"
                    onClick={() => onUse(current.id)}
                  >
                    {t('am.use')}
                  </button>
                )}
                {current.isBuiltin ? (
                  <button className="btn-ghost" onClick={() => handleDuplicate(current.id)}>
                    {t('am.copy')}
                  </button>
                ) : (
                  <>
                    <button className="btn-ghost" onClick={() => setView({ mode: 'edit', id: current.id })}>
                      {t('common.edit')}
                    </button>
                    <button className="btn-ghost text-[var(--color-danger)]" onClick={() => handleDelete(current.id)}>
                      {t('common.delete')}
                    </button>
                  </>
                )}
                <button className="btn-ghost" onClick={() => handleTogglePin(current)}>
                  {current.isPinned ? t('am.unpin') : t('am.pin')}
                </button>
              </div>
            </div>
          )}

          {(view.mode === 'edit' || view.mode === 'create') && (
            <div className="max-w-2xl">
              <AssistantEditor
                initial={view.mode === 'edit' && current ? current : {}}
                providers={providers}
                onCancel={() => setView({ mode: 'grid' })}
                onSaved={async () => {
                  await load()
                  onChanged()
                  setView({ mode: 'grid' })
                  flash(t('am.saved'))
                }}
              />
            </div>
          )}
        </div>

        {toast && (
          <div className="shrink-0 px-5 py-2 text-xs text-center bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}
