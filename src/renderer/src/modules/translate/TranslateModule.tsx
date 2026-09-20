// 翻译模块
//
// 左栏：翻译历史（最近 100 条，可回填/删除/清空）
// 主区：原文/译文双栏 + 语言与 Provider 控制行 + 术语表管理
// 翻译经主进程 TRANSLATE_RUN 走现有 OpenAI 兼容适配器，delta 由
// TRANSLATE_CHUNK_EVENT 流式推送；组件卸载时自动中止进行中的请求。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GlossaryTerm,
  ProviderRecord,
  TranslationRecord,
  TranslateLang,
  TranslateStyle
} from '../../../../shared/types'
import { useI18n } from '../../i18n'

/** 源语言候选（含自动检测） */
const SOURCE_LANGS: TranslateLang[] = [
  'auto',
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'ru',
  'es',
  'zh-TW'
]
/** 目标语言候选（不含自动检测） */
const TARGET_LANGS: Exclude<TranslateLang, 'auto'>[] = [
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'ru',
  'es',
  'zh-TW'
]
const STYLES: TranslateStyle[] = ['standard', 'fluent', 'literal', 'formal']

const langKey = (code: string) => `translate.lang.${code}`
const styleKey = (code: string) => `translate.style.${code}`

type RunState = 'idle' | 'running' | 'done' | 'aborted' | 'error'

