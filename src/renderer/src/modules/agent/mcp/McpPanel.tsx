// MCP Server 管理面板：左列表（启停/编辑/删除 + pip 源） / 右编辑表单或日志
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent,
  McpServerLogEvent,
  McpCallLogRecord,
  PythonPipSource
} from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { describeMcpAnnotations } from '../../../../../shared/mcp-annotations'
import { useToast } from '../../../components/ToastProvider'
import { useConfirm } from '../../../components/ConfirmDialog'
import { formatMcpLaunch, mcpSecretKeyHint } from './mcp-launch'
import { logLineTone, logToneClass } from './log-tone'
import { StatusDot, MiniBtn } from '../ui'
import { usePipSource } from './usePipSource'
import { McpForm } from './McpForm'
import { McpImportModal } from './McpImportModal'
import { McpTemplatesModal } from './McpTemplatesModal'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../../../utils/ipc'
import { LoadFailNotice } from '../../../components/LoadFailNotice'
import { ShowingDefaultsNotice } from '../../../components/ShowingDefaultsNotice'
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
  // §333：handleDelete 那颗原生 confirm 收到 askConfirm，与其他五发统一
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm()
  const [records, setRecords] = useState<McpServerRecord[]>([])
  const [runtimes, setRuntimes] = useState<McpServerRuntime[]>([])
  const [editing, setEditing] = useState<Partial<McpServerRecord> | null>(null)
  const [logs, setLogs] = useState<McpServerLogEvent[]>([])
  // 调用记录（落库，跨重启可查）与它的 server 过滤：''=全部
  const [callLogs, setCallLogs] = useState<McpCallLogRecord[]>([])
  const [callLogServer, setCallLogServer] = useState('')
  // §333：调用记录那一读失败时，空列表不许装作「没有记录」⇒ 单独点名
  const [callLogsUnread, setCallLogsUnread] = useState<{ error?: string } | null>(null)
  const [notice, setNotice] = useState('')
  // §259：这两发是裸值列表通道 ⇒ safeHandle 的失败 `{ok:false,error}` 是 truthy，
  // 一旦被当数组写进来，下面 `records.map` 当场 TypeError（探针实测：这一屏一个字都不剩）。
  // 两句分开：清单与运行状态是两发读，各自的失败各自点名（§257 的逐发点名口径）。
  const [serversUnread, setServersUnread] = useState<{ error?: string } | null>(null)
  const [runtimeUnread, setRuntimeUnread] = useState<{ error?: string } | null>(null)
  // 正在安装依赖的 serverId 集合（全局广播跟踪，用于禁用列表卡片上的删除按钮）
  const [installingIds, setInstallingIds] = useState<ReadonlySet<string>>(new Set())
  // 工具列表展开状态（按 serverId）
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({})
  // 工具试运行状态（输入与结果都按工具维度暂存，切换不丢）
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRunState>>({})
  const [importOpen, setImportOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  // §336：调用日志切换 server 时旧请求可能迟到，用代次计数器钉住"只接受最新那一发"
  const callLogGenRef = useRef(0)

  const pip = usePipSource(setNotice, askConfirm)

  const load = useCallback(async () => {
    const [recs, runs] = await Promise.all([
      window.pocketai.listMcpServers(),
      window.pocketai.getMcpRuntimes()
    ])
    // 两发各判各的：清单读到而运行状态没读到，清单照常列出（状态那半单独点名，见 runtimeUnread）
    if (hasIpcFailed(recs) || !Array.isArray(recs)) {
      setServersUnread({ error: hasIpcFailed(recs) ? recs.error : undefined })
    } else {
      setServersUnread(null)
      setRecords(recs)
    }
    if (hasIpcFailed(runs) || !Array.isArray(runs)) {
      setRuntimeUnread({ error: hasIpcFailed(runs) ? runs.error : undefined })
    } else {
      setRuntimeUnread(null)
      setRuntimes(runs)
    }
  }, [])

  useEffect(() => {
    // load 内部无 try-catch，需挂 .catch 避免未处理 rejection；reject 面两半同一句原因
    void load().catch((e: unknown) => {
      const msg = errText(e, '')
      setServersUnread({ error: msg })
      setRuntimeUnread({ error: msg })
      logIpcError('mcp.list', e)
    })
  }, [load])

  const reloadCallLogs = useCallback(async () => {
    const gen = ++callLogGenRef.current
    const r = await window.pocketai.listMcpCallLogs(callLogServer || null)
    // §336：迟到响应不覆盖新请求的结果——代次不匹配说明用户已切换 server，那份数据属于旧选择
    if (gen !== callLogGenRef.current) return
    if (hasIpcFailed(r)) {
      setCallLogsUnread({ error: r.error })
    } else {
      setCallLogsUnread(null)
      setCallLogs(r.logs ?? [])
    }
  }, [callLogServer])

  useEffect(() => {
    void reloadCallLogs().catch(reportIpcError('mcp.callLogList'))
  }, [reloadCallLogs])

  const handleClearCallLogs = async () => {
    const r = await window.pocketai.clearMcpCallLogs(callLogServer || null)
    if (hasIpcFailed(r)) {
      toast.error(ipcFailText(r, t('common.unknownError')))
    } else {
      setCallLogs([])
      toast.success(t('agent.callLogCleared'))
    }
  }

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
          trustReadOnly: base?.trustReadOnly ?? false,
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
    // §336：完成后只更新 running/result 字段，不写回 argsJson——运行期间用户可能已编辑文本框，陈旧值会覆盖用户输入
    setToolRuns((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        argsJson: prev[key]?.argsJson ?? argsJson,
        running: false,
        result: hasIpcFailed(r) ? (r.error ?? t('common.unknownError')) : (r.content ?? ''),
        isError: hasIpcFailed(r) ? true : r.isError
      }
    }))
    // 试运行本身就是一次调用：立刻刷新记录，用户不用点刷新就能看到成败与耗时
    void reloadCallLogs().catch(reportIpcError('mcp.callLogList'))
  }

  // SEC-2：启动前把真正要执行的命令行摊开给用户看（导入/模板创建的记录只有在这里才落地成进程）
  const handleStart = async (id: string) => {
    const rec = records.find((r) => r.id === id) ?? runtimes.find((r) => r.id === id) ?? null
    const launch = formatMcpLaunch(rec)
    const secretKeys = mcpSecretKeyHint(rec)
    const message = secretKeys
      ? `${t('agent.startConfirm', { cmd: launch })}\n\n${t('agent.startConfirmSecrets', { keys: secretKeys })}`
      : t('agent.startConfirm', { cmd: launch })
    if (!(await askConfirm({ title: t('common.start'), message, danger: true }))) return
    const r = await window.pocketai.startMcpServer(id)
    if (!r.ok) toast.error(t('agent.startFail', { e: r.error ?? t('common.unknownError') }))
  }
  const handleStop = async (id: string) => {
    const r = await window.pocketai.stopMcpServer(id)
    // §217：同文件 handleStart/handleRestart 都判了 `!r.ok`，只有停这一条没判 ⇒ 服务没停也报不出原因
    if (hasIpcFailed(r)) toast.error(ipcFailText(r, t('common.unknownError')))
  }
  const handleRestart = async (id: string) => {
    const r = await window.pocketai.restartMcpServer(id)
    if (!r.ok) toast.error(t('agent.restartFail', { e: r.error ?? t('common.unknownError') }))
  }
  const handleDelete = async (id: string) => {
    if (!(await askConfirm({ title: t('common.delete'), message: t('agent.deleteConfirm'), danger: true }))) return
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
          {/* §274：pip 源那一读失败时，这一格停在字面量默认值「官方」⇒ 用 §226 第二形态（有东西但那不是你的设置）。
              键在 alert 盒子外面（§268），那句的 textContent 才是纯句子。 */}
          {pip.pipSourceUnread && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShowingDefaultsNotice what={t('agent.f.pipSource')} msg={pip.pipSourceUnread.error} />
              <button
                data-testid="mcp-pip-source-retry"
                className="btn-ghost text-[11px] py-0.5 px-2 shrink-0"
                onClick={pip.reloadPipSource}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
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
        {/* §259：运行状态那发读不到⇒卡片上的状态点与「启动／停止」按钮摆的是默认值（未启动），要先把这半句说出来 */}
        {runtimeUnread && (
          <div role="alert" className="text-xs mb-2 leading-relaxed text-[var(--color-danger)]">
            {t('agent.runtimeUnread', { msg: ipcFailText(runtimeUnread, t('common.unknownError')) })}
          </div>
        )}
        <div className="space-y-1 overflow-y-auto">
          {/* 清单那发读不到 ⇒ 那句占在「尚未配置」那一格的位置上（空态让位，§254 同一手法）
              §350：补同级重试——这一发的重跑以前只挂在**写流**尾部（新建／保存／导入／删除之后），
              读不到时那些键都在别的屏上；一颗键走的是同一个 `load()`，头顶那句运行状态的"读不到"也一起再读一发 */}
          {serversUnread && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <LoadFailNotice what={t('agent.mcpServersList')} msg={ipcFailText(serversUnread, t('common.unknownError'))} />
              <button
                data-testid="mcp-servers-read-retry"
                className="text-xs underline text-[var(--color-text-muted)]"
                onClick={() => void load()}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
          {!serversUnread && records.length === 0 && (
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
                                {tool.mcpAnnotations && (
                                  <span
                                    data-testid={`mcp-annotations-${tool.name}`}
                                    className="shrink-0 text-[9px] px-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]"
                                    title={t('agent.mcpAnnotationsUntrusted')}
                                  >
                                    {t('agent.mcpAnnotations') +
                                      ': ' +
                                      describeMcpAnnotations(tool.mcpAnnotations)}
                                  </span>
                                )}
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
            {/* 调用记录：进程日志只留在内存 200 行且刷新即清，这张表回答「刚才那次调用成没成、返了什么」 */}
            <div className="mb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <h4 className="text-xs font-semibold text-[var(--color-text)]">{t('agent.callLogTitle')}</h4>
                <select
                  className="ml-auto max-w-[45%] text-[11px] px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] outline-none"
                  value={callLogServer}
                  onChange={(e) => setCallLogServer(e.target.value)}
                >
                  <option value="">{t('agent.callLogAllServers')}</option>
                  {records.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <MiniBtn onClick={() => void reloadCallLogs().catch(reportIpcError('mcp.callLogList'))}>
                  {t('agent.callLogRefresh')}
                </MiniBtn>
                <MiniBtn onClick={() => void handleClearCallLogs().catch(reportIpcError('mcp.callLogClear'))}>
                  {t('agent.clear')}
                </MiniBtn>
              </div>
              {callLogsUnread && (
                <LoadFailNotice
                  what={t('agent.callLogTitle')}
                  msg={ipcFailText(callLogsUnread, t('common.unknownError'))}
                />
              )}
              {!callLogsUnread && (
              <div className="max-h-40 overflow-y-auto bg-[var(--color-input-bg)] rounded p-2 font-mono text-[11px] leading-relaxed">
                {callLogs.length === 0 ? (
                  <p className="text-[var(--color-text-muted)]">{t('agent.callLogEmpty')}</p>
                ) : (
                  callLogs.map((l) => (
                    <div
                      key={l.id}
                      className="truncate"
                      title={[l.argsPreview, l.resultPreview].filter(Boolean).join(' / ')}
                    >
                      <span className="text-[var(--color-text-muted)]">
                        [{new Date(l.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}]
                      </span>{' '}
                      <span className={l.ok ? '' : 'text-[var(--color-danger)]'}>{l.tool}</span>{' '}
                      <span className="text-[var(--color-text-muted)]">
                        {l.ok ? `${l.durationMs}ms` : (l.error ?? t('common.unknownError'))}
                      </span>
                    </div>
                  ))
                )}
              </div>
              )}
            </div>

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
                  <div key={i} className={logToneClass(logLineTone(l.stream, runtimeOf(l.serverId)?.status))}>
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

      {confirmDialog}

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
