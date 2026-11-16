// P1-5 第二刀：流程模板面板（顶栏入口 + 下拉）。
//
// 边界（诚实写在界面上）：
//  · 模板只保存"这一轮跑了什么"的形状；套用只把**提示词摘要**填进输入框，
//    工具序列是给人看的参考，不会自动重放（引擎侧不认模板）；
//  · 套用前先过一道闸门：缺引用 / 一条授权都没确认 / 确认的工具这一轮拿不到授权，都拦下并把原因列出来；
//  · 工具授权只在本机生效：导入的模板恒为空，必须在这里逐条重勾——所以导入后直接把用户带到确认清单；
//  · 授权口径不另写一套：这一轮能不能用某个工具，读的是 TOOL_POLICY_SNAPSHOT（与 run 启动同一个解析），
//    面板只负责把"模板用过 / 本机缺失 / 助手未授权"翻成可读的三档。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunbookRecord, RunbookRef, RunbookToolStatus } from '../../../../shared/runbook'
import { RUNBOOK_NAME_MAX, evaluateRunbookStart } from '../../../../shared/runbook'
import type { RunToolGrant, ToolPolicySnapshot } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { hasIpcFailed, ipcFailText, reportIpcError } from '../../utils/ipc'

interface Props {
  /**
   * 套用模板：把提示词摘要交给输入框（由 ChatModule 落进草稿）。
   * 开关打开时一并交出**本轮**工具授权（只含本机可用、已勾选的工具）；
   * 后端会再逐条复核，这里交出去的只是用户的意图，不是授权凭据。
   */
  onApply: (text: string, grant?: RunToolGrant) => void
  /** 当前这一轮归属的助手；授权面按它解析（与 run 启动同一口径） */
  assistantId?: string
}

/** 本机注册表里的工具（内置 + 已启动 MCP）：只读快照，不在渲染端复制判定规则 */
function knownToolsOf(policy: ToolPolicySnapshot): Array<{ id: string; name: string }> {
  return (policy.assistant?.tools ?? policy.tools).map((t) => ({ id: t.id, name: t.name }))
}

/**
 * 当前这一轮的授权面。
 * · 有助手视角时直接用注册表判好的 `granted`（`'*'` 只覆盖内置、MCP 必须逐条，规则不在这里重写）；
 * · 自由会话（没有助手 id）时 run 侧按 `['*']` 解析 ⇒ 内置可用即授权，MCP 仍需逐条，所以只收 builtin/available。
 */
function grantedIdsOf(policy: ToolPolicySnapshot): Set<string> {
  const view = policy.assistant?.tools
  if (view) return new Set(view.filter((t) => t.granted === true).map((t) => t.id))
  return new Set(
    policy.tools.filter((t) => t.source === 'builtin' && t.state === 'available').map((t) => t.id)
  )
}