const fmtTime = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const TranslateModule: React.FC = () => {
  const { t } = useI18n()

  // ---------- 配置 ----------
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [sourceLang, setSourceLang] = useState<TranslateLang>('auto')
  const [targetLang, setTargetLang] = useState<Exclude<TranslateLang, 'auto'>>('en')
  const [style, setStyle] = useState<TranslateStyle>('standard')

  // ---------- 文本与请求状态 ----------
  const [sourceText, setSourceText] = useState('')
  const [targetText, setTargetText] = useState('')
  const [runState, setRunState] = useState<RunState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const requestIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------- 历史 ----------
  const [history, setHistory] = useState<TranslationRecord[]>([])

  // ---------- 术语表 ----------
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([])
  const [glossaryEnabled, setGlossaryEnabled] = useState(false)
  const [glossaryOpen, setGlossaryOpen] = useState(false)

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers])
  const activeProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) ?? null,
    [enabledProviders, providerId]
  )
  /** 模型下拉候选；回填历史时模型可能已不在缓存列表，补一条避免空选 */
  const modelOptions = useMemo(() => {
    const list = activeProvider?.models ?? []
    if (model && !list.includes(model)) return [model, ...list]
    return list
  }, [activeProvider, model])

  // ---------- 初始加载 ----------
  useEffect(() => {
    window.pocketai.listProviders().then((list) => {
      setProviders(list)
      const first = list.find((p) => p.enabled)
      if (first) {
        setProviderId(first.id)
        if (first.models[0]) setModel(first.models[0])
      }
    })
    window.pocketai.listTranslations().then(setHistory)
    window.pocketai.listGlossary().then(setGlossary)
  }, [])

  // ---------- 流式增量订阅 ----------
  useEffect(() => {
    const off = window.pocketai.onTranslateChunk((e) => {
      if (e.requestId === requestIdRef.current) setTargetText((prev) => prev + e.delta)
    })
    return () => {
      off()
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      // 离开模块时中止进行中的翻译
      if (runningRef.current && requestIdRef.current) {
        window.pocketai.abortTranslate(requestIdRef.current).catch(() => {})
      }
    }
  }, [])

  const reloadHistory = useCallback(() => {
    window.pocketai.listTranslations().then(setHistory)
  }, [])

  // ---------- 发起翻译 ----------
  const handleTranslate = useCallback(async () => {
    if (runningRef.current) return
    setErrorMsg('')

    if (!sourceText.trim()) {
      setRunState('error')
      setErrorMsg(t('translate.errEmpty'))
      return
    }
    if (enabledProviders.length === 0) {
      setRunState('error')
      setErrorMsg(t('translate.errNoProvider'))
      return
    }
    if (!providerId || !model) {
      setRunState('error')
      setErrorMsg(t('translate.errNoModel'))
      return
    }

    const requestId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    requestIdRef.current = requestId
    runningRef.current = true
    setRunState('running')
    setTargetText('')

    const result = await window.pocketai.translate({
      requestId,
      providerId,
      model,
      sourceLang,
      targetLang,
      style,
      text: sourceText,
      glossaryEnabled
    })

    runningRef.current = false
    requestIdRef.current = null

    if (result.ok) {
      setTargetText(result.content)
      setRunState('done')
      reloadHistory()
    } else if (result.aborted) {
      setRunState('aborted')
    } else {
      setRunState('error')
      setErrorMsg(
        result.error === 'EMPTY_TEXT'
          ? t('translate.errEmpty')
          : result.error === 'MISSING_CONFIG'
            ? t('translate.errNoModel')
            : t('translate.errRequest', { e: result.error })
      )
    }
  }, [
    sourceText,
    enabledProviders.length,
    providerId,
    model,
    sourceLang,
    targetLang,
    style,
    glossaryEnabled,
    reloadHistory,
    t
  ])

  const handleStop = useCallback(() => {
    if (requestIdRef.current) window.pocketai.abortTranslate(requestIdRef.current).catch(() => {})
  }, [])

  // ---------- 语言互换 ----------
  const handleSwap = useCallback(() => {
    // 语言：源为自动检测时，目标语提升为源语言，目标位回退中文（避免目标语=自动检测）；
    // 若目标语本就是中文则回退英语，避免互换后源/目标相同
    if (sourceLang === 'auto') {
      setSourceLang(targetLang)
      setTargetLang(targetLang === 'zh' ? 'en' : 'zh')
    } else {
      const oldSrc = sourceLang
      setSourceLang(targetLang)
      setTargetLang(oldSrc as Exclude<TranslateLang, 'auto'>)
    }
    // 文本同时交换（译文可修订后反向再译）
    const oldSource = sourceText
    setSourceText(targetText)
    setTargetText(oldSource)
  }, [sourceLang, targetLang, sourceText, targetText])

  // ---------- 复制译文 ----------
  const handleCopy = useCallback(async () => {
    if (!targetText) return
    let ok = false
    try {
      await navigator.clipboard.writeText(targetText)
      ok = true
    } catch {
      // clipboard API 不可用时回退到隐藏 textarea
      try {
        const ta = document.createElement('textarea')
        ta.value = targetText
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        ok = false
      }
    }
    if (ok) {
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
    }
  }, [targetText])

  // ---------- 历史操作 ----------
  const handlePickHistory = useCallback((item: TranslationRecord) => {
    setSourceText(item.sourceText)
    setTargetText(item.targetText)
    setSourceLang(item.sourceLang)
    setTargetLang(item.targetLang)
    setStyle(item.style)
    if (item.providerId) {
      setProviderId(item.providerId)
      setProviders((prev) =>
        prev.some((p) => p.id === item.providerId)
          ? prev
          : [
              ...prev,
              {
                id: item.providerId,
                type: 'openai-compatible',
                name: item.providerName || item.providerId,
                baseUrl: '',
                apiKeys: [],
                models: [],
                enabled: true,
                createdAt: 0
              }
            ]
      )
    }
    setModel(item.model)
    setRunState('done')
    setErrorMsg('')
  }, [])

  const handleDeleteHistory = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      await window.pocketai.deleteTranslation(id)
      setHistory((prev) => prev.filter((h) => h.id !== id))
    },
    []
  )

  const handleClearHistory = useCallback(async () => {
    if (!window.confirm(t('translate.history.clearConfirm'))) return
    await window.pocketai.clearTranslations()
    setHistory([])
  }, [t])

  // ---------- 术语表操作 ----------
  const handleAddTerm = useCallback(
    async (sourceTerm: string, targetTermInput: string) => {
      const s = sourceTerm.trim()
      const tgt = targetTermInput.trim()
      if (!s || !tgt) return
      const term = await window.pocketai.saveGlossaryTerm({ sourceTerm: s, targetTerm: tgt })
      setGlossary((prev) => [...prev, term])
    },
    []
  )

  const handleDeleteTerm = useCallback(async (id: string) => {
    await window.pocketai.deleteGlossaryTerm(id)
    setGlossary((prev) => prev.filter((g) => g.id !== id))
  }, [])

  const running = runState === 'running'
  const longText = sourceText.length > 50_000

  return (
    <div className="flex h-full">
      {/* ---------- 左栏：翻译历史 ---------- */}
      <div className="w-64 shrink-0 border-r border-[var(--color-border)] flex flex-col">
        <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center justify-between">
          <span className="text-xs font-medium">{t('translate.history.title')}</span>
          <button
            className="btn-ghost text-[11px] py-0.5 disabled:opacity-40"
            onClick={handleClearHistory}
            disabled={history.length === 0}
          >
            {t('translate.history.clear')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <div className="p-4 text-xs text-center text-[var(--color-text-muted)]">
              {t('translate.history.empty')}
            </div>
          ) : (
            history.map((h) => (
              <div
                key={h.id}
                className="group px-3 py-2 border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-hover-overlay)]"
                onClick={() => handlePickHistory(h)}
              >
                <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
                  <span>
                    {t(langKey(h.sourceLang))} → {t(langKey(h.targetLang))}
                  </span>
                  <div className="flex items-center gap-1">
                    <span>{fmtTime(h.createdAt)}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-[var(--color-danger)] px-1"
                      title={t('translate.history.delete')}
                      onClick={(e) => handleDeleteHistory(e, h.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <p className="text-xs truncate mt-0.5">{h.sourceText}</p>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ---------- 主工作区 ---------- */}
      <div className="flex-1 flex flex-col min-w-0 p-3 gap-2">
        {/* 控制行 */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input text-xs py-1 w-auto disabled:opacity-50"
            value={sourceLang}
            disabled={running}
            onChange={(e) => setSourceLang(e.target.value as TranslateLang)}
          >
            {SOURCE_LANGS.map((code) => (
              <option key={code} value={code}>
                {t(langKey(code))}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost text-xs py-1 px-2 disabled:opacity-40"
            onClick={handleSwap}
            disabled={running}
            title={t('translate.swap')}
          >
            ⇄
          </button>
          <select
            className="input text-xs py-1 w-auto disabled:opacity-50"
            value={targetLang}
            disabled={running}
            onChange={(e) => setTargetLang(e.target.value as Exclude<TranslateLang, 'auto'>)}
          >
            {TARGET_LANGS.map((code) => (
              <option key={code} value={code}>
                {t(langKey(code))}
              </option>
            ))}
          </select>

          <span className="w-px h-4 bg-[var(--color-border)] mx-1" />

          <select
            className="input text-xs py-1 w-auto max-w-[9rem]"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value)
              const p = enabledProviders.find((x) => x.id === e.target.value)
              setModel(p?.models[0] ?? '')
            }}
          >
            {enabledProviders.length === 0 && (
              <option value="">{t('translate.noProvider')}</option>
            )}
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            className="input text-xs py-1 w-auto max-w-[12rem]"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {modelOptions.length === 0 && (
              <option value="">{t('translate.noModel')}</option>
            )}
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <select
            className="input text-xs py-1 w-auto"
            value={style}
            onChange={(e) => setStyle(e.target.value as TranslateStyle)}
          >
            {STYLES.map((s) => (
              <option key={s} value={s}>
                {t(styleKey(s))}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={glossaryEnabled}
              onChange={(e) => setGlossaryEnabled(e.target.checked)}
            />
            {t('translate.glossary.use')}
          </label>
          <button
            className="btn-ghost text-[11px] py-1"
            onClick={() => setGlossaryOpen(true)}
          >
            {t('translate.glossary.manage', { n: glossary.length })}
          </button>
        </div>

        {/* 双栏文本区 */}
        <div className="flex-1 flex gap-2 min-h-0">
          <div className="flex-1 flex flex-col rounded-md border border-[var(--color-border)] overflow-hidden">
            <textarea
              className="flex-1 resize-none p-3 text-sm bg-transparent outline-none disabled:opacity-60"
              placeholder={t('translate.sourcePlaceholder')}
              value={sourceText}
              disabled={running}
              onChange={(e) => setSourceText(e.target.value)}
            />
            <div className="px-3 py-1 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)] text-right">
              {sourceText.length}
              {longText ? ` · ${t('translate.longTextHint')}` : ''}
            </div>
          </div>
          <div className="flex-1 flex flex-col rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg-secondary)]">
            <div className="flex-1 p-3 text-sm overflow-y-auto whitespace-pre-wrap break-words">
              {targetText || (
                <span className="text-[var(--color-text-muted)]">{t('translate.targetPlaceholder')}</span>
              )}
            </div>
          </div>
        </div>

        {/* 状态/错误行 */}
        {runState === 'error' && errorMsg && (
          <div className="text-[11px] px-2 py-1 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] break-words">
            {errorMsg}
          </div>
        )}

        {/* 操作行 */}
        <div className="flex items-center gap-2">
          {running ? (
            <button
              className="text-xs py-1.5 px-4 rounded-md border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors"
              onClick={handleStop}
            >
              {t('translate.stop')}
            </button>
          ) : (
            <button
              className="btn-primary text-xs py-1.5 px-4"
              onClick={handleTranslate}
              disabled={enabledProviders.length === 0}
            >
              {t('translate.run')}
            </button>
          )}
          <button
            className="btn-ghost text-xs py-1.5 px-3 disabled:opacity-40"
            onClick={handleCopy}
            disabled={!targetText}
          >
            {copied ? t('translate.copied') : t('translate.copy')}
          </button>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {running
              ? t('translate.running')
              : runState === 'aborted'
                ? t('translate.aborted')
                : runState === 'done'
                  ? t('translate.done')
                  : ''}
          </span>
        </div>
      </div>

      {/* ---------- 术语表管理弹层 ---------- */}
      {glossaryOpen && (
        <GlossaryPanel
          terms={glossary}
          onAdd={handleAddTerm}
          onDelete={handleDeleteTerm}
          onClose={() => setGlossaryOpen(false)}
        />
      )}
    </div>
  )
}

/** 术语表管理弹层：条目增删，遮罩点击关闭 */
const GlossaryPanel: React.FC<{
  terms: GlossaryTerm[]
  onAdd: (sourceTerm: string, targetTerm: string) => Promise<void> | void
  onDelete: (id: string) => Promise<void> | void
  onClose: () => void
}> = ({ terms, onAdd, onDelete, onClose }) => {
  const { t } = useI18n()
  const [src, setSrc] = useState('')
  const [tgt, setTgt] = useState('')
  const [addErr, setAddErr] = useState('')

  const canAdd = src.trim().length > 0 && tgt.trim().length > 0

  // 成功后才清空输入框；失败保留用户输入并提示
  const submit = async () => {
    if (!canAdd) return
    try {
      await onAdd(src, tgt)
      setSrc('')
      setTgt('')
      setAddErr('')
    } catch {
      setAddErr(t('translate.glossary.addFail'))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[28rem] max-h-[70vh] flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
          <span className="text-sm font-medium">{t('translate.glossary.title')}</span>
          <button className="btn-ghost text-xs py-0.5 px-2" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {terms.length === 0 ? (
            <p className="text-xs text-center text-[var(--color-text-muted)] py-6">
              {t('translate.glossary.empty')}
            </p>
          ) : (
            terms.map((g) => (
              <div
                key={g.id}
                className="group flex items-center justify-between text-xs px-2 py-1.5 rounded hover:bg-[var(--color-hover-overlay)]"
              >
                <span className="truncate">
                  <span className="text-[var(--color-accent)]">{g.sourceTerm}</span>
                  <span className="mx-1.5 text-[var(--color-text-muted)]">=</span>
                  <span>{g.targetTerm}</span>
                </span>
                <button
                  className="opacity-0 group-hover:opacity-100 text-[var(--color-danger)] px-1"
                  onClick={() => onDelete(g.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <div className="p-3 border-t border-[var(--color-border)] flex items-center gap-1.5">
          <input
            className="input text-xs py-1 flex-1 min-w-0"
            placeholder={t('translate.glossary.sourcePlaceholder')}
            value={src}
            onChange={(e) => setSrc(e.target.value)}
          />
          <span className="text-[var(--color-text-muted)] text-xs">=</span>
          <input
            className="input text-xs py-1 flex-1 min-w-0"
            placeholder={t('translate.glossary.targetPlaceholder')}
            value={tgt}
            onChange={(e) => setTgt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canAdd) void submit()
            }}
          />
          <button
            className="btn-primary text-xs py-1 px-3 disabled:opacity-40"
            disabled={!canAdd}
            onClick={() => void submit()}
          >
            {t('translate.glossary.add')}
          </button>
        </div>
        {addErr && (
          <div className="px-3 pb-2 text-[11px] text-[var(--color-danger)]">{addErr}</div>
        )}
      </div>
    </div>
  )
}
