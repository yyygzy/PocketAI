// 快捷浮窗（快捷问答 / 选区助手）渲染层
// 与主窗口共享同一 preload 聊天链路（sendMessage + onChatChunk/Done/Error），
// 事件按 requestId 过滤；本组件只负责 state 映射与渲染。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Markdown } from '../modules/chat/Markdown'
import { AttachmentGrid } from '../components/AttachmentGrid'
import { useToast } from '../components/ToastProvider'
import { reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'
import { useCopyFeedback } from '../hooks/useCopyFeedback'
import { readFileAsAttachment, MAX_ATTACHMENTS, ATTACHMENT_ACCEPT } from '../modules/agent/agent-shared'
import type { AssistantRecord, ChatAttachment, PopupPayload, ProviderRecord, SelectionAction } from '../../../shared/types'
import {
  SELECTION_ACTIONS,
  composeSelectionPrompt
} from '../utils/selection-actions'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
  attachments?: ChatAttachment[]
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
  const toast = useToast()
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
  /** 待发附件（发送成功后清空；随消息一起持久化） */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  /** 拖拽进窗悬停计数（子元素 dragenter/leave 成对，计数器防闪烁） */
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const requestIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? null,
    [providers, providerId]
  )

  // 浮窗载荷（快捷问答 / 选区文本）：首次拉取 + 后续推送
  const pendingActionRef = useRef<{ ts: number; action: SelectionAction } | null>(null)
  const applyPayload = useCallback((p: PopupPayload | null) => {
    if (!p) return
    setMode(p.mode)
    setSelection(p.mode === 'selection' ? p.text ?? '' : '')
    if (p.mode === 'selection' && p.action && SELECTION_ACTIONS.includes(p.action)) {
      // 应用内划词浮条带动作：待 provider/model/助手就绪后自动执行（见下方 effect）
      pendingActionRef.current = { ts: p.ts, action: p.action }
    }
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

  // ─── 附件（粘贴 / 拖拽 / 文件选择三入口，规则与主窗 Composer 一致） ─────
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    let unsupported = 0
    const accepted: ChatAttachment[] = []
    for (const f of list) {
      const att = await readFileAsAttachment(f)
      if (att) accepted.push(att)
      else unsupported++
    }
    if (accepted.length === 0 && unsupported > 0) {
      toast.warning(t('popup.attachUnsupported'))
      return
    }
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length
      if (room <= 0) {
        toast.warning(t('popup.attachLimit', { n: MAX_ATTACHMENTS }))
        return prev
      }
      const next = [...prev, ...accepted.slice(0, room)]
      if (accepted.length > room || unsupported > 0) {
        // 超限/不支持合并为一条提示，避免多文件时 toast 轰炸
        toast.warning(unsupported > 0 ? t('popup.attachUnsupported') : t('popup.attachLimit', { n: MAX_ATTACHMENTS }))
      }
      return next
    })
  }, [t, toast])

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault()
      void addFiles(e.clipboardData.files)
    }
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current += 1
    setDragOver(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!dragOver) return
    e.preventDefault()
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setDragOver(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files)
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  // ─── 发送 ─────────────────────────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      const content = text.trim()
      if ((!content && attachments.length === 0) || streaming || !providerId || !model) return
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
      const sentAtts = attachments
      requestIdRef.current = rid
      setStreaming(true)
      setInput('')
      setAttachments([])
      setMessages((ms) => [
        ...ms,
        { role: 'user', content, attachments: sentAtts.length > 0 ? sentAtts : undefined },
        { role: 'assistant', content: '' }
      ])
      window.pocketai.sendMessage({
        requestId: rid,
        conversationId: convId,
        assistantId: assistant?.id ?? null,
        content,
        attachments: sentAtts.length > 0 ? sentAtts : undefined,
        targets: [{ providerId, model }]
      })
    },
    [streaming, providerId, model, conversationId, assistant, attachments, t]
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
    setAttachments([])
  }

  // ─── 选区动作 ─────────────────────────────────────────────────────
  const runSelectionAction = (action: SelectionAction) => {
    const text = selection.trim()
    if (!text || streaming) return
    void send(composeSelectionPrompt(action, text))
  }

  // 划词浮条唤起（payload 带 action）：provider/model/助手就绪且非流式时自动跑一次。
  // 快捷键取词入口不带 action，保持「显示芯片等用户选」的旧行为。
  useEffect(() => {
    const pending = pendingActionRef.current
    if (!pending || mode !== 'selection' || streaming) return
    if (!selection.trim() || !assistant || !providerId || !model) return
    pendingActionRef.current = null
    runSelectionAction(pending.action)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selection, assistant, providerId, model, streaming])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(input)
    } else if (e.key === 'Escape') {
      if (streaming) {
        // 流式中 Esc 先中止生成（与主窗口 abort 语义一致），非流式才隐藏浮窗
        e.preventDefault()
        stop()
        return
      }
      // 关窗失败无影响（合理静默）
      void window.pocketai.hidePopup().catch(() => {})
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
      // Ctrl/⌘+N：清空重开一轮问答（浮窗内局部快捷键，filterShortcutForContext popup 同款语义）
      e.preventDefault()
      resetConversation()
    }
  }

  const canSend = !streaming && !!providerId && !!model
  const models = selectedProvider?.models ?? []

  return (
    <div
      className="h-screen w-screen p-1.5"
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={`relative flex flex-col h-full rounded-xl overflow-hidden border transition-shadow ${
          dragOver ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)] ring-opacity-60' : 'border-[var(--color-border)]'
        }`}
        style={{ background: 'var(--color-bg)', boxShadow: '0 12px 40px rgba(0,0,0,.35)' }}
      >
        {dragOver && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-[var(--color-accent)] bg-opacity-10 pointer-events-none">
            <span className="text-xs font-semibold text-[var(--color-accent)]">{t('popup.dropToAttach')}</span>
          </div>
        )}
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
            onClick={() => void window.pocketai.hidePopup().catch(() => {})} // 关窗失败无影响（合理静默）
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
              {SELECTION_ACTIONS.map((a) => (
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
                m.content ? (
                  m.error ? (
                    <Markdown content={m.content} />
                  ) : (
                    <AssistantBubble content={m.content} />
                  )
                ) : (
                  <span className="opacity-50">…</span>
                )
              ) : (
                <>
                  {m.content && <span className="whitespace-pre-wrap">{m.content}</span>}
                  {m.attachments && m.attachments.length > 0 && <AttachmentGrid attachments={m.attachments} align="end" />}
                </>
              )}
            </div>
          ))}
        </div>

        {/* 待发附件栏：图片缩略图 / 文本文件名，× 移除 */}
        {attachments.length > 0 && (
          <div className="shrink-0 px-3 pt-2 flex flex-wrap gap-1.5">
            {attachments.map((att, i) => (
              <div key={`${att.name}-${i}`} className="relative group">
                {att.type === 'image' ? (
                  <img src={att.data} alt={att.name} title={att.name} className="w-10 h-10 object-cover rounded-lg border border-[var(--color-border)]" />
                ) : (
                  <div className="h-10 max-w-[140px] flex items-center gap-1 px-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] text-[10px] text-[var(--color-text-muted)]">
                    📄 <span className="truncate">{att.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  title={t('popup.removeAttachment')}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-[var(--color-danger)] text-white text-[9px] leading-none opacity-90 hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 输入区 */}
        <div
          className="shrink-0 px-3 py-2 border-t border-[var(--color-border)] flex items-end gap-1.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="btn-ghost text-xs shrink-0 !px-1.5"
            title={t('popup.addAttachment')}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          <textarea
            ref={taRef}
            className="input flex-1 resize-none text-xs leading-relaxed py-1.5 max-h-28"
            rows={1}
            placeholder={t('popup.inputPlaceholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {streaming ? (
            <button className="btn-ghost text-xs shrink-0" onClick={stop}>
              {t('popup.stop')}
            </button>
          ) : (
            <button
              className="btn-primary text-xs shrink-0"
              disabled={!canSend || (!input.trim() && attachments.length === 0)}
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

/**
 * assistant 回复气泡：hover 时右上角浮出一键复制按钮。
 * 选区助手工作流闭环——翻译/润色/总结结果一键复制走（浮窗失焦自隐，
 * 用户切到目标窗口粘贴时窗口自然隐藏，无需按钮主动关窗）。
 * 图标与 Markdown 代码块复制按钮同口径；复制模型原文（与代码块复制 raw 一致）。
 */
const AssistantBubble: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n()
  const { copied, copy } = useCopyFeedback()
  const label = copied ? t('common.copied') : t('common.copy')
  return (
    <div className="relative group">
      <Markdown content={content} />
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => void copy(content)}
        className={`absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] shadow-sm transition-opacity hover:text-[var(--color-text)] ${
          copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        {copied ? (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8.5 6.5 12 13 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M3 10.5H2.5A1.5 1.5 0 0 1 1 9V2.5A1.5 1.5 0 0 1 2.5 1H9a1.5 1.5 0 0 1 1.5 1.5V3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  )
}
