// Agent 模块：MCP Server 管理 + Work Agent 对话
// 左侧：MCP Server 列表（启停/工具查看/新增/编辑/删除）
// 右侧：Agent 对话面板（ReAct 步骤可视化）
import React, { useEffect, useRef, useState } from 'react'
import type {
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent,
  McpServerLogEvent,
  ProviderRecord,
  AssistantRecord,
  ConversationRecord,
  MessageRecord,
  AgentStepEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  ToolCall,
  ToolResult
} from '../../../../shared/types'
import { useI18n } from '../../i18n'

type Tab = 'servers' | 'agent'

const ARGS_PLACEHOLDER = '["-y","@modelcontextprotocol/server-filesystem","/tmp"]'
const ENV_PLACEHOLDER = '{"API_KEY":"xxx"}'

export const AgentModule: React.FC = () => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('servers')

  return (
    <div className="flex flex-col h-full">
      {/* 子标签 */}
      <div className="flex gap-1 mb-3 border-b border-[var(--color-border)]">
        <TabBtn active={tab === 'servers'} onClick={() => setTab('servers')}>
          {t('agent.tabServers')}
        </TabBtn>
        <TabBtn active={tab === 'agent'} onClick={() => setTab('agent')}>
          {t('agent.tabChat')}
        </TabBtn>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'servers' ? <McpPanel /> : <AgentPanel />}
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
  const [records, setRecords] = useState<McpServerRecord[]>([])
  const [runtimes, setRuntimes] = useState<McpServerRuntime[]>([])
  const [editing, setEditing] = useState<Partial<McpServerRecord> | null>(null)
  const [logs, setLogs] = useState<McpServerLogEvent[]>([])

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
          command: base?.command ?? null,
          args: base?.args ?? [],
          env: base?.env ?? {},
          url: base?.url ?? null,
          enabled: base?.enabled ?? false,
          createdAt: base?.createdAt ?? Date.now(),
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

  const runtimeOf = (id: string): McpServerRuntime | undefined =>
    runtimes.find((r) => r.id === id)

  const handleStart = async (id: string) => {
    const r = await window.pocketai.startMcpServer(id)
    if (!r.ok) alert(t('agent.startFail', { e: r.error ?? t('common.unknownError') }))
  }
  const handleStop = async (id: string) => {
    await window.pocketai.stopMcpServer(id)
  }
  const handleRestart = async (id: string) => {
    const r = await window.pocketai.restartMcpServer(id)
    if (!r.ok) alert(t('agent.restartFail', { e: r.error ?? t('common.unknownError') }))
  }
  const handleDelete = async (id: string) => {
    if (!confirm(t('agent.deleteConfirm'))) return
    await window.pocketai.deleteMcpServer(id)
    await load()
  }

  return (
    <div className="flex gap-4 h-full">
      {/* 左：列表 */}
      <div className="w-72 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">MCP Servers</h3>
          <button
            onClick={() => setEditing({ name: '', transport: 'stdio', command: 'node', args: [], env: {} })}
            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
          >
            {t('agent.add')}
          </button>
        </div>
        <div className="space-y-1 overflow-y-auto">
          {records.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('agent.noServers')}
            </p>
          )}
          {records.map((r) => {
            const rt = runtimeOf(r.id)
            const status = rt?.status ?? 'stopped'
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
                  ) : (
                    <MiniBtn onClick={() => handleStart(r.id)}>{t('common.start')}</MiniBtn>
                  )}
                  <MiniBtn onClick={() => setEditing({ ...r })}>{t('common.edit')}</MiniBtn>
                  <MiniBtn danger onClick={() => handleDelete(r.id)}>{t('common.delete')}</MiniBtn>
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
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null)
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
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}> = ({ onClick, children, danger }) => (
  <button
    onClick={onClick}
    className={`text-[10px] px-1.5 py-0.5 rounded border ${
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
  onSaved: () => void
}> = ({ initial, onCancel, onSaved }) => {
  const { t } = useI18n()
  const [name, setName] = useState(initial.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial.transport ?? 'stdio')
  const [command, setCommand] = useState(initial.command ?? 'node')
  const [argsText, setArgsText] = useState(JSON.stringify(initial.args ?? [], null, 2))
  const [envText, setEnvText] = useState(JSON.stringify(initial.env ?? {}, null, 2))
  const [url, setUrl] = useState(initial.url ?? '')
  const [enabled, setEnabled] = useState(initial.enabled !== false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

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
      await window.pocketai.saveMcpServer({
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : null,
        args: transport === 'stdio' ? args : [],
        env: transport === 'stdio' ? env : {},
        url: transport === 'http' ? url.trim() || null : null,
        enabled
      } as any)
      onSaved()
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
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.command')}</label>
            <input className="input font-mono text-xs" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('agent.f.commandPh')} />
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
  toolCall?: ToolCall
  toolResult?: ToolResult
  stepIndex?: number
  isFinal?: boolean
  isError?: boolean
}

const AgentPanel: React.FC = () => {
  const { t } = useI18n()
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
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const requestIdRef = useRef<string>('')
  const stepBufRef = useRef<Map<string, { msg: AgentMessage; text: string }>>(new Map())

  useEffect(() => {
    Promise.all([window.pocketai.listProviders(), window.pocketai.listAssistants()]).then(([ps, as_]) => {
      setProviders(ps.filter((p) => p.enabled))
      setAssistants(as_)
    })
    window.pocketai.getAgentWorkspaceDir().then(setWorkspaceDir)
  }, [])

  useEffect(() => {
    if (!assistantId) return
    window.pocketai.listConversations(assistantId).then(setConversations)
    setConversationId(null)
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
          out.push({ id: m.id, role: 'user', text: m.content })
        } else if (m.role === 'assistant') {
          out.push({ id: m.id, role: 'assistant', text: m.content, isFinal: m.status === 'done' })
        } else if (m.role === 'tool') {
          try {
            const tr = JSON.parse(m.content) as ToolResult
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
      window.pocketai.onAgentChunk((e: { messageId: string; delta: string }) => {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === e.messageId)
          if (idx === -1) return prev
          const next = [...prev]
          next[idx] = { ...next[idx], text: (next[idx].text ?? '') + e.delta }
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
    setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: 'user', text: userText }])
    setInput('')
    setRunning(true)

    await window.pocketai.sendMessage({
      requestId,
      conversationId,
      assistantId: assistantId || null,
      content: userText,
      targets: [{ providerId, model }],
      agentMode: true
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

        {/* 输入 */}
        <div className="flex gap-2 pt-2 border-t border-[var(--color-border)] mt-2">
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
              disabled={!input.trim() || !providerId || !model || !conversationId}
            >
              {t('common.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const MessageCard: React.FC<{ m: AgentMessage }> = ({ m }) => {
  const { t } = useI18n()
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-[var(--color-accent-soft)] px-3 py-2 rounded-lg max-w-[80%] text-sm">
          {m.text}
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
      </div>
    )
  }
  // assistant
  return (
    <div className={`px-3 py-2 rounded-lg text-sm ${m.isFinal ? 'bg-[var(--color-hover-overlay)]' : 'bg-[var(--color-input-bg)]'}`}>
      {m.isFinal && <div className="text-[10px] text-[var(--color-accent)] mb-1">{t('agent.finalAnswer')}</div>}
      <div className={`whitespace-pre-wrap ${m.isError ? 'text-[var(--color-danger)]' : ''}`}>{m.text || (m.isFinal ? '' : t('agent.thinking'))}</div>
    </div>
  )
}
