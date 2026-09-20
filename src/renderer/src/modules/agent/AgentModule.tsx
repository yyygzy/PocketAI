// Agent 模块：MCP Server 管理 + Work Agent 对话
// 左侧：MCP Server 列表（启停/工具查看/新增/编辑/删除）
// 右侧：Agent 对话面板（ReAct 步骤可视化）
import React, { useEffect, useRef, useState } from 'react'
import type {
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent,
  McpServerLogEvent,
  McpRuntime,
  PythonRuntime,
  PythonEnvState,
  PythonEnvInstallEvent,
  PythonPipSource,
  ProviderRecord,
  AssistantRecord,
  ConversationRecord,
  MessageRecord,
  ChatAttachment,
  AgentStepEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  ToolCall,
  ToolResult,
  ShellConfig,
  WebSearchConfig,
  CalendarConfig,
  ChannelConfig,
  ChannelStatusEvent
} from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { requestSandboxOpenApps } from '../sandbox/SandboxModule'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_TEXT_SIZE = 2 * 1024 * 1024

async function readFileAsAttachment(file: File): Promise<ChatAttachment | null> {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  const isImage = IMAGE_TYPES.includes(file.type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
  const isText = TEXT_TYPES.includes(file.type) || TEXT_EXTS.includes(ext)
  return new Promise((resolve) => {
    if (isImage) {
      if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
      const r = new FileReader()
      r.onload = () => resolve({ type: 'image', name: file.name, mimeType: file.type || 'image/png', size: file.size, data: r.result as string })
      r.onerror = () => resolve(null)
      r.readAsDataURL(file)
    } else if (isText) {
      if (file.size > MAX_TEXT_SIZE) { resolve(null); return }
      const r = new FileReader()
      r.onload = () => resolve({ type: 'text', name: file.name, mimeType: file.type || 'text/plain', size: file.size, data: r.result as string })
      r.onerror = () => resolve(null)
      r.readAsText(file)
    } else { resolve(null) }
  })
}

type Tab = 'agent' | 'servers' | 'channels'

const ARGS_PLACEHOLDER = '["-y","@modelcontextprotocol/server-filesystem","/tmp"]'
const ENV_PLACEHOLDER = '{"API_KEY":"xxx"}'

export const AgentModule: React.FC = () => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('agent')

  return (
    <div className="flex flex-col h-full">
      {/* 子标签：Agent 对话放前面（主功能） */}
      <div className="flex gap-1 mb-3 border-b border-[var(--color-border)]">
        <TabBtn active={tab === 'agent'} onClick={() => setTab('agent')}>
          {t('agent.tabChat')}
        </TabBtn>
        <TabBtn active={tab === 'servers'} onClick={() => setTab('servers')}>
          {t('agent.tabServers')}
        </TabBtn>
        <TabBtn active={tab === 'channels'} onClick={() => setTab('channels')}>
          {t('channel.tab')}
        </TabBtn>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'agent' ? <AgentPanel /> : tab === 'servers' ? <McpPanel /> : <ChannelsPanel />}
      </div>
    </div>
  )
}

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children
}) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
      active
        ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
        : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`}
  >
    {children}
  </button>
)

// ============================== MCP 服务管理 ==============================
const McpPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const [records, setRecords] = useState<McpServerRecord[]>([])
  const [runtimes, setRuntimes] = useState<McpServerRuntime[]>([])
  const [editing, setEditing] = useState<Partial<McpServerRecord> | null>(null)
  const [logs, setLogs] = useState<McpServerLogEvent[]>([])
  const [notice, setNotice] = useState('')

  // pip 下载源（全局设置，影响所有 Python MCP 依赖安装）
  const [pipSource, setPipSourceState] = useState<PythonPipSource>('official')
  const [pipCustomOpen, setPipCustomOpen] = useState(false)
  const [pipCustomUrl, setPipCustomUrl] = useState('')
  const [pipCustomError, setPipCustomError] = useState('')
  // 正在安装依赖的 serverId 集合（全局广播跟踪，用于禁用列表卡片上的删除按钮）
  const [installingIds, setInstallingIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    window.pocketai.getPythonPipSource().then((r) => {
      if (r.ok && r.source) {
        setPipSourceState(r.source)
        if (r.source !== 'official' && r.source !== 'tuna') {
          setPipCustomOpen(true)
          setPipCustomUrl(r.source)
        }
      }
    })
  }, [])

  const choosePipSource = async (next: PythonPipSource) => {
    if (next === 'custom') {
      setPipCustomOpen(true)
      return
    }
    setPipCustomOpen(false)
    setPipCustomError('')
    const r = await window.pocketai.setPythonPipSource(next)
    if (r.ok && r.source) setPipSourceState(r.source)
    else if (r.error) setNotice(r.error)
  }

  const saveCustomPipSource = async () => {
    const url = pipCustomUrl.trim()
    let u: URL | null = null
    try {
      u = new URL(url)
    } catch {
      u = null
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !url) {
      setPipCustomError(t('agent.f.pipCustomInvalid'))
      return
    }
    const r = await window.pocketai.setPythonPipSource(url)
    if (r.ok && r.source) {
      setPipSourceState(r.source)
      setPipCustomError('')
    } else if (r.error) {
      setPipCustomError(r.error)
    }
  }

  const load = async () => {
    const [recs, runs] = await Promise.all([
      window.pocketai.listMcpServers(),
      window.pocketai.getMcpRuntimes()
    ])
    setRecords(recs)
    setRuntimes(runs)
  }

  useEffect(() => {
    load()
  }, [])

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

  return (
    <div className="flex gap-4 h-full">
      {/* 左：列表 */}
      <div className="w-72 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">MCP Servers</h3>
          <button
            onClick={() => setEditing({ name: '', transport: 'stdio', runtime: 'node', command: 'node', args: [], env: {} })}
            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
          >
            {t('agent.add')}
          </button>
        </div>
        {/* pip 下载源：全局设置，Python 依赖安装时使用 */}
        <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 space-y-1.5">
          <label className="block text-[11px] font-medium text-[var(--color-text-muted)]">
            {t('agent.f.pipSource')}
          </label>
          <select
            className="select-mini w-full"
            value={pipCustomOpen ? 'custom' : pipSource}
            onChange={(e) => choosePipSource(e.target.value as PythonPipSource)}
          >
            <option value="official">{t('agent.f.pipOfficial')}</option>
            <option value="tuna">{t('agent.f.pipTuna')}</option>
            <option value="custom">{t('agent.f.pipCustom')}</option>
          </select>
          {pipCustomOpen && (
            <div className="space-y-1">
              <div className="flex gap-1">
                <input
                  className="input font-mono text-[11px] py-1"
                  value={pipCustomUrl}
                  onChange={(e) => setPipCustomUrl(e.target.value)}
                  placeholder={t('agent.f.pipCustomPh')}
                />
                <button className="btn-ghost text-[11px] py-0.5 px-2 shrink-0" onClick={saveCustomPipSource}>
                  {t('common.save')}
                </button>
              </div>
              {pipCustomError && <p className="text-[10px] text-[var(--color-danger)]">{pipCustomError}</p>}
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
                      <MiniBtn onClick={() => handleStop(r.id)}>{t('common.stop')}</MiniBtn>
                      <MiniBtn onClick={() => handleRestart(r.id)}>{t('common.restart')}</MiniBtn>
                    </>
                  ) : status === 'starting' ? (
                    <MiniBtn disabled>{t('common.starting')}</MiniBtn>
                  ) : (
                    <MiniBtn
                      onClick={() => handleStart(r.id)}
                      disabled={envInstalling}
                      title={envInstalling ? t('agent.startWhileInstalling') : undefined}
                    >
                      {t('common.start')}
                    </MiniBtn>
                  )}
                  <MiniBtn onClick={() => setEditing({ ...r })}>{t('common.edit')}</MiniBtn>
                  <MiniBtn
                    danger
                    onClick={() => handleDelete(r.id)}
                    disabled={envInstalling}
                    title={envInstalling ? t('agent.deleteWhileInstalling') : undefined}
                  >
                    {t('common.delete')}
                  </MiniBtn>
                </div>
                {rt && rt.tools.length > 0 && (
                  <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                    {t('agent.nTools', { n: rt.tools.length })}
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
    </div>
  )
}

const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const color =
    status === 'running' ? 'bg-[var(--color-success)]' :
    status === 'starting' ? 'bg-[var(--color-warning)]' :
    status === 'error' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-muted)]'
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />
}

const MiniBtn: React.FC<{
  onClick?: () => void
  children: React.ReactNode
  danger?: boolean
  disabled?: boolean
  title?: string
}> = ({ onClick, children, danger, disabled, title }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`text-[10px] px-1.5 py-0.5 rounded border disabled:opacity-40 disabled:cursor-not-allowed ${
      danger
        ? 'border-[var(--color-danger-bg)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`}
  >
    {children}
  </button>
)

