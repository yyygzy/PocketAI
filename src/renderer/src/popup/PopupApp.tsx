// 快捷浮窗（快捷问答 / 选区助手）渲染层
// 与主窗口共享同一 preload 聊天链路（sendMessage + onChatChunk/Done/Error），
// 事件按 requestId 过滤；本组件只负责 state 映射与渲染。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Markdown } from '../modules/chat/Markdown'
import { reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'
import type { AssistantRecord, PopupPayload, ProviderRecord } from '../../../shared/types'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

const LS_PROVIDER = 'pocketai.popup.provider'
const LS_MODEL = 'pocketai.popup.model'
const MAX_SELECTION_SHOW = 600

// 明显的嵌入/向量模型命名特征（这些不能用于对话，默认选择时跳过）
const EMBED_MODEL_RE = /(^bge[-_]|embed|gte[-_]|e5[-_]|minilm|nomic-embed)/i
const pickChatModel = (models: string[]): string => {
  const saved = localStorage.getItem(LS_MODEL)
  if (saved && models.includes(saved) && !EMBED_MODEL_RE.test(saved)) return saved
  const chat = models.find((m) => !EMBED_MODEL_RE.test(m))
  return chat ?? models[0] ?? ''
}

export const PopupApp: React.FC = () => {
  const { t } = useI18n()
  const [mode, setMode] = useState<'quick' | 'selection'>('quick')
  const [selection, setSelection] = useState('')
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [providerId, setProviderId] = useState(() => localStorage.getItem(LS_PROVIDER) || '')
  const [model, setModel] = useState(() => localStorage.getItem(LS_MODEL) || '')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [assistant, setAssistant] = useState<AssistantRecord | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  const requestIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? null,
    [providers, providerId]
  )

  // 浮窗载荷（快捷问答 / 选区文本）：首次拉取 + 后续推送
  const applyPayload = useCallback((p: PopupPayload | null) => {
    if (!p) return
    setMode(p.mode)
    setSelection(p.mode === 'selection' ? p.text ?? '' : '')
    if (p.mode === 'quick') {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
      focusTimerRef.current = setTimeout(() => { taRef.current?.focus() }, 50)
    }
  }, [])

  // ─── 初始化：Provider / 助手 / payload ────────────────────────────
  useEffect(() => {
    window.pocketai.listProviders().then((ps) => {
      const enabled = ps.filter((p) => p.enabled)
      setProviders(enabled)
      setProviderId((cur) => {
        if (cur && enabled.some((p) => p.id === cur)) return cur
        return enabled[0]?.id ?? ''
      })
    }).catch(reportIpcError('popup.listProviders'))
    window.pocketai.listAssistants().then((as_) => {
      setAssistant(as_.find((a) => a.isBuiltin && /通用问答/.test(a.name)) ?? as_[0] ?? null)
    }).catch(reportIpcError('popup.listAssistants'))
    void window.pocketai.getPopupPayload().then(applyPayload).catch(reportIpcError('popup.getPayload'))
    const unsub = window.pocketai.onPopupPayload(applyPayload)
    return unsub
  }, [applyPayload])

  // provider/model 持久化 + 自动选中首个模型
  useEffect(() => {
    if (providerId) localStorage.setItem(LS_PROVIDER, providerId)
  }, [providerId])
  useEffect(() => {
    if (model) localStorage.setItem(LS_MODEL, model)
  }, [model])
  useEffect(() => {
    if (selectedProvider && selectedProvider.models.length > 0) {
      // 未选模型，或之前误存了嵌入模型 → 自动纠正为对话模型
      if (!model || EMBED_MODEL_RE.test(model)) {
        const next = pickChatModel(selectedProvider.models)
        if (next && next !== model) setModel(next)
      }
    }
  }, [selectedProvider, model])

  // ─── 流式事件（仅接收本窗口发送的 requestId） ──────────────────────
  useEffect(() => {
    const offChunk = window.pocketai.onChatChunk((e) => {
      if (e.requestId !== requestIdRef.current || e.targetIndex !== 0) return
      setMessages((ms) => {
        const next = [...ms]
        const idx = next.findIndex((m, i) => m.role === 'assistant' && i === next.length - 1)
        if (idx >= 0) {
          const cur = next[idx]!
          next[idx] = { ...cur, content: cur.content + e.delta }
        }
        return next
      })
    })
    const offDone = window.pocketai.onChatDone((e) => {
      if (e.requestId !== requestIdRef.current || e.targetIndex !== 0) return
      requestIdRef.current = null
      setStreaming(false)
      setMessages((ms) => {
        const next = [...ms]
        if (next.length) {
          const last = next[next.length - 1]!
          if (last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: e.fullContent || last.content }
          }
        }
        return next
      })
    })
    const offError = window.pocketai.onChatError((e) => {
      if (e.requestId !== requestIdRef.current || e.targetIndex !== 0) return
      requestIdRef.current = null
      setStreaming(false)
      setMessages((ms) => {
        const next = [...ms]
        if (next.length) {
          const last = next[next.length - 1]!
          if (last.role === 'assistant') {
            next[next.length - 1] = { role: 'assistant', content: e.error, error: true }
          }
        }
        return next
      })
    })
    return () => {
      offChunk(); offDone(); offError()
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
    }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const fetchModels = useCallback(async () => {
    if (!providerId || fetchingModels) return
    setFetchingModels(true)
    try {
      const models = await window.pocketai.fetchModels(providerId)
      setProviders((ps) => ps.map((p) => (p.id === providerId ? { ...p, models } : p)))
      if (models.length > 0) setModel(models[0]!)
    } catch {
      // 拉取失败在主窗口设置页有完整报错，浮窗内静默
    } finally {
      setFetchingModels(false)
    }
  }, [providerId, fetchingModels])

  // ─── 发送 ─────────────────────────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      const content = text.trim()
      if (!content || streaming || !providerId || !model) return
      let convId = conversationId
      try {
        if (!convId) {
          if (!assistant) return
          const conv = await window.pocketai.createConversation(assistant.id)
          convId = conv.id
          setConversationId(convId)
        }
      } catch (e) {
        // 创建会话失败：用户主动操作必须有可见反馈（参考 onChatError 形态）
        // input 未清空、streaming 未置 true，用户可重试
        setMessages((ms) => [...ms, { role: 'assistant', content: errText(e, t('common.unknownError')), error: true }])
        return
      }
      const rid = `popup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      requestIdRef.current = rid
      setStreaming(true)
      setInput('')
      setMessages((ms) => [
        ...ms,
        { role: 'user', content },
        { role: 'assistant', content: '' }
      ])
      window.pocketai.sendMessage({
        requestId: rid,
        conversationId: convId,
        assistantId: assistant?.id ?? null,
        content,
        targets: [{ providerId, model }]
      })
    },
    [streaming, providerId, model, conversationId, assistant, t]
  )

  const stop = () => {
    if (requestIdRef.current) window.pocketai.abortChat(requestIdRef.current)
    requestIdRef.current = null
    setStreaming(false)
  }

  const resetConversation = () => {
    if (streaming) stop()
    setConversationId(null)
    setMessages([])
  }

  // ─── 选区动作 ─────────────────────────────────────────────────────
  const runSelectionAction = (action: 'translate' | 'summary' | 'polish' | 'ask') => {
    const text = selection.trim()
    if (!text || streaming) return
    const composed =
      action === 'translate'
        ? `请把下面的内容翻译成英文（若内容已是英文则翻译成简体中文）。只输出译文，不要解释。\n\n"""\n${text}\n"""`
        : action === 'summary'
          ? `请用简体中文总结下面内容的要点，使用不超过 5 条要点的无序列表。\n\n"""\n${text}\n"""`
          : action === 'polish'
            ? `请润色改写下面的内容，保持原意与原语言，只输出改写后的全文，不要解释。\n\n"""\n${text}\n"""`
            : text
    void send(composed)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(input)
    } else if (e.key === 'Escape') {
      void window.pocketai.hidePopup()
    }
  }

  const canSend = !streaming && !!providerId && !!model
  const models = selectedProvider?.models ?? []

  return (
    <div className="h-screen w-screen p-1.5">
      <div
        className="flex flex-col h-full rounded-xl overflow-hidden border border-[var(--color-border)]"
        style={{ background: 'var(--color-bg)', boxShadow: '0 12px 40px rgba(0,0,0,.35)' }}
      >
        {/* 标题栏（可拖拽；按钮必须 no-drag） */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 shrink-0 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <span className="text-xs font-semibold text-[var(--color-text)] truncate">
            {mode === 'selection' ? '🔤 ' : '⚡ '}
            {mode === 'selection' ? t('popup.titleSelection') : t('popup.titleQuick')}
          </span>
          <div className="flex-1" />
          <button
            className="btn-ghost !px-2 !py-0.5 text-xs"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={resetConversation}
            title={t('popup.newChat')}
          >
            🗑
          </button>
          <button
            className="btn-ghost !px-2 !py-0.5 text-xs"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => void window.pocketai.hidePopup()}
            title={t('popup.close')}
          >
            ✕
          </button>
        </div>

        {/* 模型选择行 */}
        <div
          className="flex items-center gap-1.5 px-3 pb-2 shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <select
            className="select-mini flex-1 min-w-0 text-xs"
            value={providerId}
            onChange={(e) => { setProviderId(e.target.value); setModel('') }}
          >
            {providers.length === 0 && <option value="">{t('popup.noProvider')}</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {models.length > 0 ? (
            <select
              className="select-mini flex-1 min-w-0 text-xs"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <button className="btn-ghost text-xs shrink-0" disabled={fetchingModels || !providerId} onClick={fetchModels}>
              {fetchingModels ? t('agent.fetching') : t('agent.fetchModels')}
            </button>
          )}
        </div>

        {/* 选区文本 + 动作芯片 */}
        {mode === 'selection' && selection && (
          <div className="px-3 pb-2 shrink-0">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] p-2 text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap break-words max-h-28 overflow-auto">
              {selection.length > MAX_SELECTION_SHOW
                ? selection.slice(0, MAX_SELECTION_SHOW) + '…'
                : selection}
            </div>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {(['translate', 'summary', 'polish', 'ask'] as const).map((a) => (
                <button
                  key={a}
                  className="btn-ghost text-xs !py-0.5"
                  disabled={streaming || !canSend}
                  onClick={() => runSelectionAction(a)}
                >
                  {t(`popup.act.${a}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 消息区 */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 space-y-2">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] px-4 leading-relaxed">
              {mode === 'selection'
                ? t('popup.selectionEmptyHint')
                : t('popup.quickEmptyHint')}
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-lg px-2.5 py-1.5 text-xs break-words ${
                m.role === 'user'
                  ? 'bg-[var(--color-accent)] bg-opacity-10 text-[var(--color-text)] ml-6'
                  : m.error
                    ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] mr-6'
                    : 'bg-[var(--color-sidebar)] text-[var(--color-text)] mr-6'
              }`}
            >
              {m.role === 'assistant' ? (
                m.content ? <Markdown content={m.content} /> : <span className="opacity-50">…</span>
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
            </div>
          ))}
        </div>

        {/* 输入区 */}
        <div
          className="shrink-0 px-3 py-2 border-t border-[var(--color-border)] flex items-end gap-1.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <textarea
            ref={taRef}
            className="input flex-1 resize-none text-xs leading-relaxed py-1.5 max-h-28"
            rows={1}
            placeholder={t('popup.inputPlaceholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {streaming ? (
            <button className="btn-ghost text-xs shrink-0" onClick={stop}>
              {t('popup.stop')}
            </button>
          ) : (
            <button
              className="btn-primary text-xs shrink-0"
              disabled={!canSend || !input.trim()}
              onClick={() => void send(input)}
            >
              {t('popup.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
