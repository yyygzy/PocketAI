// KB 问答面板：知识库详情页内「选库即聊」——自动检索拼上下文，流式回答带编号引用。
// 问答会话落库留痕（渲染端全量 upsert 单写路径），可从历史列表回看与继续追问；
// 模型选择记忆在 localStorage，默认第一个启用 provider。
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { EmptyState } from '../../components/EmptyState'
import { requestSourceJump } from './source-jump'
import { Markdown } from '../chat/Markdown'
import { ExportMenu } from '../chat/ConversationList'
import { sessionTitleFrom } from '../../../../shared/kb-ask-session'
import { buildKbAskSessionHtml } from '../../utils/export-html'
import type {
  KnowledgeBase,
  KbAskMessage,
  KbAskSessionMeta,
  MessageSource,
  ProviderRecord
} from '../../../../shared/types'
import { errText } from '../../utils/error'

const PROVIDER_KEY = 'kbask.providerId'
const modelKey = (p: string) => `kbask.model.${p}`

/** 会话时间展示：当天只显示时分，跨天显示日期（同年省略年份） */
const fmtSessionTime = (ts: number): string => {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const ymd = `${d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}`
  return `${ymd} ${hm}`
}

const KbAskPanel: React.FC<{ kb: KnowledgeBase }> = ({ kb }) => {
  const { t } = useI18n()
  const toast = useToast()

  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [msgs, setMsgs] = useState<KbAskMessage[]>([])
  const [streamText, setStreamText] = useState('')
  const [streamSources, setStreamSources] = useState<MessageSource[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const requestRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // msgs 镜像：一次性挂载的流式订阅与持久化需要拿到最新全量消息
  const msgsRef = useRef<KbAskMessage[]>([])
  // 会话留痕：当前会话 id / 创建时间；历史列表与展开态
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionCreatedAt, setSessionCreatedAt] = useState(0)
  const [sessionList, setSessionList] = useState<KbAskSessionMeta[]>([])
  const [showHistory, setShowHistory] = useState(false)
  // 重命名内联编辑：正在编辑的会话 id 与草稿标题
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 导出进行中（防重入）
  const [exportingId, setExportingId] = useState<string | null>(null)

  /** 拉取本库历史会话列表（仅元数据，更新时间倒序） */
  const refreshSessions = () => {
    window.pocketai
      .listKbAskSessions(kb.id)
      .then(setSessionList)
      .catch(() => {}) // 留痕属增强能力，列表加载失败不打断问答
  }

  // 挂载即拉取历史（「历史」按钮上展示数量）
  useEffect(() => {
    refreshSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.id])

  // 加载启用的 provider + 记忆的模型选择；默认第一个 provider 的第一个模型（小白零配置）
  useEffect(() => {
    let alive = true
    window.pocketai
      .listProviders()
      .then((ps) => {
        if (!alive) return
        const enabled = ps.filter((p) => p.enabled)
        setProviders(enabled)
        const remembered = enabled.find((p) => p.id === localStorage.getItem(PROVIDER_KEY))
        const first = remembered ?? enabled[0]
        if (first) {
          setProviderId(first.id)
          setModel(localStorage.getItem(modelKey(first.id)) || first.models[0] || '')
        }
      })
      .catch((e) => toast.error(errText(e)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectProvider = (id: string) => {
    setProviderId(id)
    localStorage.setItem(PROVIDER_KEY, id)
    const p = providers.find((x) => x.id === id)
    const nextModel = (p && localStorage.getItem(modelKey(id))) || p?.models[0] || ''
    setModel(nextModel)
  }

  const selectModel = (m: string) => {
    setModel(m)
    if (providerId) localStorage.setItem(modelKey(providerId), m)
  }

  /** 会话落库：全量 msgs upsert 单写路径；留痕失败静默（不打断问答） */
  const persistSession = (
    next: KbAskMessage[],
    sid: string | null = sessionId,
    createdAt = sessionCreatedAt
  ) => {
    if (!sid || next.length === 0) return
    const firstUser = next.find((m) => m.role === 'user')
    window.pocketai
      .saveKbAskSession({
        id: sid,
        kbId: kb.id,
        title: sessionTitleFrom(firstUser?.content ?? ''),
        messages: next,
        providerId,
        model,
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now()
      })
      .then(refreshSessions)
      .catch(() => {})
  }
  // 经 ref 转发：一次性挂载的流式订阅闭包始终调用最新实现（拿到最新 provider/model/sessionId）
  const persistRef = useRef(persistSession)
  persistRef.current = persistSession

  // 流式事件订阅（一次挂载；requestId 校验防串扰）
  useEffect(() => {
    const offChunk = window.pocketai.onKbAskChunk((e) => {
      if (e.requestId !== requestRef.current) return
      setStreamText((prev) => prev + e.delta)
    })
    const offDone = window.pocketai.onKbAskDone((e) => {
      if (e.requestId !== requestRef.current) return
      requestRef.current = null
      // 追加回答并落库（含引用来源）；发送时已存过提问，此处为第二次 upsert
      const next: KbAskMessage[] = [
        ...msgsRef.current,
        { role: 'assistant', content: e.fullContent, sources: e.sources }
      ]
      msgsRef.current = next
      setMsgs(next)
      persistRef.current(next)
      setStreamText('')
      setStreamSources([])
      setPending(false)
    })
    const offError = window.pocketai.onKbAskError((e) => {
      if (e.requestId !== requestRef.current) return
      requestRef.current = null
      setStreamText('')
      setStreamSources([])
      setPending(false)
      toast.error(e.error)
    })
    return () => {
      offChunk()
      offDone()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 消息变化自动滚底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, streamText])

  const send = async () => {
    const q = input.trim()
    if (!q || pending) return
    if (!providerId || !model) {
      toast.warning(t('kb.askModelRequired'))
      return
    }
    setInput('')
    // 首轮发问生成会话 id；先落「含提问」，回答完成后再落「含回答」
    let sid = sessionId
    let createdAt = sessionCreatedAt
    if (!sid) {
      sid = crypto.randomUUID()
      createdAt = Date.now()
      setSessionId(sid)
      setSessionCreatedAt(createdAt)
    }
    const history: { role: 'user' | 'assistant'; content: string }[] = msgsRef.current.map((m) => ({
      role: m.role,
      content: m.content
    }))
    const next: KbAskMessage[] = [...msgsRef.current, { role: 'user', content: q }]
    msgsRef.current = next
    setMsgs(next)
    setStreamText('')
    setStreamSources([])
    setPending(true)
    persistRef.current(next, sid, createdAt)
    try {
      const { requestId } = await window.pocketai.kbAsk({
        kbIds: [kb.id],
        providerId,
        model,
        question: q,
        history
      })
      requestRef.current = requestId
    } catch (e) {
      setPending(false)
      toast.error(errText(e))
    }
  }

  const stop = () => {
    if (requestRef.current) void window.pocketai.kbAskAbort(requestRef.current)
  }

  /** 开始新会话：中止进行中的请求并清空当前对话 */
  const startNewSession = () => {
    if (requestRef.current) {
      void window.pocketai.kbAskAbort(requestRef.current)
      requestRef.current = null
      setPending(false)
    }
    setSessionId(null)
    setSessionCreatedAt(0)
    msgsRef.current = []
    setMsgs([])
    setStreamText('')
    setStreamSources([])
    setShowHistory(false)
  }

  /** 加载历史会话：中止进行中的请求，回放全部消息，可继续追问 */
  const loadSession = (id: string) => {
    if (requestRef.current) {
      void window.pocketai.kbAskAbort(requestRef.current)
      requestRef.current = null
      setPending(false)
    }
    window.pocketai
      .getKbAskSession(id)
      .then((rec) => {
        if (!rec) {
          refreshSessions()
          return
        }
        setSessionId(rec.id)
        setSessionCreatedAt(rec.createdAt)
        msgsRef.current = rec.messages
        setMsgs(rec.messages)
        setStreamText('')
        setStreamSources([])
        setShowHistory(false)
      })
      .catch((e) => toast.error(errText(e)))
  }

  /** 删除历史会话；删的是当前会话则回到新对话态 */
  const removeSession = (id: string) => {
    window.pocketai
      .deleteKbAskSession(id)
      .then(() => {
        refreshSessions()
        if (id === sessionId) startNewSession()
      })
      .catch((e) => toast.error(errText(e)))
  }

  /** 发起重命名：进入内联编辑态，草稿初始化为当前标题 */
  const beginRename = (id: string, currentTitle: string) => {
    setRenamingId(id)
    setRenameDraft(currentTitle)
  }

  /** 提交重命名（空串不提交），成功后刷新列表 */
  const commitRename = (id: string) => {
    const title = renameDraft.trim()
    setRenamingId(null)
    if (!title) return
    window.pocketai
      .renameKbAskSession(id, title)
      .then(() => refreshSessions())
      .catch((e) => toast.error(errText(e)))
  }

  /** 导出会话：MD 走主进程构建；HTML 渲染端构建后传主进程存盘 */
  const exportSession = async (id: string, format: 'md' | 'html') => {
    if (exportingId) return
    setExportingId(id)
    try {
      if (format === 'md') {
        const r = await window.pocketai.exportKbAskSessionMd(id)
        if (r.ok && !r.canceled && r.path) toast.success(t('kb.askExported', { path: r.path }))
        else if (!r.ok && r.error) toast.error(r.error)
      } else {
        const rec = await window.pocketai.getKbAskSession(id)
        if (!rec) {
          toast.error(t('kb.askSessionNotFound'))
          refreshSessions()
          return
        }
        const html = await buildKbAskSessionHtml(
          { title: rec.title, model: rec.model, createdAt: rec.createdAt, updatedAt: rec.updatedAt },
          rec.messages
        )
        const r = await window.pocketai.exportKbAskSessionHtml(id, html)
        if (r.ok && !r.canceled && r.path) toast.success(t('kb.askExported', { path: r.path }))
        else if (!r.ok && r.error) toast.error(r.error)
      }
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setExportingId(null)
    }
  }

  const jumpToSource = (msgIndex: number, n: number) => {
    document.getElementById(`kbask-src-${msgIndex}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  return (
    <div className="flex flex-col h-[520px]">
      {/* 模型选择：provider + model，记忆上次选择 */}
      <div className="flex gap-2 mb-3">
        <select className="input text-xs flex-1" value={providerId} onChange={(e) => selectProvider(e.target.value)}>
          <option value="">{t('kb.pleaseSelect')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {providers.find((p) => p.id === providerId)?.models.length ? (
          <select className="input text-xs flex-1" value={model} onChange={(e) => selectModel(e.target.value)}>
            {providers
              .find((p) => p.id === providerId)!
              .models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
          </select>
        ) : (
          <input
            className="input text-xs flex-1"
            value={model}
            onChange={(e) => selectModel(e.target.value)}
            placeholder={t('kb.embModel')}
          />
        )}
      </div>

      {/* 会话工具行：历史切换 + 新对话 + 当前会话重命名/导出 */}
      <div className="flex items-center gap-1.5 mb-2">
        <button
          onClick={() => {
            if (!showHistory) refreshSessions()
            setShowHistory(!showHistory)
          }}
          className={`text-xs px-2 py-1 rounded border transition-colors${
            showHistory
              ? ' border-[var(--color-accent)] text-[var(--color-accent)]'
              : ' border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]'
          }`}
        >
          {t('kb.askHistory')}（{sessionList.length}）
        </button>
        <button onClick={startNewSession} className="btn-ghost text-xs">
          {t('kb.askNewSession')}
        </button>
        {sessionId && !pending && (
          <>
            <button
              onClick={() => {
                const cur = sessionList.find((s) => s.id === sessionId)
                beginRename(sessionId, cur?.title ?? '')
              }}
              className="btn-ghost text-xs"
              title={t('chat.rename')}
            >
              {t('chat.rename')}
            </button>
            <ExportMenu
              triggerTitle={t('chat.exportMenu')}
              triggerContent="↓"
              triggerClassName="btn-ghost text-xs"
              items={[
                { key: 'md', label: t('chat.exportMd') },
                { key: 'html', label: t('chat.exportHtml') }
              ]}
              onPick={(k) => void exportSession(sessionId!, k as 'md' | 'html')}
            />
          </>
        )}
      </div>

      {/* 历史会话列表 */}
      {showHistory && (
        <div className="mb-3 space-y-1 max-h-40 overflow-y-auto pr-1">
          {sessionList.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] py-3 text-center">{t('kb.askNoSessions')}</p>
          )}
          {sessionList.map((s) => (
            <div
              key={s.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded bg-[var(--color-sidebar)] border transition-colors${
                renamingId === s.id ? '' : ' cursor-pointer'
              }${
                s.id === sessionId
                  ? ' border-[var(--color-accent)]'
                  : ' border-[var(--color-border)] hover:border-[var(--color-accent)]'
              }`}
              onClick={() => renamingId !== s.id && loadSession(s.id)}
            >
              <div className="flex-1 min-w-0">
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s.id)
                      else if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => commitRename(s.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="input text-[13px] w-full py-0"
                  />
                ) : (
                  <div className="text-[13px] truncate">{s.title}</div>
                )}
                <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                  {fmtSessionTime(s.updatedAt)} · {t('kb.askMsgCount', { n: s.messageCount })}
                  {s.model ? ` · ${s.model}` : ''}
                </div>
              </div>
              {renamingId !== s.id && (
                <>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      beginRename(s.id, s.title)
                    }}
                    className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                    title={t('chat.rename')}
                    aria-label={t('chat.rename')}
                  >
                    ✎
                  </button>
                  <ExportMenu
                    triggerTitle={t('chat.exportMenu')}
                    triggerContent="↓"
                    triggerClassName="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                    items={[
                      { key: 'md', label: t('chat.exportMd') },
                      { key: 'html', label: t('chat.exportHtml') }
                    ]}
                    onPick={(k) => void exportSession(s.id, k as 'md' | 'html')}
                  />
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      removeSession(s.id)
                    }}
                    className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {msgs.length === 0 && !pending && (
          <EmptyState message={t('kb.askEmpty')} />
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[13px] leading-relaxed whitespace-pre-wrap select-text">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-sidebar)] border border-[var(--color-border)] select-text">
                {m.content ? (
                  <Markdown
                    content={m.content}
                    citationCount={m.sources?.length ?? 0}
                    onCitation={(n) => jumpToSource(i, n)}
                  />
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)]">{t('kb.askNoAnswer')}</span>
                )}
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {m.sources.map((s, si) => (
                      <div
                        key={s.chunkId}
                        id={`kbask-src-${i}-${si + 1}`}
                        className="px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] scroll-mt-2"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1 rounded border border-[var(--color-border)] text-[var(--color-accent)] font-medium">
                            [{si + 1}]
                          </span>
                          <span className="text-[11px] text-[var(--color-accent)] font-medium truncate">
                            {s.docTitle}
                          </span>
                          {s.kbId && s.seq !== undefined && (
                            <button
                              onClick={() =>
                                requestSourceJump({ kbId: s.kbId!, docId: s.docId, seq: s.seq! })
                              }
                              title={t('chatview.viewSource')}
                              aria-label={t('chatview.viewSource')}
                              className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                            >
                              ↗
                            </button>
                          )}
                        </div>
                        <div className="text-[12px] text-[var(--color-text-muted)] mt-0.5 line-clamp-2">
                          {s.content.slice(0, 120)}
                          {s.content.length > 120 ? '…' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {pending && (
          <div className="flex justify-start">
            <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-sidebar)] border border-[var(--color-border)] select-text">
              {streamText ? (
                <Markdown
                  content={streamText}
                  citationCount={streamSources.length}
                />
              ) : (
                <span className="inline-block w-2 h-4 bg-[var(--color-accent)] animate-pulse align-middle" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="flex gap-2 mt-3 items-end">
        <textarea
          className="input text-xs flex-1 resize-none"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={t('kb.askPlaceholder')}
        />
        {pending ? (
          <button onClick={stop} className="btn-ghost text-xs">
            {t('kb.askStop')}
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!input.trim()} className="btn-primary text-xs disabled:opacity-50">
            {t('kb.askSend')}
          </button>
        )}
      </div>
    </div>
  )
}

export default KbAskPanel
