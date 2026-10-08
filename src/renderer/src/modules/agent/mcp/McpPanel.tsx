// MCP Server 管理面板：左列表（启停/编辑/删除 + pip 源） / 右编辑表单或日志
import React, { useCallback, useEffect, useState } from 'react'
import type {
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent,
  McpServerLogEvent,
  PythonPipSource
} from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import { StatusDot, MiniBtn } from '../ui'
import { usePipSource } from './usePipSource'
import { McpForm } from './McpForm'
import { McpImportModal } from './McpImportModal'
import { McpTemplatesModal } from './McpTemplatesModal'
import { reportIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

/** 单个工具的试运行状态（key = `${serverId}:${toolName}`） */
interface ToolRunState {
  argsJson: string
  running: boolean
  result?: string
  isError?: boolean
}

export const McpPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const [records, setRecords] = useState<McpServerRecord[]>([])
  const [runtimes, setRuntimes] = useState<McpServerRuntime[]>([])
  const [editing, setEditing] = useState<Partial<McpServerRecord> | null>(null)
  const [logs, setLogs] = useState<McpServerLogEvent[]>([])
  const [notice, setNotice] = useState('')
  // 正在安装依赖的 serverId 集合（全局广播跟踪，用于禁用列表卡片上的删除按钮）
  const [installingIds, setInstallingIds] = useState<ReadonlySet<string>>(new Set())
  // 工具列表展开状态（按 serverId）
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({})
  // 工具试运行状态（输入与结果都按工具维度暂存，切换不丢）
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRunState>>({})
  const [importOpen, setImportOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)

  const pip = usePipSource(setNotice)

  const load = useCallback(async () => {
    const [recs, runs] = await Promise.all([
      window.pocketai.listMcpServers(),
      window.pocketai.getMcpRuntimes()
    ])
    setRecords(recs)
    setRuntimes(runs)
  }, [])

  useEffect(() => {
    // load 内部无 try-catch，需挂 .catch 避免未处理 rejection
    void load().catch(reportIpcError('mcp.list'))
  }, [load])

  // 订阅状态变化
  useEffect(() => {
    const off = window.pocketai.onMcpStatus((evt: McpServerStatusEvent) => {
      setRuntimes((prev) => {
        const idx = prev.findIndex((r) => r.id === evt.serverId)
        const base =
          prev[idx] ?? records.find((r) => r.id === evt.serverId) ?? null
        const updated: McpServerRuntime = {
          id: evt.serverId,
          name: base?.name ?? '',
          transport: base?.transport ?? 'stdio',
          runtime: base?.runtime ?? 'binary',
          command: base?.command ?? null,
          args: base?.args ?? [],
          env: base?.env ?? {},
          url: base?.url ?? null,
          headers: base?.headers ?? {},
          enabled: base?.enabled ?? false,
          createdAt: base?.createdAt ?? Date.now(),
          pythonPackages: base?.pythonPackages ?? [],
          status: evt.status,
          tools: evt.tools ?? [],
          lastError: evt.lastError ?? null,
          pid: evt.pid
        }
        if (idx === -1) return [...prev, updated]
        const next = [...prev]
        next[idx] = updated
        return next
      })
    })
    return off
  }, [records])

  // 订阅日志（仅保留最近 200 条）
  useEffect(() => {
    const off = window.pocketai.onMcpLog((evt: McpServerLogEvent) => {
      setLogs((prev) => [...prev.slice(-199), evt])
    })
    return off
  }, [])

  // 跟踪各 server 的依赖安装状态：安装中禁用删除（后端也有守卫，UI 同步防呆）
  useEffect(() => {
    const off = window.pocketai.onPythonEnvEvent((evt) => {
      setInstallingIds((prev) => {
        const has = prev.has(evt.serverId)
        const busy = evt.stage === 'venv' || evt.stage === 'pip'
        const finished = evt.stage === 'done' || evt.stage === 'error'
        if ((busy && has) || (finished && !has) || (!busy && !finished)) return prev
        const next = new Set(prev)
        if (busy) next.add(evt.serverId)
        else next.delete(evt.serverId)
        return next
      })
    })
    return off
  }, [])

  const runtimeOf = (id: string): McpServerRuntime | undefined =>
    runtimes.find((r) => r.id === id)

  // 手动试运行：真实调用该工具（等价于 confirm 后执行），结果行内展示
  const handleRunTool = async (serverId: string, toolName: string) => {
    const key = `${serverId}:${toolName}`
    const argsJson = toolRuns[key]?.argsJson ?? ''
    setToolRuns((prev) => ({ ...prev, [key]: { ...prev[key], argsJson, running: true, result: undefined } }))
    const r = await window.pocketai.callMcpServerTool(serverId, toolName, argsJson)
    setToolRuns((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        argsJson,
        running: false,
        result: r.ok ? (r.content ?? '') : (r.error ?? t('common.unknownError')),
        isError: r.ok ? r.isError : true
      }
    }))
  }

  const handleStart = async (id: string) => {
    const r = await window.pocketai.startMcpServer(id)
    if (!r.ok) toast.error(t('agent.startFail', { e: r.error ?? t('common.unknownError') }))
  }
  const handleStop = async (id: string) => {
    await window.pocketai.stopMcpServer(id)
  }
  const handleRestart = async (id: string) => {
    const r = await window.pocketai.restartMcpServer(id)
    if (!r.ok) toast.error(t('agent.restartFail', { e: r.error ?? t('common.unknownError') }))
  }
  const handleDelete = async (id: string) => {
    if (!confirm(t('agent.deleteConfirm'))) return
    const r = await window.pocketai.deleteMcpServer(id)
    // 安装中删除等后端拒绝：提示且不刷新列表（记录仍在）
    if (!r.ok) {
      setNotice(r.error ?? t('common.unknownError'))
      return
    }
    if (r.warning) setNotice(r.warning)
    await load()
  }

  // 导出全部配置为脱敏 JSON（换机/备份；密钥项替换为 REDACTED，导入后需手填）
  const handleExport = async () => {
    try {
      const r = await window.pocketai.exportMcpServers()
      if ('canceled' in r) return
      if (!r.ok) {
        toast.error(r.error || t('common.unknownError'))
        return
      }
      toast.success(t('agent.exportMcpDone', { n: r.count, path: r.path }))
      if (r.redactedCount > 0) toast.warning(t('agent.exportMcpRedacted', { n: r.redactedCount }))
    } catch (e) {
      toast.error(errText(e))
    }
  }

  return (
    <div className="flex gap-4 h-full">
      {/* 左：列表 */}
      <div className="w-72 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">MCP Servers</h3>
          <div className="flex gap-1">
            <button
              onClick={() => setTemplatesOpen(true)}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
            >
              {t('agent.templates')}
            </button>
            <button
              onClick={() => void handleExport()}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
            >
              {t('agent.exportMcp')}
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
            >
              {t('agent.import')}
            </button>
            <button
              onClick={() => setEditing({ name: '', transport: 'stdio', runtime: 'node', command: 'node', args: [], env: {} })}
              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
            >
              {t('agent.add')}
            </button>
          </div>
        </div>
        {/* pip 下载源：全局设置，Python 依赖安装时使用 */}
        <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 space-y-1.5">
          <label className="block text-[11px] font-medium text-[var(--color-text-muted)]">
            {t('agent.f.pipSource')}
          </label>
          <select
            className="select-mini w-full"
            value={pip.pipCustomOpen ? 'custom' : pip.pipSource}
            onChange={(e) => void pip.choosePipSource(e.target.value as PythonPipSource)}
          >
            <option value="official">{t('agent.f.pipOfficial')}</option>
            <option value="tuna">{t('agent.f.pipTuna')}</option>
            <option value="custom">{t('agent.f.pipCustom')}</option>
          </select>
          {pip.pipCustomOpen && (
            <div className="space-y-1">
              <div className="flex gap-1">
                <input
                  className="input font-mono text-[11px] py-1"
                  value={pip.pipCustomUrl}
                  onChange={(e) => pip.setPipCustomUrl(e.target.value)}
                  placeholder={t('agent.f.pipCustomPh')}
                />
                <button className="btn-ghost text-[11px] py-0.5 px-2 shrink-0" onClick={() => void pip.saveCustomPipSource()}>
                  {t('common.save')}
                </button>
              </div>
              {pip.pipCustomError && <p className="text-[10px] text-[var(--color-danger)]">{pip.pipCustomError}</p>}
            </div>
          )}
        </div>
        {notice && (
          <div className="mb-2 text-[11px] text-[var(--color-warning)] bg-[var(--color-warning-bg)] px-2 py-1.5 rounded flex items-start justify-between gap-1">
            <span className="break-all">{notice}</span>
            <button className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setNotice('')}>
              ✕
            </button>
          </div>
        )}
        <div className="space-y-1 overflow-y-auto">
          {records.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('agent.noServers')}
            </p>
          )}
          {records.map((r) => {
            const rt = runtimeOf(r.id)
            const status = rt?.status ?? 'stopped'
            const envInstalling = installingIds.has(r.id)
            return (
              <div
                key={r.id}
                className={`px-3 py-2 rounded text-sm border ${
                  editing?.id === r.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setEditing({ ...r })}
                    className="font-medium truncate text-left"
                  >
                    {r.name}
                  </button>
                  <StatusDot status={status} />
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 truncate">
                  {r.transport === 'http' ? `🌐 ${r.url}` : `${r.command} ${(r.args || []).join(' ')}`}
                </div>
                <div className="flex gap-1 mt-2">
                  {status === 'running' ? (
                    <>
                      <MiniBtn onClick={() => void handleStop(r.id)}>{t('common.stop')}</MiniBtn>
                      <MiniBtn onClick={() => void handleRestart(r.id)}>{t('common.restart')}</MiniBtn>
                    </>
                  ) : status === 'starting' ? (
                    <MiniBtn disabled>{t('common.starting')}</MiniBtn>
                  ) : status === 'error' ? (
                    // error 状态走 restart：start 不会清理残留 client（其 stop 才会 shutdown）
                    <MiniBtn onClick={() => void handleRestart(r.id)}>
                      {t('common.restart')}
                    </MiniBtn>
                  ) : (
                    <MiniBtn
                      onClick={() => void handleStart(r.id)}
                      disabled={envInstalling}
                      title={envInstalling ? t('agent.startWhileInstalling') : undefined}
                    >
                      {t('common.start')}
                    </MiniBtn>
                  )}
                  <MiniBtn onClick={() => setEditing({ ...r })}>{t('common.edit')}</MiniBtn>
                  <MiniBtn
                    danger
                    onClick={() => void handleDelete(r.id)}
                    disabled={envInstalling}
                    title={envInstalling ? t('agent.deleteWhileInstalling') : undefined}
                  >
                    {t('common.delete')}
                  </MiniBtn>
                </div>
                {rt && rt.tools.length > 0 && (
                  <div className="mt-1">
                    <button
                      className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      onClick={() =>
                        setExpandedServers((prev) => ({ ...prev, [r.id]: !prev[r.id] }))
                      }
                    >
                      {expandedServers[r.id] ? '▾' : '▸'} {t('agent.nTools', { n: rt.tools.length })}
                    </button>
                    {expandedServers[r.id] && (
                      <div className="mt-1 space-y-1.5">
                        {rt.tools.map((tool) => {
                          const runKey = `${r.id}:${tool.name}`
                          const run = toolRuns[runKey]
                          return (
                            <div
                              key={tool.name}
                              className="rounded border border-[var(--color-border)] p-1.5"
                            >
                              <div className="flex items-center gap-1">
                                <span className="font-mono text-[10px] truncate" title={tool.name}>
                                  {tool.name}
                                </span>
                                {tool.permission === 'auto' ? (
                                  <span className="shrink-0 text-[9px] px-1 rounded bg-[var(--color-success-bg)] text-[var(--color-success)]">
                                    {t('agent.permAuto')}
                                  </span>
                                ) : (
                                  <span className="shrink-0 text-[9px] px-1 rounded bg-[var(--color-warning-bg)] text-[var(--color-warning)]">
                                    {t('agent.permConfirm')}
                                  </span>
                                )}
                              </div>
                              {tool.description && (
                                <p className="text-[10px] text-[var(--color-text-muted)] line-clamp-2 break-all">
                                  {tool.description}
                                </p>
                              )}
                              <textarea
                                className="input font-mono text-[10px] mt-1 min-h-[36px] py-1"
                                rows={2}
                                spellCheck={false}
                                placeholder={t('agent.toolArgsPh')}
                                value={run?.argsJson ?? ''}
                                onChange={(e) =>
                                  setToolRuns((prev) => ({
                                    ...prev,
                                    [runKey]: { ...prev[runKey], argsJson: e.target.value, running: prev[runKey]?.running ?? false }
                                  }))
                                }
                              />
                              <div className="flex items-center gap-1 mt-1">
                                <MiniBtn
                                  disabled={run?.running || status !== 'running'}
                                  title={t('agent.toolRunHint')}
                                  onClick={() => void handleRunTool(r.id, tool.name)}
                                >
                                  {run?.running ? t('agent.toolRunning') : t('agent.toolRun')}
                                </MiniBtn>
                              </div>
                              {run?.result !== undefined && (
                                <pre
                                  className={`mt-1 max-h-32 overflow-y-auto bg-[var(--color-input-bg)] rounded p-1.5 text-[10px] whitespace-pre-wrap break-all ${
                                    run.isError ? 'text-[var(--color-danger)]' : ''
                                  }`}
                                >
                                  {run.result}
                                </pre>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                {rt?.lastError && (
                  <div className="mt-1 text-[10px] text-[var(--color-danger)] truncate" title={rt.lastError}>
                    {rt.lastError}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 中：编辑表单 */}
      <div className="flex-1 overflow-y-auto">
        {editing ? (
          <McpForm
            key={editing.id ?? 'new'}
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={async (rec) => {
              // 保存后保持在编辑页，便于紧接着安装 Python 依赖并看到实时状态
              setEditing(rec)
              await load()
            }}
          />
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">{t('agent.logTitle')}</h3>
              <button
                onClick={() => setLogs([])}
                className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                {t('agent.clear')}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-[var(--color-input-bg)] rounded p-2 font-mono text-[11px] leading-relaxed">
              {logs.length === 0 ? (
                <p className="text-[var(--color-text-muted)]">{t('agent.noLogs')}</p>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className={l.stream === 'stderr' ? 'text-[var(--color-danger)]' : ''}>
                    <span className="text-[var(--color-text-muted)]">
                      [{new Date(l.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}] [{l.serverId.slice(0, 6)}]
                    </span>{' '}
                    {l.line}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {importOpen && (
        <McpImportModal
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            await load()
          }}
        />
      )}

      {templatesOpen && (
        <McpTemplatesModal
          onClose={() => setTemplatesOpen(false)}
          onCreated={async () => {
            await load()
          }}
        />
      )}
    </div>
  )
}
