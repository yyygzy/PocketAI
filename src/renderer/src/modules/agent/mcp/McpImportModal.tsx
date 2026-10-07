// MCP Server 批量导入弹窗（Claude Desktop 风格 mcpServers JSON）
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import { parseMcpServersJson, type McpImportItem } from '../../../../../shared/mcp-import'
import { errText } from '../../../utils/error'

interface Props {
  onClose: () => void
  onImported: () => Promise<void>
}

export const McpImportModal: React.FC<Props> = ({ onClose, onImported }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [raw, setRaw] = useState('')
  const [parsed, setParsed] = useState<{ ok: McpImportItem[]; err: McpImportItem[] } | null>(null)
  const [importing, setImporting] = useState(false)

  const handleParse = () => {
    const r = parseMcpServersJson(raw)
    if (r.error) {
      setParsed(null)
      toast.error(r.error)
      return
    }
    setParsed({ ok: r.items.filter((i) => i.draft), err: r.items.filter((i) => i.error) })
  }

  const handleImport = async () => {
    if (!parsed || parsed.ok.length === 0) return
    setImporting(true)
    let success = 0
    const warnings: string[] = []
    for (const item of parsed.ok) {
      if (!item.draft) continue
      try {
        await window.pocketai.saveMcpServer({
          name: item.draft.name,
          transport: item.draft.transport,
          runtime: item.draft.runtime,
          command: item.draft.command,
          args: item.draft.args,
          env: item.draft.env,
          url: item.draft.url,
          headers: item.draft.headers,
          enabled: item.draft.enabled,
          pythonPackages: item.draft.pythonPackages
        })
        success++
        if (item.warning) warnings.push(`${item.key}: ${item.warning}`)
      } catch (e) {
        warnings.push(`${item.key}: ${errText(e)}`)
      }
    }
    await onImported()
    setImporting(false)
    toast.success(t('agent.importSuccess', { n: success }))
    if (warnings.length) toast.error(warnings.join('；'))
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-[560px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('agent.importTitle')}</h3>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {t('agent.importHint')}
          </p>
          <textarea
            className="input font-mono text-xs w-full min-h-[160px]"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={t('agent.importPh')}
            spellCheck={false}
          />
          {parsed && (
            <div className="space-y-2">
              {parsed.ok.length > 0 && (
                <div className="rounded border border-[var(--color-border)] p-2">
                  <div className="text-[11px] font-medium mb-1">
                    {t('agent.importOk', { n: parsed.ok.length })}
                  </div>
                  <div className="space-y-1">
                    {parsed.ok.map((item) => (
                      <div key={item.key} className="flex items-center gap-1 text-[10px]">
                        <span className="text-[var(--color-success)]">●</span>
                        <span className="font-mono">{item.key}</span>
                        <span className="text-[var(--color-text-muted)]">
                          [{item.draft?.transport}]
                        </span>
                        {item.warning && (
                          <span className="text-[var(--color-warning)]">({item.warning})</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {parsed.err.length > 0 && (
                <div className="rounded border border-[var(--color-border)] p-2">
                  <div className="text-[11px] font-medium mb-1 text-[var(--color-danger)]">
                    {t('agent.importErr', { n: parsed.err.length })}
                  </div>
                  <div className="space-y-1">
                    {parsed.err.map((item) => (
                      <div key={item.key} className="flex items-center gap-1 text-[10px]">
                        <span className="text-[var(--color-danger)]">●</span>
                        <span className="font-mono">{item.key}</span>
                        <span className="text-[var(--color-danger)]">{item.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-4 border-t border-[var(--color-border)] flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-ghost" onClick={handleParse}>
            {t('agent.importParse')}
          </button>
          <button
            className="btn-primary"
            onClick={() => void handleImport()}
            disabled={!parsed || parsed.ok.length === 0 || importing}
          >
            {importing ? t('agent.importing') : t('agent.importConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
