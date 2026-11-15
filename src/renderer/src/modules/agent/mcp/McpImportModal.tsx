// MCP Server 批量导入弹窗（Claude Desktop 风格 mcpServers JSON）
//
// 解析/落库统一走主进程 mcp-import-service：与文件导入同一条路径（同名并存、凭据清空）。
// 粘贴没有文件包，所以包级校验和恒为 absent——界面照实说「未校验完整性」，不假装验过。
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import { parseMcpServersJson, type McpImportItem } from '../../../../../shared/mcp-import'
import { formatMcpLaunch, mcpSecretKeyHint } from './mcp-launch'
import { errText } from '../../../utils/error'

interface Props {
  onClose: () => void
  onImported: () => Promise<void>
}

interface ImportResult {
  imported: Array<{ key: string; name: string }>
  failed: Array<{ key: string; error: string }>
  clearedKeys: string[]
  warnings: string[]
}

/** 只把回码翻成四语文案；主进程给的用户可读原文原样透出 */
function pasteImportErrorText(code: string | undefined, t: (k: string) => string): string {
  if (code === 'IMPORT_EMPTY') return t('agent.importEmpty')
  if (code === 'CHECKSUM_MISMATCH') return t('cap.mcp.checksumMismatch')
  if (code === 'CHECKSUM_UNSUPPORTED') return t('cap.mcp.checksumUnsupported')
  return code ?? t('cap.mcp.importFailed')
}

export const McpImportModal: React.FC<Props> = ({ onClose, onImported }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [raw, setRaw] = useState('')
  const [parsed, setParsed] = useState<{ ok: McpImportItem[]; err: McpImportItem[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const handleParse = () => {
    const r = parseMcpServersJson(raw)
    if (r.error) {
      setParsed(null)
      setResult(null)
      toast.error(r.error)
      return
    }
    setParsed({ ok: r.items.filter((i) => i.draft), err: r.items.filter((i) => i.error) })
  }

  const handleImport = async () => {
    if (!parsed || parsed.ok.length === 0) return
    setImporting(true)
    try {
      // 预览只决定按钮能不能按；真正的解析与落库在主进程，和文件导入同一函数
      const r = await window.pocketai.importMcpServersFromText(raw)
      if (!r.ok) {
        toast.error(pasteImportErrorText(r.error, t))
        return
      }
      setResult(r)
      await onImported()
      if (r.imported.length > 0) toast.success(t('agent.importSuccess', { n: r.imported.length }))
      if (r.failed.length > 0) {
        toast.error(r.failed.map((f) => `${f.key}: ${f.error}`).join('；'))
      }
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    } finally {
      setImporting(false)
    }
  }

  const renamed = result ? result.imported.filter((i) => i.name !== i.key).length : 0

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
            onChange={(e) => {
              setRaw(e.target.value)
              setResult(null)
            }}
            placeholder={t('agent.importPh')}
            spellCheck={false}
          />
          <p className="text-[11px] text-[var(--color-text-muted)]">{t('agent.importPasteNotice')}</p>
          {parsed && (
            <div className="space-y-2">
              {parsed.ok.length > 0 && (
                <div className="rounded border border-[var(--color-border)] p-2">
                  <div className="text-[11px] font-medium mb-1">
                    {t('agent.importOk', { n: parsed.ok.length })}
                  </div>
                  {/* SEC-2：把导入后「点启动就会执行的命令」摊开，只显 key+transport 等于没预览 */}
                  <div className="text-[10px] text-[var(--color-warning)] mb-1">
                    {t('agent.importCmdHeader')}
                  </div>
                  <div className="space-y-1">
                    {parsed.ok.map((item) => (
                      <div key={item.key} className="text-[10px]">
                        <div className="flex items-center gap-1">
                          <span className="text-[var(--color-success)]">●</span>
                          <span className="font-mono">{item.key}</span>
                          <span className="text-[var(--color-text-muted)]">
                            [{item.draft?.transport}]
                          </span>
                          {item.warning && (
                            <span className="text-[var(--color-warning)]">({item.warning})</span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-[var(--color-text-muted)] break-all pl-4">
                          {formatMcpLaunch(item.draft)}
                        </div>
                        {mcpSecretKeyHint(item.draft) && (
                          <div className="text-[10px] text-[var(--color-text-muted)] pl-4">
                            {t('agent.importSecretKeys', { keys: mcpSecretKeyHint(item.draft) })}
                          </div>
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
          {result && (
            <div
              className="space-y-1 rounded border border-[var(--color-border)] p-2 text-[11px]"
              data-testid="mcp-import-result"
            >
              <div className="text-[var(--color-success)]">
                {t('agent.importSuccess', { n: result.imported.length })}
              </div>
              {result.clearedKeys.length > 0 && (
                <div className="text-[var(--color-warning)]" data-testid="mcp-import-cleared">
                  {t('agent.importSecretsCleared', {
                    n: result.clearedKeys.length,
                    keys: result.clearedKeys.join('、')
                  })}
                </div>
              )}
              {renamed > 0 && (
                <div className="text-[var(--color-text-muted)]">
                  {t('agent.importNameSuffixed', { n: renamed })}
                </div>
              )}
              {/* 粘贴没有文件包：这里必须明说没校验，不能让人以为「导入成功」＝「验过完整性」 */}
              <div className="text-[var(--color-text-muted)]" data-testid="mcp-import-unverified">
                {t('agent.importUnverified')}
              </div>
              {result.warnings.length > 0 && (
                <div className="text-[var(--color-text-muted)]">
                  {result.warnings.join('；')}
                </div>
              )}
              {result.failed.length > 0 && (
                <div className="text-[var(--color-danger)]">
                  {result.failed.map((f) => `${f.key}: ${f.error}`).join('；')}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-4 border-t border-[var(--color-border)] flex gap-2 justify-end">
          {result ? (
            <button className="btn-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