// ---------- MCP 表单 ----------
const McpForm: React.FC<{
  initial: Partial<McpServerRecord>
  onCancel: () => void
  onSaved: (rec: McpServerRecord) => void
}> = ({ initial, onCancel, onSaved }) => {
  const { t } = useI18n()
  const [name, setName] = useState(initial.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial.transport ?? 'stdio')
  const [runtime, setRuntime] = useState<McpRuntime>(initial.runtime ?? 'binary')
  const [command, setCommand] = useState(initial.command ?? 'node')
  const [argsText, setArgsText] = useState(JSON.stringify(initial.args ?? [], null, 2))
  const [envText, setEnvText] = useState(JSON.stringify(initial.env ?? {}, null, 2))
  const [url, setUrl] = useState(initial.url ?? '')
  const [enabled, setEnabled] = useState(initial.enabled !== false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Python 运行时列表（仅 runtime=python 时使用）
  const [pyRuntimes, setPyRuntimes] = useState<PythonRuntime[]>([])
  const [pyLoading, setPyLoading] = useState(false)
  const [pyDownloading, setPyDownloading] = useState(false)

  // Python 依赖（venv 安装向导）
  const [packagesText, setPackagesText] = useState((initial.pythonPackages ?? []).join('\n'))
  const [envState, setEnvState] = useState<PythonEnvState | null>(null)
  const [envEvents, setEnvEvents] = useState<PythonEnvInstallEvent[]>([])
  const [installing, setInstalling] = useState(false)
  const envLogRef = useRef<HTMLDivElement>(null)

  /** 当前输入框里的依赖行（去空行，不去注释——交给后端统一校验） */
  const packageLines = packagesText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  /** 已保存到 DB 的依赖行 */
  const savedPackageLines = initial.pythonPackages ?? []
  const packagesDirty =
    packageLines.join('\n') !== savedPackageLines.join('\n')

  const refreshEnvState = async (serverId: string) => {
    try {
      const r = await window.pocketai.getPythonEnvStatus(serverId)
      if (r.ok && r.state) {
        setEnvState(r.state)
        if (r.recentEvents) setEnvEvents(r.recentEvents)
      } else if (r.error) {
        // 存量脏数据等场景：行内展示后端错误，避免静默停在旧状态
        setError(r.error)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // 已保存的 python server：拉取环境状态 + 回填最近安装日志
  useEffect(() => {
    if (initial.id && (initial.runtime ?? 'binary') === 'python') {
      refreshEnvState(initial.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id, initial.runtime])

  // 订阅该 server 的安装实时事件（广播是全局的，按 id 过滤）
  useEffect(() => {
    if (!initial.id) return
    const off = window.pocketai.onPythonEnvEvent((evt) => {
      if (evt.serverId !== initial.id) return
      if (evt.stage === 'venv' || evt.stage === 'pip') setInstalling(true)
      if (evt.stage === 'done' || evt.stage === 'error') setInstalling(false)
      setEnvEvents((prev) => [...prev.slice(-199), evt])
    })
    return off
  }, [initial.id])

  // 日志自动滚到底
  useEffect(() => {
    envLogRef.current?.scrollTo({ top: envLogRef.current.scrollHeight })
  }, [envEvents])

  const handleInstall = async () => {
    if (!initial.id) {
      setError(t('agent.f.pythonInstallNeedSave'))
      return
    }
    if (packageLines.length === 0) {
      setError(t('agent.f.pythonPackagesEmpty'))
      return
    }
    if (packagesDirty) {
      setError(t('agent.f.pythonInstallSaveFirst'))
      return
    }
    setError('')
    setInstalling(true)
    setEnvEvents((prev) => [
      ...prev,
      { serverId: initial.id!, stage: 'venv', timestamp: Date.now(), message: t('agent.f.pythonInstallStart') }
    ])
    const r = await window.pocketai.installPythonEnv(initial.id)
    setInstalling(false)
    if (r.ok && r.state) {
      setEnvState(r.state)
    } else {
      setError(t('agent.f.pythonInstallFailed', { e: r.error ?? t('common.unknownError') }))
      refreshEnvState(initial.id)
    }
  }

  const loadPyRuntimes = async () => {
    setPyLoading(true)
    try {
      setPyRuntimes(await window.pocketai.listPythonRuntimes())
    } catch {
      setPyRuntimes([])
    } finally {
      setPyLoading(false)
    }
  }

  useEffect(() => {
    if (runtime === 'python') loadPyRuntimes()
  }, [runtime])

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('agent.nameRequired'))
      return
    }
    let args: string[] = []
    let env: Record<string, string> = {}
    try {
      const parsed = JSON.parse(argsText)
      if (Array.isArray(parsed)) args = parsed.map(String)
      else throw new Error(t('agent.argsArray'))
    } catch (e) {
      setError(t('agent.argsFail', { e: (e as Error).message }))
      return
    }
    try {
      const parsed = JSON.parse(envText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        env = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
      } else throw new Error(t('agent.envObject'))
    } catch (e) {
      setError(t('agent.envFail', { e: (e as Error).message }))
      return
    }

    setSaving(true)
    try {
      const saved = await window.pocketai.saveMcpServer({
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        transport,
        runtime: transport === 'stdio' ? runtime : 'binary',
        command: transport === 'stdio' ? command.trim() : null,
        args: transport === 'stdio' ? args : [],
        env: transport === 'stdio' ? env : {},
        url: transport === 'http' ? url.trim() || null : null,
        // 仅 stdio+python 保留依赖列表；repo 层也会兜底归一化
        pythonPackages:
          transport === 'stdio' && runtime === 'python' ? packageLines : [],
        enabled
      } as any)
      onSaved(saved)
      // 已存在的 server 保存后表单不会重挂（key 不变），依赖列表变化时必须主动重查，
      // 否则状态行仍显示旧的 ready，用户看不到 stale 提示
      if (saved.id && saved.runtime === 'python') {
        await refreshEnvState(saved.id)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 max-w-xl">
      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.name')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.transport')}</label>
        <select className="select-mini w-full" value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}>
          <option value="stdio">{t('agent.f.stdio')}</option>
          <option value="http">{t('agent.f.http')}</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.runtime')}</label>
            <select
              className="select-mini w-full"
              value={runtime}
              onChange={(e) => {
                const r = e.target.value as McpRuntime
                setRuntime(r)
                // 切换运行时给一个合理的默认 command
                if (r === 'node') setCommand('node')
                else if (r === 'binary' && !command) setCommand('')
              }}
            >
              <option value="binary">{t('agent.f.runtimeBinary')}</option>
              <option value="node">{t('agent.f.runtimeNode')}</option>
              <option value="python">{t('agent.f.runtimePython')}</option>
            </select>
          </div>

          {runtime === 'python' && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{t('agent.f.pythonRuntimes')}</span>
                <div className="flex gap-1">
                  <button className="btn-ghost text-[11px] py-0.5 px-2" onClick={loadPyRuntimes} disabled={pyLoading}>
                    {pyLoading ? t('common.loading') : t('agent.f.pythonDetect')}
                  </button>
                  <button
                    className="btn-ghost text-[11px] py-0.5 px-2"
                    onClick={async () => {
                      setPyDownloading(true)
                      try {
                        const rt = await window.pocketai.downloadPortablePython()
                        setPyRuntimes((prev) => [rt, ...prev])
                        setCommand(rt.path)
                      } catch (e) {
                        setError(t('agent.f.pythonDownloadFail', { e: (e as Error).message }))
                      } finally {
                        setPyDownloading(false)
                      }
                    }}
                    disabled={pyDownloading}
                  >
                    {pyDownloading ? t('agent.f.pythonDownloading') : t('agent.f.pythonDownload')}
                  </button>
                </div>
              </div>
              {pyRuntimes.length === 0 ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">{t('agent.f.pythonEmpty')}</p>
              ) : (
                <select
                  className="select-mini w-full"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                >
                  <option value="">{t('agent.f.pythonSelect')}</option>
                  {pyRuntimes.map((r) => (
                    <option key={r.path} value={r.path}>
                      {r.name} — {r.path}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {runtime === 'python' && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2">
              <div>
                <label className="block text-xs font-medium mb-1">{t('agent.f.pythonPackages')}</label>
                <textarea
                  className="input font-mono text-xs min-h-[64px]"
                  value={packagesText}
                  onChange={(e) => setPackagesText(e.target.value)}
                  placeholder={t('agent.f.pythonPackagesPh')}
                  spellCheck={false}
                />
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{t('agent.f.pythonPackagesHint')}</p>
              </div>

              {/* 环境状态行 */}
              <div className="flex items-center gap-2 text-[11px] flex-wrap">
                <span className="text-[var(--color-text-muted)]">{t('agent.f.pythonEnvStatus')}</span>
                {(() => {
                  const st = envState?.status
                  const map = {
                    none: { text: t('agent.f.pythonEnvNone'), cls: 'text-[var(--color-text-muted)]' },
                    installing: { text: t('agent.f.pythonEnvInstalling'), cls: 'text-[var(--color-warning)]' },
                    ready: {
                      text: t('agent.f.pythonEnvReady', {
                        version: envState?.pythonVersion || '?',
                        n: envState?.installedPackages.length ?? 0
                      }),
                      cls: 'text-[var(--color-success)]'
                    },
                    stale: { text: t('agent.f.pythonEnvStale'), cls: 'text-[var(--color-danger)]' }
                  } as const
                  const cur = (st ?? 'none') as keyof typeof map
                  return <span className={`font-medium ${map[cur].cls}`}>● {map[cur].text}</span>
                })()}
              </div>

              {packagesDirty && initial.id && (
                <p className="text-[11px] text-[var(--color-warning)]">{t('agent.f.pythonInstallSaveFirst')}</p>
              )}

              <div>
                <button
                  className="btn-ghost text-[11px] py-1 px-2"
                  onClick={handleInstall}
                  disabled={
                    installing ||
                    envState?.status === 'installing' ||
                    !initial.id ||
                    packageLines.length === 0 ||
                    packagesDirty
                  }
                  title={!initial.id ? t('agent.f.pythonInstallNeedSave') : undefined}
                >
                  {installing
                    ? t('agent.f.pythonInstalling')
                    : envState?.status === 'ready' || envState?.status === 'stale'
                      ? t('agent.f.pythonReinstall')
                      : t('agent.f.pythonInstall')}
                </button>
                {!initial.id && (
                  <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">
                    {t('agent.f.pythonInstallNeedSave')}
                  </span>
                )}
              </div>

              {envEvents.length > 0 && (
                <div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mb-1">
                    {t('agent.f.pythonEnvLogTitle')}
                  </div>
                  <div
                    ref={envLogRef}
                    className="max-h-40 overflow-y-auto bg-[var(--color-input-bg)] rounded p-2 font-mono text-[10px] leading-relaxed space-y-0.5"
                  >
                    {envEvents.map((ev, i) => {
                      const stageText =
                        ev.stage === 'venv'
                          ? t('agent.f.pythonStageVenv')
                          : ev.stage === 'pip'
                            ? t('agent.f.pythonStagePip')
                            : ev.stage === 'done'
                              ? t('agent.f.pythonStageDone')
                              : t('agent.f.pythonStageError')
                      const line = ev.line ?? ev.message ?? ''
                      return (
                        <div
                          key={i}
                          className={
                            ev.stage === 'error'
                              ? 'text-[var(--color-danger)]'
                              : ev.stage === 'done'
                                ? 'text-[var(--color-success)]'
                                : ''
                          }
                        >
                          <span className="text-[var(--color-text-muted)]">[{stageText}]</span>{' '}
                          {line}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.command')}</label>
            <input className="input font-mono text-xs" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('agent.f.commandPh')} />
            {runtime === 'python' && (
              <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{t('agent.f.pythonCommandHint')}</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.args')}</label>
            <textarea
              className="input font-mono text-xs min-h-[80px]"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={ARGS_PLACEHOLDER}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.env')}</label>
            <textarea
              className="input font-mono text-xs min-h-[80px]"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={ENV_PLACEHOLDER}
            />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">URL</label>
          <input className="input font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
          <p className="text-[11px] text-[var(--color-warning)] mt-1">{t('agent.f.httpWarn')}</p>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('common.enable')}
      </label>
      {error && <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 rounded">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

// ============================== Agent 对话 ==============================
interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  reasoning?: string
  toolCall?: ToolCall
  toolResult?: ToolResult
  stepIndex?: number
  isFinal?: boolean
  isError?: boolean
  attachments?: ChatAttachment[]
}

const AgentPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [assistantId, setAssistantId] = useState<string>('')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [shellConfig, setShellConfigState] = useState<ShellConfig>({ enabled: false, policy: 'confirm' })
  /** 本地日历（calendar.read）配置 */
  const [calConfig, setCalConfigState] = useState<CalendarConfig>({ enabled: false, paths: [] })
  const [wsConfig, setWsConfigState] = useState<WebSearchConfig>({
    enabled: false,
    provider: 'tavily',
    apiKey: '',
    hasKey: false
  })
  /** 联网搜索 Key 输入框（不回显已存 Key，仅新输入时生效） */
  const [wsKeyDraft, setWsKeyDraft] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const requestIdRef = useRef<string>('')
  const stepBufRef = useRef<Map<string, { msg: AgentMessage; text: string }>>(new Map())

  useEffect(() => {
    Promise.all([window.pocketai.listProviders(), window.pocketai.listAssistants()]).then(([ps, as_]) => {
      setProviders(ps.filter((p) => p.enabled))
      setAssistants(as_)
    })
    window.pocketai.getAgentWorkspaceDir().then(setWorkspaceDir)
    window.pocketai.getShellConfig().then(setShellConfigState)
    window.pocketai.getWebSearchConfig().then(setWsConfigState)
    window.pocketai.getCalendarConfig().then(setCalConfigState)
  }, [])

  useEffect(() => {
    if (!assistantId) return
    window.pocketai.listConversations(assistantId, true).then((list) => {
      setConversations(list)
      // 自动选中最近一次使用的 Agent 会话（列表已按 updated_at DESC 排序）
      if (list.length > 0) {
        setConversationId(list[0].id)
      } else {
        setConversationId(null)
      }
    })
  }, [assistantId])

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      return
    }
    window.pocketai.listMessages(conversationId).then((dbMsgs: MessageRecord[]) => {
      const out: AgentMessage[] = []
      for (const m of dbMsgs) {
        if (m.role === 'user') {
          out.push({ id: m.id, role: 'user', text: m.content, attachments: m.attachments })
        } else if (m.role === 'assistant') {
          out.push({ id: m.id, role: 'assistant', text: m.content, isFinal: m.status === 'done' })
        } else if (m.role === 'tool') {
          try {
            const tr = JSON.parse(m.content) as ToolResult
            // 若有调用参数，先显示 tool_call 步骤，再显示 tool_result
            if (tr.arguments) {
              out.push({
                id: `${m.id}-call`,
                role: 'tool',
                text: '',
                toolCall: {
                  id: tr.toolCallId,
                  type: 'function',
                  function: { name: tr.name, arguments: tr.arguments }
                }
              })
            }
            out.push({
              id: m.id,
              role: 'tool',
              text: tr.content,
              toolResult: tr,
              isError: tr.isError
            })
          } catch {
            out.push({ id: m.id, role: 'tool', text: m.content })
          }
        }
      }
      setMessages(out)
    })
  }, [conversationId])

  // 订阅 Agent 事件
  useEffect(() => {
    const offs: Array<() => void> = []
    offs.push(
      window.pocketai.onAgentStep((e: AgentStepEvent) => {
        if (e.requestId !== requestIdRef.current) return
        setMessages((prev) => {
          const next = [...prev]
          if (e.type === 'thought' || e.type === 'final') {
            // 推入一个 assistant 消息占位（thought 文本会通过 chunk 增量更新）
            const existing = next.find((m) => m.id === e.messageId)
            if (existing) {
              existing.isFinal = e.type === 'final' || existing.isFinal
            } else if (e.messageId) {
              next.push({
                id: e.messageId,
                role: 'assistant',
                text: e.text ?? '',
                stepIndex: e.stepIndex,
                isFinal: e.type === 'final'
              })
              stepBufRef.current.set(e.messageId!, {
                msg: next[next.length - 1],
                text: e.text ?? ''
              })
            }
          } else if (e.type === 'tool_call') {
            next.push({
              id: `step-${e.stepIndex}-call-${e.toolCall?.id}`,
              role: 'tool',
              text: '',
              toolCall: e.toolCall,
              stepIndex: e.stepIndex
            })
          } else if (e.type === 'tool_result') {
            next.push({
              id: `step-${e.stepIndex}-res-${e.toolResult?.toolCallId}`,
              role: 'tool',
              text: e.toolResult?.content ?? '',
              toolResult: e.toolResult,
              isError: e.toolResult?.isError,
              stepIndex: e.stepIndex
            })
          } else if (e.type === 'error') {
            next.push({
              id: `step-${e.stepIndex}-err`,
              role: 'assistant',
              text: `⚠️ ${e.error ?? t('agent.unknownError')}`,
              isError: true,
              stepIndex: e.stepIndex
            })
          }
          return next
        })
      })
    )
    offs.push(
      window.pocketai.onAgentChunk((e: { messageId: string; delta: string; reasoning?: boolean }) => {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === e.messageId)
          if (idx === -1) return prev
          const next = [...prev]
          if (e.reasoning) {
            next[idx] = { ...next[idx], reasoning: (next[idx].reasoning ?? '') + e.delta }
          } else {
            next[idx] = { ...next[idx], text: (next[idx].text ?? '') + e.delta }
          }
          return next
        })
      })
    )
    offs.push(
      window.pocketai.onAgentDone((_e: AgentDoneEvent) => {
        setRunning(false)
      })
    )
    offs.push(
      window.pocketai.onAgentError((_e: AgentErrorEvent) => {
        setRunning(false)
      })
    )
    return () => offs.forEach((off) => off())
  }, [t])

  const selectedProvider = providers.find((p) => p.id === providerId)

  const handleNewConversation = async () => {
    if (!assistantId) return
    const c = await window.pocketai.createConversation(assistantId)
    setConversations((prev) => [c, ...prev])
    setConversationId(c.id)
  }

  // 删除历史会话（与对话页行为一致：无二次确认）
  const handleDeleteConversation = async (id: string) => {
    await window.pocketai.deleteConversation(id)
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (conversationId === id) setConversationId(null)
  }

  // 点击历史会话 → 自动回填该会话最后使用的 Provider/模型
  const handleSelectConversation = (id: string) => {
    setConversationId(id)
    const c = conversations.find((x) => x.id === id)
    if (c?.modelLabel) {
      // 格式："providerId:model" / 多目标 "pid1:m1 | pid2:m2" / Agent "agent:pid:model"
      const first = c.modelLabel.split('|')[0]?.trim() ?? ''
      const rest = first.startsWith('agent:') ? first.slice(6) : first
      const i = rest.indexOf(':')
      if (i > 0) {
        const pid = rest.slice(0, i)
        const mdl = rest.slice(i + 1)
        const p = providers.find((x) => x.id === pid)
        if (p) {
          setProviderId(pid)
          setModel(p.models.includes(mdl) ? mdl : '')
          return
        }
      }
    }
    // 回退：取最后一条 assistant 消息的 provider/model
    window.pocketai.listMessages(id).then((msgs) => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'assistant' && m.provider && m.model) {
          const p = providers.find((x) => x.id === m.provider)
          if (p) {
            setProviderId(m.provider)
            setModel(p.models.includes(m.model) ? m.model : '')
          }
          break
        }
      }
    })
  }

  const handleSend = async () => {
    if (!input.trim() || !providerId || !model || !conversationId) return
    if (running) return
    const requestId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    requestIdRef.current = requestId

    // 立即插入用户消息到 UI
    const userText = input.trim()
    setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: 'user', text: userText, attachments: [...attachments] }])
    setInput('')
    setAttachments([])
    setRunning(true)

    await window.pocketai.sendMessage({
      requestId,
      conversationId,
      assistantId: assistantId || null,
      content: userText,
      targets: [{ providerId, model }],
      agentMode: true,
      attachments: attachments.length > 0 ? attachments : undefined
    })
  }

  const handleAbort = () => {
    if (requestIdRef.current) window.pocketai.abortAgent(requestIdRef.current)
    setRunning(false)
  }

  const handlePickWorkspace = async () => {
    const dir = await window.pocketai.pickAgentWorkspaceDir()
    setWorkspaceDir(dir)
  }

  /** 终端策略变更：立即持久化，以后端回写为准（含值域兜底） */
  const patchShellConfig = async (patch: Partial<ShellConfig>) => {
    const next = await window.pocketai.setShellConfig(patch)
    setShellConfigState(next)
  }

  /** 联网搜索配置变更：立即持久化；Key 输入框提交后清空草稿（明文不回显） */
  const patchWsConfig = async (
    patch: Partial<Pick<WebSearchConfig, 'enabled' | 'provider' | 'apiKey'>>
  ) => {
    // 超长预检：避免主进程拒绝后草稿被误清（后端仍有同样校验，双保险）
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 256) {
      toast.error(t('agent.websearch.keyTooLong'))
      return
    }
    try {
      const next = await window.pocketai.setWebSearchConfig(patch)
      setWsConfigState(next)
      if (patch.apiKey !== undefined) setWsKeyDraft('')
    } catch (e) {
      toast.error((e as Error).message || t('common.unknownError'))
    }
  }

  /** 日历配置变更：立即持久化 */
  const patchCalConfig = async (patch: Partial<Pick<CalendarConfig, 'enabled' | 'paths'>>) => {
    try {
      setCalConfigState(await window.pocketai.setCalendarConfig(patch))
    } catch (e) {
      toast.error((e as Error).message || t('common.unknownError'))
    }
  }

  /** 添加 .ics 日历文件（文件选择对话框） */
  const handleAddIcs = async () => {
    try {
      const res = await window.pocketai.pickIcsFile()
      if (res.canceled || !res.path) return
      if (calConfig.paths.includes(res.path)) return
      await patchCalConfig({ paths: [...calConfig.paths, res.path], enabled: true })
    } catch (e) {
      toast.error((e as Error).message || t('common.unknownError'))
    }
  }

  const handleFetchModels = async () => {
    if (!providerId || fetchingModels) return
    setFetchingModels(true)
    try {
      const models = await window.pocketai.fetchModels(providerId)
      setProviders((prev) => prev.map((p) => (p.id === providerId ? { ...p, models } : p)))
    } catch {
      // 拉取失败不阻断（Provider 配置问题在设置页有完整报错）
    } finally {
      setFetchingModels(false)
    }
  }

  return (
    <div className="flex gap-3 h-full">
      {/* 左：会话区（助手选择 + 新会话 + 历史会话） */}
      <div className="w-60 shrink-0 flex flex-col bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg p-2">
        <div className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5 px-0.5">
          {t('agent.sectionAssistant')}
        </div>
        <select
          className="select-mini w-full mb-2"
          value={assistantId}
          onChange={(e) => setAssistantId(e.target.value)}
        >
          <option value="">{t('agent.selectAssistant')}</option>
          {assistants.map((a) => (
            <option key={a.id} value={a.id}>{a.avatar} {a.name}</option>
          ))}
        </select>
        <button
          onClick={handleNewConversation}
          disabled={!assistantId}
          className="text-xs px-2 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40 mb-2"
        >
          {t('agent.newSession')}
        </button>
        <div className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5 px-0.5">
          {t('agent.sectionSessions')}
        </div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {conversations.length === 0 && (
            <p className="text-[11px] text-[var(--color-text-muted)] px-0.5">{t('agent.noSessions')}</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded text-xs ${
                conversationId === c.id
                  ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-hover-overlay)]'
              }`}
            >
              <button
                onClick={() => handleSelectConversation(c.id)}
                className="flex-1 min-w-0 text-left px-2 py-1.5"
              >
                <div className="truncate">{c.title || t('agent.defaultConvTitle')}</div>
              </button>
              <button
                onClick={() => handleDeleteConversation(c.id)}
                className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 mr-1 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                title={t('chat.delete')}
              >×</button>
            </div>
          ))}
        </div>
      </div>

      {/* 右：对话区 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 模型配置栏 */}
        <div className="flex items-center gap-2 mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
          <span className="text-xs font-semibold text-[var(--color-text-muted)] shrink-0">
            {t('agent.modelConfig')}
          </span>
          <select
            className="select-mini flex-1 min-w-0"
            value={providerId}
            onChange={(e) => { setProviderId(e.target.value); setModel('') }}
          >
            <option value="">{t('agent.selectProvider')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {selectedProvider && selectedProvider.models.length > 0 ? (
            <select
              className="select-mini flex-1 min-w-0"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{t('agent.selectModel')}</option>
              {selectedProvider.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : selectedProvider ? (
            <>
              <span className="text-xs text-[var(--color-text-muted)] flex-1 min-w-0 truncate">
                {t('agent.noModelsHint')}
              </span>
              <button
                className="btn-ghost text-xs shrink-0"
                disabled={fetchingModels}
                onClick={handleFetchModels}
              >
                {fetchingModels ? t('agent.fetching') : t('agent.fetchModels')}
              </button>
            </>
          ) : null}
          <button
            className="btn-ghost text-xs shrink-0 max-w-[180px]"
            onClick={handlePickWorkspace}
            title={workspaceDir || t('agent.workspacePickTip')}
          >
            <span className="block truncate">
              📁 {workspaceDir
                ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir
                : t('agent.workspaceNone')}
            </span>
          </button>
        </div>

        {/* 终端命令（shell_exec）策略：未设置工作目录时整体置灰 */}
        <div
          className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs ${
            workspaceDir ? '' : 'opacity-40 pointer-events-none'
          }`}
          title={workspaceDir ? undefined : t('agent.shell.needWorkspace')}
        >
          <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
            <input
              type="checkbox"
              checked={shellConfig.enabled}
              onChange={(e) => void patchShellConfig({ enabled: e.target.checked })}
            />
            🖥 {t('agent.shell.enable')}
          </label>
          <label className="flex items-center gap-1 select-none">
            <span className="text-[var(--color-text-muted)]">{t('agent.shell.policy')}</span>
            <select
              className="select-mini"
              value={shellConfig.policy}
              disabled={!shellConfig.enabled}
              onChange={(e) =>
                void patchShellConfig({ policy: e.target.value as ShellConfig['policy'] })
              }
            >
              <option value="confirm">{t('agent.shell.policyConfirm')}</option>
              <option value="auto-safe">{t('agent.shell.policyAutoSafe')}</option>
            </select>
          </label>
          <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate">
            {shellConfig.enabled ? t('agent.shell.hintOn') : t('agent.shell.hintOff')}
          </span>
        </div>

        {/* 联网搜索（web.search）配置：Key 明文仅存主进程，渲染端不回显 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
            <input
              type="checkbox"
              checked={wsConfig.enabled}
              onChange={(e) => void patchWsConfig({ enabled: e.target.checked })}
            />
            🌐 {t('agent.websearch.title')}
          </label>
          <label className="flex items-center gap-1 select-none">
            <span className="text-[var(--color-text-muted)]">{t('agent.websearch.provider')}</span>
            <select
              className="select-mini"
              value={wsConfig.provider}
              disabled={!wsConfig.enabled}
              onChange={(e) =>
                void patchWsConfig({ provider: e.target.value as WebSearchConfig['provider'] })
              }
            >
              <option value="tavily">Tavily</option>
              <option value="bocha">{t('agent.websearch.providerBocha')}</option>
            </select>
          </label>
          <label className="flex items-center gap-1 select-none min-w-0">
            <span className="text-[var(--color-text-muted)]">API Key</span>
            <input
              type="password"
              className="input-mini w-40"
              value={wsKeyDraft}
              disabled={!wsConfig.enabled}
              placeholder={
                wsConfig.hasKey ? t('agent.websearch.keySaved') : t('agent.websearch.keyPlaceholder')
              }
              onChange={(e) => setWsKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && wsKeyDraft.trim()) {
                  void patchWsConfig({ apiKey: wsKeyDraft.trim() })
                }
              }}
              onBlur={() => {
                if (wsKeyDraft.trim()) void patchWsConfig({ apiKey: wsKeyDraft.trim() })
              }}
            />
            {wsConfig.hasKey && (
              <button
                className="btn-ghost text-[11px] shrink-0"
                title={t('agent.websearch.keyClearTip')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void patchWsConfig({ apiKey: '' })}
              >
                {t('agent.websearch.keyClear')}
              </button>
            )}
          </label>
          <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate">
            {wsConfig.enabled ? t('agent.websearch.hintOn') : t('agent.websearch.hintOff')}
          </span>
        </div>

        {/* 本地日历（calendar.read）配置：添加 .ics 文件后 Agent 可读取日程 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
            <input
              type="checkbox"
              checked={calConfig.enabled}
              onChange={(e) => void patchCalConfig({ enabled: e.target.checked })}
            />
            📅 {t('agent.calendar.title')}
          </label>
          <button
            className="btn-ghost text-[11px] shrink-0"
            onClick={() => void handleAddIcs()}
            title={t('agent.calendar.addTip')}
          >
            + {t('agent.calendar.add')}
          </button>
          {calConfig.paths.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded bg-[var(--color-hover-overlay)] px-1.5 py-0.5 max-w-[220px]"
              title={p}
            >
              <span className="truncate">{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
              <button
                className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                title={t('agent.calendar.removeTip')}
                onClick={() => void patchCalConfig({ paths: calConfig.paths.filter((x) => x !== p) })}
              >
                ×
              </button>
            </span>
          ))}
          <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate">
            {calConfig.enabled
              ? calConfig.paths.length > 0
                ? t('agent.calendar.hintOn')
                : t('agent.calendar.hintNoFile')
              : t('agent.calendar.hintOff')}
          </span>
        </div>

        {/* 消息流 */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {messages.length === 0 && (
            <div className="text-xs text-[var(--color-text-muted)] h-full flex items-center justify-center">
              {t('agent.emptyHint')}
            </div>
          )}
          {messages.map((m) => (
            <MessageCard key={m.id} m={m} />
          ))}
        </div>

        {/* 附件预览 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-2">
            {attachments.map((att, i) => (
              <div key={i} className="relative group flex items-center gap-1.5 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg pl-1.5 pr-7 py-1 text-xs">
                {att.type === 'image' ? (
                  <img src={att.data} alt={att.name} className="w-6 h-6 rounded object-cover" />
                ) : (
                  <span>📄</span>
                )}
                <span className="max-w-[120px] truncate text-[var(--color-text)]">{att.name}</span>
                <button
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* 输入 */}
        <div
          className={`flex gap-2 pt-2 border-t border-[var(--color-border)] mt-2 rounded-b-xl ${
            dragOver ? 'ring-2 ring-[var(--color-accent)]' : ''
          }`}
          onDrop={async (e) => {
            e.preventDefault()
            setDragOver(false)
            if (e.dataTransfer.files) {
              const results = await Promise.all(Array.from(e.dataTransfer.files).map(readFileAsAttachment))
              const valid = results.filter((r): r is ChatAttachment => r !== null)
              if (valid.length > 0) setAttachments((prev) => [...prev, ...valid].slice(0, 8))
            }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.html,.xml,.py,.js,.ts,.tsx,.jsx,.yaml,.yml,.sh,.sql,.log"
            className="hidden"
            onChange={async (e) => {
              if (e.target.files) {
                const results = await Promise.all(Array.from(e.target.files).map(readFileAsAttachment))
                const valid = results.filter((r): r is ChatAttachment => r !== null)
                if (valid.length > 0) setAttachments((prev) => [...prev, ...valid].slice(0, 8))
              }
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            title="添加图片或文档"
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            className="input flex-1 text-sm min-h-[40px] max-h-[120px] resize-none"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={t('agent.inputPh')}
            disabled={running}
          />
          {running ? (
            <button className="btn-ghost" onClick={handleAbort}>{t('common.stop')}</button>
          ) : (
            <button
              className="btn-primary"
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || !providerId || !model || !conversationId}
            >
              {t('common.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 提取消息文本中第一个 ```html 代码块（供「在沙箱运行」按钮使用） */
function extractFirstHtmlBlock(text: string): string | null {
  const m = text.match(/```html\s*\r?\n([\s\S]*?)```/i)
  return m ? m[1] : null
}

const MessageCard: React.FC<{ m: AgentMessage }> = ({ m }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [copied, setCopied] = React.useState(false)
  const [savedToSandbox, setSavedToSandbox] = React.useState(false)
  const [showReasoning, setShowReasoning] = React.useState(false)
  const [installingApp, setInstallingApp] = React.useState(false)
  // 安装请求进行中（防连点重复创建同名应用）
  const [installBusy, setInstallBusy] = React.useState(false)
  const [appName, setAppName] = React.useState('')
  const [appIcon, setAppIcon] = React.useState('📦')
  const [appDesc, setAppDesc] = React.useState('')

  const handleCopy = async (text: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
  }

  const CopyBtn = ({ text }: { text: string }) => (
    <button
      onClick={() => handleCopy(text)}
      className="text-[10px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
    >
      {copied ? '已复制' : '复制'}
    </button>
  )

  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-[var(--color-accent-soft)] px-3 py-2 rounded-lg max-w-[80%] text-sm select-text">
          {m.text}
          {/* 附件渲染 */}
          {m.attachments && m.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5 justify-end">
              {m.attachments.map((att, i) => (
                att.type === 'image' ? (
                  <img key={i} src={att.data} alt={att.name} className="w-16 h-16 object-cover rounded border border-[var(--color-border)]" />
                ) : (
                  <span key={i} className="text-[11px] bg-white/10 px-1.5 py-0.5 rounded">📄 {att.name}</span>
                )
              ))}
            </div>
          )}
          <div className="flex justify-end mt-1">
            <CopyBtn text={m.text} />
          </div>
        </div>
      </div>
    )
  }
  if (m.role === 'tool' && m.toolCall) {
    return (
      <div className="text-xs px-3 py-2 rounded border border-[var(--color-info-bg)] bg-[var(--color-info-bg)]">
        <div className="text-[var(--color-info)] font-mono">{t('agent.callTool', { name: m.toolCall.function.name })}</div>
        <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap break-all">
          {m.toolCall.function.arguments}
        </pre>
        <div className="flex justify-end mt-1">
          <CopyBtn text={m.toolCall.function.arguments} />
        </div>
      </div>
    )
  }
  if (m.role === 'tool' && m.toolResult) {
    return (
      <div className={`text-xs px-3 py-2 rounded border ${m.isError ? 'border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)]' : 'border-[var(--color-success-bg)] bg-[var(--color-success-bg)]'}`}>
        <div className={`font-mono ${m.isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>
          {m.isError ? t('agent.toolError') : t('agent.toolResult')}: {m.toolResult.name}
        </div>
        <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
          {m.toolResult.content}
        </pre>
        <div className="flex justify-end mt-1">
          <CopyBtn text={m.toolResult.content} />
        </div>
      </div>
    )
  }
  // assistant
  return (
    <div className={`px-3 py-2 rounded-lg text-sm select-text ${m.isFinal ? 'bg-[var(--color-hover-overlay)]' : 'bg-[var(--color-input-bg)]'}`}>
      {/* 思考过程（可折叠） */}
      {m.reasoning && m.reasoning.trim() && (
        <div className="mb-2">
          <button
            onClick={() => setShowReasoning((v) => !v)}
            className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] flex items-center gap-1"
          >
            <span>{showReasoning ? '▼' : '▶'}</span>
            <span>{t('agent.thinking')}（{m.reasoning.length} 字）</span>
          </button>
          {showReasoning && (
            <div className="mt-1 px-2 py-1.5 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap max-h-60 overflow-y-auto">
              {m.reasoning}
            </div>
          )}
        </div>
      )}
      {m.isFinal && <div className="text-[10px] text-[var(--color-accent)] mb-1">{t('agent.finalAnswer')}</div>}
      <div className={`whitespace-pre-wrap ${m.isError ? 'text-[var(--color-danger)]' : ''}`}>{m.text || (m.isFinal ? '' : t('agent.thinking'))}</div>
      {m.isFinal && m.text && (() => {
        const htmlBlock = extractFirstHtmlBlock(m.text)
        if (!htmlBlock) return null
        const saveToSandbox = async () => {
          try {
            await window.pocketai.createSandboxFile(t('sandbox.agentDefaultName'), htmlBlock)
            setSavedToSandbox(true)
          } catch (err) {
            toast.error((err as Error).message)
          }
        }
        const openInstall = () => {
          setAppName(t('sandbox.agentDefaultName'))
          setAppIcon('📦')
          setAppDesc('')
          setInstallingApp(true)
        }
        const installAsApp = async () => {
          if (installBusy) return
          setInstallBusy(true)
          try {
            await window.pocketai.createSandboxFile(appName, htmlBlock, {
              icon: appIcon,
              description: appDesc,
              isApp: true
            })
            setInstallingApp(false)
            setSavedToSandbox(true)
            // 跳转沙箱模块并直接落到应用库视图
            requestSandboxOpenApps()
            window.dispatchEvent(
              new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'sandbox' } })
            )
          } catch (err) {
            toast.error((err as Error).message)
          } finally {
            setInstallBusy(false)
          }
        }
        return (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              className="btn-ghost text-[11px]"
              disabled={savedToSandbox}
              onClick={() => void saveToSandbox()}
              title={t('sandbox.runInSandboxTip')}
            >
              {savedToSandbox ? `✓ ${t('sandbox.savedToSandbox')}` : `▶ ${t('sandbox.runInSandbox')}`}
            </button>
            <button
              className="btn-ghost text-[11px]"
              disabled={savedToSandbox}
              onClick={openInstall}
              title={t('miniapp.installTip')}
            >
              📦 {t('miniapp.install')}
            </button>

            {installingApp && (
              <div className="w-full mt-1 p-2 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <input
                    className="input-mini w-10 text-center"
                    value={appIcon}
                    maxLength={4}
                    onChange={(e) => setAppIcon(e.target.value)}
                  />
                  <input
                    className="input-mini flex-1"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    placeholder={t('sandbox.namePlaceholder')}
                  />
                </div>
                <textarea
                  className="input-mini w-full h-12 resize-none text-[11px]"
                  placeholder={t('miniapp.descPlaceholder')}
                  value={appDesc}
                  onChange={(e) => setAppDesc(e.target.value)}
                />
                <div className="flex justify-end gap-1">
                  <button className="btn-ghost text-[11px]" onClick={() => setInstallingApp(false)}>
                    {t('common.cancel')}
                  </button>
                  <button
                    className="text-[11px] px-2 py-0.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-50"
                    disabled={installBusy}
                    onClick={() => void installAsApp()}
                  >
                    {installBusy ? t('common.saving') : t('miniapp.installConfirm')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })()}
      {m.text && (
        <div className="flex justify-end mt-1">
          <CopyBtn text={m.text} />
        </div>
      )}
    </div>
  )
}

// ============================== Channels（IM Bot 网关） ==============================
// Telegram Bot：远程 IM 用户（白名单内）与本机助手/Agent 对话
// Token 明文仅存主进程，渲染端只拿 hasToken 标记（不回显）
const ChannelsPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const [cfg, setCfgState] = useState<ChannelConfig>({
    enabled: false,
    token: '',
    hasToken: false,
    whitelist: '',
    assistantId: '',
    providerId: '',
    model: '',
    agentMode: false
  })
  const [tokenDraft, setTokenDraft] = useState('')
  const [status, setStatus] = useState<ChannelStatusEvent>({ status: 'stopped', lastError: null })
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])

  useEffect(() => {
    window.pocketai.getChannelConfig().then(setCfgState)
    window.pocketai.listProviders().then((ps) => setProviders(ps.filter((p) => p.enabled)))
    window.pocketai.listAssistants().then(setAssistants)
    return window.pocketai.onChannelStatus((evt) => setStatus(evt))
  }, [])

  const patchCfg = async (
    patch: Partial<Omit<ChannelConfig, 'token' | 'hasToken'>> & { token?: string }
  ) => {
    // Token 超长预检（后端仍有同样校验）；失败保留草稿便于修改
    if (typeof patch.token === 'string' && patch.token.trim().length > 256) {
      toast.error(t('channel.tokenTooLong'))
      return
    }
    try {
      const next = await window.pocketai.setChannelConfig(patch)
      setCfgState(next)
      if (patch.token !== undefined) setTokenDraft('')
    } catch (e) {
      toast.error((e as Error).message || t('common.unknownError'))
    }
  }

  const handleStart = async () => {
    const r = await window.pocketai.startChannel()
    if (!r.ok) toast.error(r.error ?? t('common.unknownError'))
  }
  const handleStop = async () => {
    await window.pocketai.stopChannel()
  }

  const gatewayActive = status.status === 'running' || status.status === 'starting'
  const selectedProvider = providers.find((p) => p.id === cfg.providerId)

  return (
    <div className="h-full overflow-y-auto pr-1 max-w-2xl space-y-3">
      {/* 说明 */}
      <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
        {t('channel.desc')}
      </p>

      {/* 运行状态 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs">
        <StatusDot status={status.status} />
        <span className="font-medium">{t(`channel.status.${status.status}`)}</span>
        {status.lastError && (
          <span className="text-[var(--color-danger)] truncate max-w-[320px]" title={status.lastError}>
            {status.lastError}
          </span>
        )}
        <span className="flex-1" />
        {gatewayActive ? (
          <MiniBtn onClick={handleStop}>{t('channel.stop')}</MiniBtn>
        ) : (
          <button
            className="btn-ghost text-xs"
            disabled={status.status === 'starting'}
            onClick={handleStart}
          >
            {t('channel.start')}
          </button>
        )}
      </div>

      {/* 启用开关 */}
      <label className="flex items-center gap-1.5 cursor-pointer select-none text-sm font-medium">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => void patchCfg({ enabled: e.target.checked })}
        />
        {t('channel.enable')}
      </label>

      {/* Bot Token（不回显） */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.token')}</div>
        <div className="flex items-center gap-1.5">
          <input
            type="password"
            className="input-mini flex-1"
            value={tokenDraft}
            placeholder={cfg.hasToken ? t('channel.tokenSaved') : t('channel.tokenPlaceholder')}
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tokenDraft.trim()) void patchCfg({ token: tokenDraft.trim() })
            }}
            onBlur={() => {
              if (tokenDraft.trim()) void patchCfg({ token: tokenDraft.trim() })
            }}
          />
          {cfg.hasToken && (
            <button
              className="btn-ghost text-[11px] shrink-0"
              title={t('channel.tokenClearTip')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void patchCfg({ token: '' })}
            >
              {t('channel.tokenClear')}
            </button>
          )}
        </div>
      </div>

      {/* 白名单（fail closed：空=拒绝所有） */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.whitelist')}</div>
        <input
          className="input-mini w-full"
          value={cfg.whitelist}
          placeholder={t('channel.whitelistPlaceholder')}
          onChange={(e) => setCfgState((prev) => ({ ...prev, whitelist: e.target.value }))}
          onBlur={(e) => void patchCfg({ whitelist: e.target.value })}
        />
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
          {t('channel.whitelistHint')}
        </div>
      </div>

      {/* 绑定助手 + 目标模型 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.assistant')}</div>
          <select
            className="select-mini w-full"
            value={cfg.assistantId}
            onChange={(e) => void patchCfg({ assistantId: e.target.value })}
          >
            <option value="">{t('channel.assistantNone')}</option>
            {assistants.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.model')}</div>
          <select
            className="select-mini w-full"
            value={cfg.providerId}
            onChange={(e) => void patchCfg({ providerId: e.target.value, model: '' })}
          >
            <option value="">{t('agent.selectProvider')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>
      {selectedProvider && (
        <select
          className="select-mini w-full"
          value={cfg.model}
          onChange={(e) => void patchCfg({ model: e.target.value })}
        >
          <option value="">{selectedProvider.models.length > 0 ? t('agent.selectModel') : t('agent.noModelsHint')}</option>
          {selectedProvider.models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
      <div className="text-[11px] text-[var(--color-text-muted)]">{t('channel.modelHint')}</div>

      {/* Agent 模式开关（远程工具调用，风险提示） */}
      <div className="rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs space-y-1">
        <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
          <input
            type="checkbox"
            checked={cfg.agentMode}
            onChange={(e) => void patchCfg({ agentMode: e.target.checked })}
          />
          🤖 {t('channel.agentMode')}
        </label>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {t('channel.agentModeHint')}
        </div>
        {cfg.agentMode && (
          <div className="text-[11px] text-[var(--color-warning)]">{t('channel.agentModeRisk')}</div>
        )}
      </div>
    </div>
  )
}