export const RunbookPanel: React.FC<Props> = ({ onApply, assistantId }) => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, dialog } = useConfirm()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<RunbookRecord[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [missing, setMissing] = useState<RunbookRef[] | null>(null)
  const [unread, setUnread] = useState<string | null>(null)
  const [policy, setPolicy] = useState<ToolPolicySnapshot | null>(null)
  const [policyUnread, setPolicyUnread] = useState<string | null>(null)
  /** 刚导入的一批：导入后停在第一条，并把"要逐条重勾"的引导顶在详情上方 */
  const [importedBatch, setImportedBatch] = useState<{ count: number; ids: string[] } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async (): Promise<RunbookRecord[] | null> => {
    try {
      const r = await window.pocketai.listRunbooks()
      if (hasIpcFailed(r)) {
        setUnread(ipcFailText(r, t('runbook.readFailed')))
        setList([])
        return null
      }
      setUnread(null)
      setList(r)
      setSelectedId((prev) => (prev && r.some((x) => x.id === prev) ? prev : (r[0]?.id ?? null)))
      return r
    } catch (e) {
      setUnread(e instanceof Error ? e.message : t('runbook.readFailed'))
      setList([])
      return null
    }
  }, [t])

  /** 读当前这一轮的授权面（失败时保留上一次成功值，但套用时必须重读成功才放行） */
  const loadPolicy = useCallback(async (): Promise<ToolPolicySnapshot | null> => {
    try {
      const p = await window.pocketai.getToolPolicy(assistantId)
      if (hasIpcFailed(p)) {
        setPolicyUnread(ipcFailText(p, t('runbook.readFailed')))
        return null
      }
      setPolicyUnread(null)
      setPolicy(p)
      return p
    } catch (e) {
      setPolicyUnread(e instanceof Error ? e.message : t('runbook.readFailed'))
      return null
    }
  }, [assistantId, t])

  useEffect(() => {
    if (!open) return
    void reload()
    void loadPolicy()
  }, [open, reload, loadPolicy])

  // 关面板即退出逐条引导：下次打开重新按"还有没有待确认"算，不接着上一次的临时批次
  useEffect(() => {
    if (!open) setImportedBatch(null)
  }, [open])

  // 选中即查一次引用：跨机失效的清单要在"点套用之前"就看得见，不能等失败才说
  useEffect(() => {
    setMissing(null)
    if (!open || !selectedId) return
    let cancelled = false
    window.pocketai
      .checkRunbook(selectedId)
      .then((r) => {
        if (cancelled || hasIpcFailed(r)) return
        setMissing(r.missingRefs)
      })
      // 读不到就按"未校验"处理：套用那一刻还会再查一次，失败会明确报错。
      // 但 reject 面不许空挂（§224）：至少留下可查的日志，不能把一次真抛错彻底咽掉。
      .catch(reportIpcError('runbook.checkRunbook'))
    return () => {
      cancelled = true
    }
  }, [open, selectedId])

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

  /** 闸门随选中项/授权面/缺失清单同步重算：界面上的"为什么不能套用"与套用那一刻同源 */
  const gate = useMemo(() => {
    if (!selected || !policy) return null
    return evaluateRunbookStart(selected, {
      missingRefs: missing ?? [],
      known: knownToolsOf(policy),
      grantedIds: grantedIdsOf(policy)
    })
  }, [selected, policy, missing])

  /**
   * 本次导入批次里还没确认工具授权的（只算这批）。
   * 不用全库计数：历史遗留的零授权模板没有参与这次导入，算进来会把"还剩几条"说大。
   */
  const importPending = useMemo(() => {
    if (!importedBatch || !list) return []
    const byId = new Map(list.map((x) => [x.id, x]))
    return importedBatch.ids
      .map((id) => byId.get(id))
      .filter((x): x is RunbookRecord => !!x && x.steps.length > 0 && x.toolPermissions.length === 0)
  }, [importedBatch, list])

  const applyPatch = useCallback(
    async (id: string, toolPermissions: string[]): Promise<void> => {
      // 先落库再更新本地：失败时不能留下"界面已勾、库里没勾"的假象
      const r = await window.pocketai.updateRunbook({ id, toolPermissions })
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('runbook.readFailed')))
        return
      }
      setList((prev) => prev?.map((item) => (item.id === id ? r : item)) ?? prev)
      // 逐条引导：这一条从"有步骤但零授权"变成有授权，就自动跳到同批下一条未确认的。
      // 只在批次内推进；取消勾选（又变回零授权）不跳，用户仍停在这一条上。
      if (
        importedBatch?.ids.includes(id) &&
        r.steps.length > 0 &&
        r.toolPermissions.length > 0
      ) {
        const byId = new Map((list ?? []).map((x) => [x.id, x]))
        byId.set(id, r)
        const next = importedBatch.ids
          .map((x) => byId.get(x))
          .find(
            (x): x is RunbookRecord =>
              !!x && x.id !== id && x.steps.length > 0 && x.toolPermissions.length === 0
          )
        if (next) {
          setSelectedId(next.id)
          setMissing(null)
          setRenaming(false)
        }
      }
    },
    [t, toast, importedBatch, list]
  )

  const handleToggleTool = (tool: RunbookToolStatus): void => {
    if (!selected || !tool.available) return
    const has = selected.toolPermissions.includes(tool.toolId)
    const next = has
      ? selected.toolPermissions.filter((x) => x !== tool.toolId)
      : [...selected.toolPermissions, tool.toolId]
    void applyPatch(selected.id, next)
  }

  const handleApply = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    try {
      // 授权面在套用那一刻重读一次：面板打开后助手配置可能已经改过
      const freshPolicy = await loadPolicy()
      if (!freshPolicy) {
        toast.error(policyUnread ?? t('runbook.readFailed'))
        return
      }
      const checked = await window.pocketai.checkRunbook(selected.id)
      if (hasIpcFailed(checked)) {
        toast.error(ipcFailText(checked, t('runbook.readFailed')))
        return
      }
      setMissing(checked.missingRefs)
      const fresh = evaluateRunbookStart(selected, {
        missingRefs: checked.missingRefs,
        known: knownToolsOf(freshPolicy),
        grantedIds: grantedIdsOf(freshPolicy)
      })
      if (fresh.blocked) {
        // 缺引用 / 未授权都已在详情里逐条列出；"一条都没勾"只给一句提示（勾选项就在上方）
        if (fresh.unconfirmed) toast.error(t('runbook.toolsRequired'))
        return
      }
      // P1-5：开关打开时把"本机可用且已勾选"的工具作为本轮授权交给 run。
      // 用 `fresh.tools` 的 resolvedId（注册表 id），不用模板里存的原始串——名称回填过的工具也能对上；
      // 本机缺失的不进 grant（套用不被阻塞），全都缺失时索性不带 grant，这一轮按助手基线跑。
      const grantIds = Array.from(
        new Set(fresh.tools.filter((tool) => tool.available && tool.confirmed).map((tool) => tool.toolId))
      )
      const grant: RunToolGrant | undefined =
        freshPolicy.perRunGrantEnabled && grantIds.length > 0
          ? { runbookId: selected.id, toolIds: grantIds }
          : undefined
      onApply(selected.promptSummary, grant)
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
      const fresh = await reload()
      // 导入后直接落到这批里第一条"待确认授权"的模板（零步骤的模板不需要确认，跳过它）
      const byId = new Map((fresh ?? []).map((x) => [x.id, x]))
      const firstPending = r.ids.find((id) => {
        const item = byId.get(id)
        return !!item && item.steps.length > 0 && item.toolPermissions.length === 0
      })
      setSelectedId(firstPending ?? r.ids[0] ?? null)
      setImportedBatch({ count: r.imported, ids: r.ids })
      setRenaming(false)
      setMissing(null)
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
      setRenaming(false)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('runbook.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async (): Promise<void> => {
    if (!selected || busy) return
    const name = renameDraft.trim()
    if (!name) {
      toast.error(t('runbook.nameEmpty'))
      return
    }
    if (name === selected.name) {
      setRenaming(false)
      return
    }
    // 长度上限不交给 zod：超长时在这里挡住并给出明确文案，别让用户只看到一句"读取失败"
    if (name.length > RUNBOOK_NAME_MAX) {
      toast.error(t('runbook.nameTooLong', { n: RUNBOOK_NAME_MAX, len: name.length }))
      return
    }
    // 重名不禁止（导入本来就允许同名并列），但要让用户知道会多出一条同名模板
    if (list?.some((r) => r.id !== selected.id && r.name === name)) {
      if (!(await confirm({ message: t('runbook.nameDuplicate', { name }) }))) return
    }
    setBusy(true)
    try {
      const r = await window.pocketai.updateRunbook({ id: selected.id, name })
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('runbook.readFailed')))
        return
      }
      setList((prev) => prev?.map((item) => (item.id === selected.id ? r : item)) ?? prev)
      setRenaming(false)
      toast.success(t('runbook.renamed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('runbook.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  const tools = gate?.tools ?? []

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
          {policyUnread && (
            <p className="mt-2 text-[var(--color-danger)]" data-testid="runbook-policy-unread">
              {policyUnread}
            </p>
          )}
          {!unread && list && list.length === 0 && (
            <p className="mt-2 text-[var(--color-text-muted)]">{t('runbook.empty')}</p>
          )}

          {importedBatch && importedBatch.count > 0 && importPending.length > 0 && (
            <div
              className="mt-2 rounded border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-2"
              data-testid="runbook-import-guide"
            >
              <p className="text-[var(--color-text)]">{t('runbook.importGuideTitle', { n: importedBatch.count })}</p>
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('runbook.importGuideHint')}</p>
              <p className="mt-1 text-[11px] text-[var(--color-warning)]" data-testid="runbook-import-pending">
                {t('runbook.importGuidePending', { n: importPending.length })}
              </p>
            </div>
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
                    setRenaming(false)
                  }}
                  data-testid="runbook-item"
                  className={`px-2 py-0.5 rounded border text-[11px] ${
                    item.id === selectedId
                      ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]'
                  }`}
                >
                  {item.name} · {t('runbook.stepsCount', { n: item.steps.length })}
                  {item.steps.length > 0 && item.toolPermissions.length === 0 && (
                    <span className="ml-1 text-[var(--color-warning)]" data-testid="runbook-item-pending">
                      · {t('runbook.needsConfirm')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="mt-3 space-y-2" data-testid="runbook-detail">
              {gate?.blocked && (
                <p className="text-[var(--color-danger)]" data-testid="runbook-blocked">
                  {t('runbook.blockedHint')}
                </p>
              )}

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

              {gate && gate.missingTools.length > 0 && (
                <div
                  className="rounded border border-[var(--color-warning)] p-2"
                  data-testid="runbook-missing-tools"
                >
                  <p className="text-[var(--color-warning)]">
                    {t('runbook.missingToolsTitle', { n: gate.missingTools.length })}
                  </p>
                  <ul className="mt-1 list-disc pl-4">
                    {gate.missingTools.map((tool) => (
                      <li key={tool.toolId} className="break-words font-mono">
                        {tool.toolName}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {gate && gate.unauthorizedTools.length > 0 && (
                <div className="rounded border border-[var(--color-danger)] p-2" data-testid="runbook-unauthorized">
                  <p className="text-[var(--color-danger)]">
                    {t('runbook.unauthorizedTitle', { n: gate.unauthorizedTools.length })}
                  </p>
                  <ul className="mt-1 list-disc pl-4">
                    {gate.unauthorizedTools.map((tool) => (
                      <li key={tool.toolId} className="break-words font-mono">
                        {tool.toolName}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('runbook.unauthorizedHint')}</p>
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
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{t('runbook.toolsUsedHint')}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {tools.map((tool) => (
                    <label key={tool.toolId} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={selected.toolPermissions.includes(tool.toolId)}
                        disabled={!tool.available || busy}
                        onChange={() => handleToggleTool(tool)}
                        data-testid="runbook-tool"
                        data-tool-id={tool.toolId}
                        data-available={tool.available ? '1' : '0'}
                      />
                      <span className="font-mono">{tool.toolName}</span>
                      {!tool.available && (
                        <span className="text-[var(--color-warning)]" data-testid="runbook-tool-missing">
                          {t('runbook.toolMissing')}
                        </span>
                      )}
                      {tool.available && !tool.granted && (
                        <span className="text-[var(--color-danger)]" data-testid="runbook-tool-not-granted">
                          {t('runbook.toolNotGranted')}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                {selected.toolPermissions.length === 0 && (
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('runbook.toolsHint')}</p>
                )}
              </div>

              {renaming ? (
                <div data-testid="runbook-rename-form">
                  <div className="flex items-center gap-1">
                    <input
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      placeholder={t('runbook.renamePlaceholder')}
                      aria-invalid={renameDraft.length > RUNBOOK_NAME_MAX}
                      data-testid="runbook-rename-input"
                      className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[var(--color-text)]"
                    />
                    <button
                      type="button"
                      onClick={() => void handleRename()}
                      disabled={busy}
                      data-testid="runbook-rename-save"
                      className="px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(false)}
                      disabled={busy}
                      data-testid="runbook-rename-cancel"
                      className="px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]" data-testid="runbook-name-limit">
                    {t('runbook.nameLimit', { n: RUNBOOK_NAME_MAX })}
                  </p>
                  {renameDraft.length > RUNBOOK_NAME_MAX && (
                    <p className="text-[11px] text-[var(--color-danger)]" data-testid="runbook-name-too-long">
                      {t('runbook.nameTooLong', { n: RUNBOOK_NAME_MAX, len: renameDraft.length })}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRenameDraft(selected.name)
                      setRenaming(true)
                    }}
                    data-testid="runbook-rename"
                    className="px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"
                  >
                    {t('runbook.rename')}
                  </button>
                </div>
              )}

              {policy?.perRunGrantEnabled && (
                <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="runbook-grant-hint">
                  {t('runbook.grantHint')}
                </p>
              )}

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
