// P1-5 第一刀：流程模板面板（顶栏入口 + 下拉）。
//
// 边界（诚实写在界面上）：
//  · 模板只保存"这一轮跑了什么"的形状；套用只把**提示词摘要**填进输入框，
//    工具序列是给人看的参考，不会自动重放（引擎侧不认模板）；
//  · 套用前先过一道闸门：缺引用 / 工具授权为空都拦下并把原因列出来，不静默失败；
//  · 工具授权只在本机生效：导入的模板恒为空，必须在这里逐条重勾。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RunbookRecord, RunbookRef } from '../../../../shared/runbook'
import { evaluateRunbookApply, uniqueRunbookTools } from '../../../../shared/runbook'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { hasIpcFailed, ipcFailText } from '../../utils/ipc'

interface Props {
  /** 套用模板：把提示词摘要交给输入框（由 ChatModule 落进草稿） */
  onApply: (text: string) => void
}

export const RunbookPanel: React.FC<Props> = ({ onApply }) => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, dialog } = useConfirm()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<RunbookRecord[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [missing, setMissing] = useState<RunbookRef[] | null>(null)
  const [unread, setUnread] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await window.pocketai.listRunbooks()
      if (hasIpcFailed(r)) {
        setUnread(ipcFailText(r, t('runbook.readFailed')))
        setList([])
        return
      }
      setUnread(null)
      setList(r)
      setSelectedId((prev) => (prev && r.some((x) => x.id === prev) ? prev : (r[0]?.id ?? null)))
    } catch (e) {
      setUnread(e instanceof Error ? e.message : t('runbook.readFailed'))
      setList([])
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, reload])

  // 点外部 / Esc 收起（与顶栏其他下拉同一套手感）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  /** 引用种类的中文名：逐分支字面量取词（仓库硬规则：不新增动态 t()） */
  const refKindLabel = (kind: RunbookRef['kind']): string => {
    switch (kind) {
      case 'skill':
        return t('runbook.kind.skill')
      case 'knowledge_base':
        return t('runbook.kind.knowledge_base')
      case 'mcp':
        return t('runbook.kind.mcp')
      case 'path':
        return t('runbook.kind.path')
      default:
        return kind
    }
  }

  const selected = list?.find((r) => r.id === selectedId) ?? null

  const applyPatch = useCallback(
    async (id: string, toolPermissions: string[]): Promise<void> => {
      // 先落库再更新本地：失败时不能留下"界面已勾、库里没勾"的假象
      const r = await window.pocketai.updateRunbook({ id, toolPermissions })
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('runbook.readFailed')))
        return
      }
      setList((prev) => prev?.map((item) => (item.id === id ? r : item)) ?? prev)
    },
    [t, toast]
  )

  const handleToggleTool = (toolId: string): void => {
    if (!selected) return
    const has = selected.toolPermissions.includes(toolId)
    const next = has
      ? selected.toolPermissions.filter((x) => x !== toolId)
      : [...selected.toolPermissions, toolId]
    void applyPatch(selected.id, next)
  }

  const handleApply = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const checked = await window.pocketai.checkRunbook(selected.id)
      if (hasIpcFailed(checked)) {
        toast.error(ipcFailText(checked, t('runbook.readFailed')))
        return
      }
      const gate = evaluateRunbookApply(selected, checked.missingRefs)
      setMissing(gate.missingRefs)
      if (gate.blocked) {
        // 缺引用列在面板里；授权为空只给一句"先勾选"（勾选项就在下方）
        if (gate.toolPermissionsEmpty) toast.error(t('runbook.toolsRequired'))
        return
      }
      onApply(selected.promptSummary)
      toast.success(t('runbook.applied'))
      setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('runbook.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await window.pocketai.importRunbooks()
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('runbook.readFailed')))
        return
      }
      if ('canceled' in r) return
      const skipped = r.skipped > 0 ? t('runbook.importSkipped', { n: r.skipped }) : ''
      toast.success(t('runbook.imported', { n: r.imported }) + skipped)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('runbook.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await window.pocketai.exportRunbooks()
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('runbook.readFailed')))
        return
      }
      if ('canceled' in r) return
      toast.success(t('runbook.exported', { n: r.count, path: r.path }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('runbook.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!selected || busy) return
    if (!(await confirm({ message: t('runbook.deleteConfirm', { name: selected.name }), danger: true }))) return
    setBusy(true)
    try {
      const r = await window.pocketai.deleteRunbook(selected.id)
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('runbook.readFailed')))
        return
      }
      toast.success(t('runbook.deleted'))
      setMissing(null)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('runbook.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  const tools = selected ? uniqueRunbookTools(selected.steps) : []

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t('runbook.title')}
        data-testid="runbook-entry"
        className="px-2 py-1 rounded text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
      >
        🧩 {t('runbook.entry')}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-40 w-[380px] max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg p-3 text-xs"
          data-testid="runbook-panel"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--color-text)]">{t('runbook.title')}</span>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={busy}
              data-testid="runbook-import"
              className="ml-auto px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
            >
              {t('runbook.import')}
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={busy || !list || list.length === 0}
              data-testid="runbook-export"
              className="px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
            >
              {t('runbook.export')}
            </button>
          </div>

          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('runbook.hint')}</p>

          {unread && <p className="mt-2 text-[var(--color-danger)]">{unread}</p>}
          {!unread && list && list.length === 0 && (
            <p className="mt-2 text-[var(--color-text-muted)]">{t('runbook.empty')}</p>
          )}

          {list && list.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {list.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id)
                    setMissing(null)
                  }}
                  data-testid="runbook-item"
                  className={`px-2 py-0.5 rounded border text-[11px] ${
                    item.id === selectedId
                      ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]'
                  }`}
                >
                  {item.name} · {t('runbook.stepsCount', { n: item.steps.length })}
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="mt-3 space-y-2" data-testid="runbook-detail">
              {missing && missing.length > 0 && (
                <div className="rounded border border-[var(--color-danger)] p-2" data-testid="runbook-missing">
                  <p className="text-[var(--color-danger)]">{t('runbook.missingTitle', { n: missing.length })}</p>
                  <ul className="mt-1 list-disc pl-4">
                    {missing.map((ref) => (
                      <li key={`${ref.kind}:${ref.id}`}>
                        {refKindLabel(ref.kind)}：{ref.label}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('runbook.missingHint')}</p>
                </div>
              )}

              {selected.promptSummary && (
                <div>
                  <p className="text-[var(--color-text-muted)]">{t('runbook.promptTitle')}</p>
                  <p className="mt-0.5 text-[var(--color-text)] whitespace-pre-wrap break-words">
                    {selected.promptSummary}
                  </p>
                </div>
              )}

              <div>
                <p className="text-[var(--color-text-muted)]">
                  {t('runbook.stepsTitle', { n: selected.steps.length })}
                </p>
                <ol className="mt-0.5 list-decimal pl-4 space-y-0.5 text-[var(--color-text)]">
                  {selected.steps.map((step, i) => (
                    <li key={`${step.toolName}:${i}`} className="break-words">
                      <span className="font-mono">{step.toolName}</span>
                      {step.argKeys.length > 0 && (
                        <span className="text-[var(--color-text-muted)]">（{step.argKeys.join(', ')}）</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <p className="text-[var(--color-text-muted)]">{t('runbook.refsTitle')}</p>
                {selected.refs.length === 0 ? (
                  <p className="text-[11px] text-[var(--color-text-muted)]">{t('runbook.refsNone')}</p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5">
                    {selected.refs.map((ref) => (
                      <li key={`${ref.kind}:${ref.id}`} className="break-words">
                        {refKindLabel(ref.kind)}：{ref.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="text-[var(--color-text-muted)]">{t('runbook.toolsTitle')}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {tools.map((tool) => (
                    <label key={tool.toolId} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={selected.toolPermissions.includes(tool.toolId)}
                        onChange={() => handleToggleTool(tool.toolId)}
                        data-testid="runbook-tool"
                        data-tool-id={tool.toolId}
                      />
                      <span className="font-mono">{tool.toolName}</span>
                    </label>
                  ))}
                </div>
                {selected.toolPermissions.length === 0 && (
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('runbook.toolsHint')}</p>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleApply()}
                  disabled={busy}
                  data-testid="runbook-apply"
                  className="px-2 py-0.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] disabled:opacity-50"
                >
                  {t('runbook.apply')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={busy}
                  data-testid="runbook-delete"
                  className="px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-danger)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                >
                  {t('runbook.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {dialog}
    </div>
  )
}
