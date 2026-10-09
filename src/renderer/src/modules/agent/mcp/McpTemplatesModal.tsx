// MCP Server 内置模板弹窗：预置常用免密钥服务，填参一键创建
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import {
  listMcpTemplates,
  instantiateMcpTemplate,
  MCP_TEMPLATE_CATEGORIES,
  type McpTemplate
} from '../../../../../shared/mcp-templates'
import { errText } from '../../../utils/error'

interface Props {
  onClose: () => void
  onCreated: () => Promise<void>
}

export const McpTemplatesModal: React.FC<Props> = ({ onClose, onCreated }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [templates] = useState<McpTemplate[]>(() => listMcpTemplates())
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [createdIds, setCreatedIds] = useState<ReadonlySet<string>>(new Set())
  const [creatingId, setCreatingId] = useState<string | null>(null)

  const setValue = (tplId: string, key: string, v: string) => {
    setValues((prev) => ({ ...prev, [tplId]: { ...prev[tplId], [key]: v } }))
  }

  const handleCreate = async (tpl: McpTemplate) => {
    // 渲染端先行校验占位符，给出带字段名的友好提示（instantiate 内还有兜底）
    for (const p of tpl.placeholders ?? []) {
      if (!String(values[tpl.id]?.[p.key] ?? '').trim()) {
        toast.error(t('agent.tplMissingValue', { label: t(p.label) }))
        return
      }
    }
    const inst = instantiateMcpTemplate(tpl, values[tpl.id] ?? {})
    if (inst.error || !inst.draft) {
      const key = inst.error?.startsWith('missing:') ? inst.error.slice(8) : ''
      const ph = tpl.placeholders?.find((p) => p.key === key)
      toast.error(ph ? t('agent.tplMissingValue', { label: t(ph.label) }) : t('common.unknownError'))
      return
    }
    setCreatingId(tpl.id)
    try {
      const saved = await window.pocketai.saveMcpServer({
        name: inst.draft.name,
        transport: inst.draft.transport,
        runtime: inst.draft.runtime,
        command: inst.draft.command,
        args: inst.draft.args,
        env: inst.draft.env,
        url: inst.draft.url,
        headers: inst.draft.headers,
        enabled: inst.draft.enabled,
        pythonPackages: inst.draft.pythonPackages
      })
      // 闸门拒绝走结构化失败，不是异常
      if ('ok' in saved) {
        toast.error(saved.error)
        return
      }
      setCreatedIds((prev) => new Set(prev).add(tpl.id))
      toast.success(t('agent.tplCreateSuccess', { name: tpl.id }))
      await onCreated()
    } catch (e) {
      toast.error(t('agent.tplCreateFail', { e: errText(e) }))
    } finally {
      setCreatingId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-[640px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('agent.tplTitle')}</h3>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <p className="text-[11px] text-[var(--color-text-muted)]">{t('agent.tplHint')}</p>
          {MCP_TEMPLATE_CATEGORIES.map((cat) => {
            const group = templates.filter((tpl) => tpl.category === cat)
            if (group.length === 0) return null
            return (
              <div key={cat}>
                <h4 className="text-[11px] font-semibold text-[var(--color-text-muted)] mb-1.5">
                  {t(`agent.tplCat${cat[0]!.toUpperCase()}${cat.slice(1)}`)}
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {group.map((tpl) => {
              const created = createdIds.has(tpl.id)
              const busy = creatingId === tpl.id
              return (
                <div
                  key={tpl.id}
                  className={`rounded border p-2.5 flex flex-col gap-1.5 ${
                    created
                      ? 'border-[var(--color-success)] bg-[var(--color-success-bg)]'
                      : 'border-[var(--color-border)]'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold">{tpl.id}</span>
                    {created && (
                      <span className="text-[9px] px-1 rounded bg-[var(--color-success-bg)] text-[var(--color-success)]">
                        ✓ {t('agent.tplCreated')}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                    {t(tpl.desc)}
                  </p>
                  {(tpl.placeholders ?? []).map((p) => (
                    <div key={p.key} className="space-y-0.5">
                      <label className="block text-[10px] font-medium text-[var(--color-text-muted)]">
                        {t(p.label)}
                      </label>
                      <input
                        className="input font-mono text-[11px] py-1"
                        value={values[tpl.id]?.[p.key] ?? ''}
                        onChange={(e) => setValue(tpl.id, p.key, e.target.value)}
                        disabled={created}
                        spellCheck={false}
                      />
                    </div>
                  ))}
                  <div className="mt-auto pt-0.5">
                    <button
                      className="btn-primary w-full text-[11px] py-1"
                      disabled={created || busy || creatingId !== null}
                      onClick={() => void handleCreate(tpl)}
                    >
                      {created ? t('agent.tplCreated') : busy ? t('agent.tplCreating') : t('agent.tplCreate')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
            </div>
          )
        })}
        </div>
        <div className="p-4 border-t border-[var(--color-border)] flex justify-end">
          <button className="btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
