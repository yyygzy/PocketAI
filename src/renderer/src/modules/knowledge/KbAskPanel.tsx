// KB 问答面板：知识库详情页内「选库即聊」——自动检索拼上下文，流式回答带编号引用。
// 轻量实现：对话内存态（不落库），模型选择记忆在 localStorage，默认第一个启用 provider。
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { EmptyState } from '../../components/EmptyState'
import { requestSourceJump } from './source-jump'
import { Markdown } from '../chat/Markdown'
import type {
  KnowledgeBase,
  KbAskMessage,
  MessageSource,
  ProviderRecord
} from '../../../../shared/types'
import { errText } from '../../utils/error'

const PROVIDER_KEY = 'kbask.providerId'
const modelKey = (p: string) => `kbask.model.${p}`

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

  // 流式事件订阅（一次挂载；requestId 校验防串扰）
  useEffect(() => {
    const offChunk = window.pocketai.onKbAskChunk((e) => {
      if (e.requestId !== requestRef.current) return
      setStreamText((prev) => prev + e.delta)
    })
    const offDone = window.pocketai.onKbAskDone((e) => {
      if (e.requestId !== requestRef.current) return
      requestRef.current = null
      setMsgs((m) => [
        ...m,
        { role: 'assistant', content: e.fullContent, sources: e.sources }
      ])
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
    const history: { role: 'user' | 'assistant'; content: string }[] = msgs.map((m) => ({
      role: m.role,
      content: m.content
    }))
    setMsgs((m) => [...m, { role: 'user', content: q }])
    setStreamText('')
    setStreamSources([])
    setPending(true)
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
