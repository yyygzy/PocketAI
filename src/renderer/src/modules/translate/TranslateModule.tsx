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
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { hasIpcFailed, ipcFailureText, ipcFailText, isIpcFail, logIpcError, reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/ToastProvider'

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
  const toast = useToast()

  // ---------- 配置 ----------
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  /** 服务商清单那一读失败的原因（§263 第五面）：`error` 为空＝拿到了但形状不对 */
  const [providersUnread, setProvidersUnread] = useState<{ error?: string } | null>(null)
  /** §266 第六面：停止那一发过去只有 `.catch(reportIpcError(...))`——abort 走 safeHandle，失败是已 resolve 的 `{ok:false}`，
   *  那条 catch 不会经过 ⇒「按了停止、这一发还在跑」屏上零字。停止键此时仍在，补一句即可 */
  const [stopUnread, setStopUnread] = useState<{ error?: string } | null>(null)
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
  /** 复制译文反馈（含剪贴板降级与定时器清理） */
  const { copied, copy: copyToClipboard } = useCopyFeedback()
  const { confirm, dialog } = useConfirm()
  const requestIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  // delta rAF 合批：长文本流式时单帧内的多个 chunk 合并为一次 setState
  const deltaBufRef = useRef('')
  const rafRef = useRef<number | null>(null)

  // ---------- 历史 ----------
  const [history, setHistory] = useState<TranslationRecord[]>([])
  /** §269：历史那一读的两发（挂载与"翻译成功后刷新"）共用这一张脸——它们是同一份屏上数据，不是两发各挂一句 */
  const [historyUnread, setHistoryUnread] = useState<{ error?: string } | null>(null)

  // ---------- 术语表 ----------
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([])
  /** §269：术语表读不到时，「术语表（0 条）」那颗按钮与面板里的「还没有术语条目」都会把通道故障演成"你一个都没录" */
  const [glossaryUnread, setGlossaryUnread] = useState<{ error?: string } | null>(null)
  const [glossaryEnabled, setGlossaryEnabled] = useState(false)
  const [glossaryOpen, setGlossaryOpen] = useState(false)

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers])
  const activeProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) ?? null,
    [enabledProviders, providerId]
  )
  /**
   * 当前选中但已停用（或已删除）的 provider：回填历史时需要保留显示，
   * 否则下拉无匹配项会空白；以禁用选项呈现「名称（已停用）」
   */
  const disabledSelectedProvider = useMemo(
    () => (activeProvider ? null : providers.find((p) => p.id === providerId) ?? null),
    [activeProvider, providers, providerId]
  )
  /** 模型下拉候选；回填历史时模型可能已不在缓存列表，补一条避免空选 */
  const modelOptions = useMemo(() => {
    const list = activeProvider?.models ?? []
    if (model && !list.includes(model)) return [model, ...list]
    return list
  }, [activeProvider, model])

  // ---------- 清单两发读（§269）：两条失败路各写原因、读到即收回；失败侧保持上一份 ----------
  /**
   * 历史那一读有**两个调用点**（挂载与「翻译成功后刷新」），共用同一张脸：
   * 它们写的是同一份屏上数据，分两句就成了"同一件事说两遍"，而不是"一发挂掉不替另一发闭嘴"。
   */
  const loadHistory = useCallback(() => {
    window.pocketai.listTranslations()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setHistoryUnread({ error: v.error })
          return
        }
        setHistoryUnread(null)
        setHistory(v)
      })
      .catch((e: unknown) => {
        setHistoryUnread({ error: errText(e, '') })
        logIpcError('translate.listTranslations', e)
      })
  }, [])

  const loadGlossary = useCallback(() => {
    window.pocketai.listGlossary()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setGlossaryUnread({ error: v.error })
          return
        }
        setGlossaryUnread(null)
        setGlossary(v)
      })
      .catch((e: unknown) => {
        setGlossaryUnread({ error: errText(e, '') })
        logIpcError('translate.listGlossary', e)
      })
  }, [])

  // ---------- 初始加载 ----------
  // §355：这一发从挂载 effect 体内联提成具名 loader（依赖照旧 `[]`），让那张「读不到」有出口
  const loadProviders = useCallback(() => {
    window.pocketai.listProviders().then((list) => {
      // §263 第五面：过去这一支只有一句 `return`，`providers` 停在 `[]` ⇒ 下拉里摆「还没有可用的服务商」，
      // 把"读不到"演成"一家都没有"（那两发清单读在 §269 收了口，见上面的 loadHistory／loadGlossary）。
      if (hasIpcFailed(list)) {
        setProvidersUnread({ error: list.error })
        return
      }
      setProvidersUnread(null)
      setProviders(list)
      const first = list.find((p) => p.enabled)
      if (first) {
        setProviderId(first.id)
        if (first.models[0]) setModel(first.models[0])
      }
    }).catch((e: unknown) => {
      setProvidersUnread({ error: errText(e, '') })
      logIpcError('translate.listProviders', e)
    })
  }, [])

  useEffect(() => {
    loadProviders()
    loadHistory()
    loadGlossary()
    // 三发都是挂载那一次的读；三根 loader 都是 useCallback([]) ⇒ 依赖恒稳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 流式增量订阅（rAF 合批） ----------
  useEffect(() => {
    const flush = () => {
      rafRef.current = null
      const buf = deltaBufRef.current
      if (buf) {
        deltaBufRef.current = ''
        setTargetText((prev) => prev + buf)
      }
    }
    const off = window.pocketai.onTranslateChunk((e) => {
      if (e.requestId !== requestIdRef.current) return
      deltaBufRef.current += e.delta
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush)
    })
    return () => {
      off()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      deltaBufRef.current = ''
      // 离开模块时中止进行中的翻译；卸载路径上的失败不必打扰用户，但要留痕（§224）
      if (runningRef.current && requestIdRef.current) {
        window.pocketai.abortTranslate(requestIdRef.current).catch(reportIpcError('translate.abortTranslate'))
      }
    }
  }, [])

  /** §269：翻译成功后刷新历史——过去这一支 `if (!hasIpcFailed(v)) setHistory(v)` 失败时什么都不做，
   *  屏上留着**上一份**历史且零字（"刚翻完那条没进列表"看着像"没翻成"）。现在同一张脸，说话即可 */
  const reloadHistory = loadHistory

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
    setStopUnread(null) // §266：新一轮翻译，上一发"停止没送到"不再作数（陈旧谎报要自己退场，§256）
    setRunState('running')
    // 清掉上一轮残留的合批缓冲，避免旧 chunk 拼到新译文
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    deltaBufRef.current = ''
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

  /** §266：停止指令送没送到要说一句（两条失败路同一张脸；成功即收回）。不打断界面——runState 由那一发的 resolve 收尾 */
  const handleStop = useCallback(() => {
    const id = requestIdRef.current
    if (!id) return
    window.pocketai
      .abortTranslate(id)
      .then((r) => {
        if (hasIpcFailed(r)) {
          setStopUnread({ error: r.error })
          return
        }
        setStopUnread(null)
      })
      .catch((e: unknown) => {
        setStopUnread({ error: errText(e, '') })
        logIpcError('translate.abortTranslate', e)
      })
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
  const handleCopy = useCallback(() => {
    void copyToClipboard(targetText)
  }, [copyToClipboard, targetText])

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
                // 已删除的 provider：以「已停用」补位展示，不进入可发起翻译的启用列表
                enabled: false,
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
      const r = await window.pocketai.deleteTranslation(id)
      // §217：失败不判就本地过滤掉 ⇒ 那条只是看不见了，切回模块又回来
      if (isIpcFail(r)) {
        toast.error(ipcFailureText(r, t) || t('common.unknownError'))
        return
      }
      setHistory((prev) => prev.filter((h) => h.id !== id))
    },
    [t, toast]
  )

  const handleClearHistory = useCallback(async () => {
    if (!(await confirm({ message: t('translate.history.clearConfirm'), danger: true }))) return
    const r = await window.pocketai.clearTranslations()
    if (isIpcFail(r)) {
      toast.error(ipcFailureText(r, t) || t('common.unknownError'))
      return
    }
    setHistory([])
  }, [t, toast])

  // ---------- 术语表操作 ----------
  // 返回值是"有没有真的加上"：safeHandle 把失败转成** resolve 的 {ok:false} **，
  // 面板那边只 catch 得住 reject ⇒ 不把这个布尔传出去，失败路径会照常清空输入框（V4-Iter-211）。
  const handleAddTerm = useCallback(
    async (sourceTerm: string, targetTermInput: string): Promise<boolean> => {
      const s = sourceTerm.trim()
      const tgt = targetTermInput.trim()
      if (!s || !tgt) return false
      const term = await window.pocketai.saveGlossaryTerm({ sourceTerm: s, targetTerm: tgt })
      // 记录型通道：safeHandle 把抛错转成 `{ok:false,error}` **返回值**而不是 rejection。
      // 不判就是把一个失败对象当词条 append 进列表——列表多出一行库里并不存在的词条。
      if (isIpcFail(term)) {
        toast.error(ipcFailureText(term, t) || t('common.unknownError'))
        return false
      }
      setGlossary((prev) => [...prev, term])
      return true
    },
    [t, toast]
  )

  const handleDeleteTerm = useCallback(async (id: string) => {
    const r = await window.pocketai.deleteGlossaryTerm(id)
    if (isIpcFail(r)) {
      toast.error(ipcFailureText(r, t) || t('common.unknownError'))
      return
    }
    setGlossary((prev) => prev.filter((g) => g.id !== id))
  }, [t, toast])

  const running = runState === 'running'
  /**
   * §269：术语表那一读失败时那一句＋那颗重试键——**遮罩内外共用同一份**（源码里只此一处），
   * 面板打开时挂进面板、关闭时挂进工具条 ⇒ 同一时刻只有一句、只有一颗键。
   * 键放在 alert 盒子外面（§268 的口径：盒子里的话会被算进句子的 textContent）。
   */
  const glossaryFailLine = glossaryUnread ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span role="alert" className="text-[11px] text-[var(--color-danger)]">
        {t('common.loadFailedNamed', {
          what: t('common.glossaryList'),
          msg: ipcFailText(glossaryUnread, t('common.unknownError'))
        })}
      </span>
      <button
        data-testid="translate-glossary-retry"
        className="text-[11px] underline text-[var(--color-text-muted)]"
        onClick={loadGlossary}
      >
        {t('agent.retryRead')}
      </button>
    </span>
  ) : null

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
          {/* §269：那句挂在历史本来要上屏的地方；重试键放在 alert 盒子**外面**（§268 的口径：盒子里的话会被算进句子的 textContent） */}
          {historyUnread && (
            <div className="px-3 py-2 flex flex-col gap-1.5">
              <LoadFailNotice what={t('translate.history.title')} msg={ipcFailText(historyUnread, t('common.unknownError'))} />
              <button
                data-testid="translate-history-retry"
                className="self-start text-xs underline text-[var(--color-text-muted)]"
                onClick={loadHistory}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
          {history.length === 0 && !historyUnread ? (
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

          {/* §263：服务商那一读没读到就直接说，别让它长成"一家都没有" */}
          {providersUnread && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <LoadFailNotice what={t('common.providersList')} msg={ipcFailText(providersUnread, t('common.unknownError'))} />
              {/* §355：那一读失败时下拉里只剩「没有可用的服务商」，而改选择／按翻译都不会重发这一发 */}
              <button data-testid="translate-providers-read-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={loadProviders}>
                {t('agent.retryRead')}
              </button>
            </div>
          )}
          <select
            className="input text-xs py-1 w-auto max-w-[9rem]"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value)
              const p = enabledProviders.find((x) => x.id === e.target.value)
              setModel(p?.models[0] ?? '')
            }}
          >
            {enabledProviders.length === 0 && !disabledSelectedProvider && !providersUnread && (
              <option value="">{t('translate.noProvider')}</option>
            )}
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {/* 回填历史：原 provider 已停用/已删除时以禁用选项保留显示 */}
            {disabledSelectedProvider && (
              <option value={disabledSelectedProvider.id} disabled>
                {disabledSelectedProvider.name} {t('translate.providerDisabled')}
              </option>
            )}
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
            {/* §269：读不到就**不许报条数**——「术语表（0 条）」是把通道故障演成"你一个都没录"的那张嘴 */}
            {glossaryUnread ? t('translate.glossary.title') : t('translate.glossary.manage', { n: glossary.length })}
          </button>
          {!glossaryOpen && glossaryFailLine}
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
            <>
              <button
                className="text-xs py-1.5 px-4 rounded-md border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors"
                onClick={handleStop}
              >
                {t('translate.stop')}
              </button>
              {/* §266：只在 running 为真时在场——这句说的就是"这一发可能还在继续"，那一发结束后再挂着它就是新的谎 */}
              {stopUnread && (
                <span role="alert" className="text-xs text-[var(--color-danger)]">
                  {t('common.stopNotSent', { msg: ipcFailText(stopUnread, t('common.unknownError')) })}
                </span>
              )}
            </>
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
          failLine={glossaryFailLine}
          onAdd={handleAddTerm}
          onDelete={handleDeleteTerm}
          onClose={() => setGlossaryOpen(false)}
        />
      )}

      {dialog}
    </div>
  )
}

/** 术语表管理弹层：条目增删，遮罩点击关闭 */
const GlossaryPanel: React.FC<{
  terms: GlossaryTerm[]
  /** §269：那一读失败时这块的「还没有术语条目」是第二张谎脸 ⇒ 让位给父级那份失败句（同一时刻只有一句、一颗键） */
  failLine: React.ReactNode
  onAdd: (sourceTerm: string, targetTerm: string) => Promise<boolean>
  onDelete: (id: string) => Promise<void> | void
  onClose: () => void
}> = ({ terms, failLine, onAdd, onDelete, onClose }) => {
  const { t } = useI18n()
  const [src, setSrc] = useState('')
  const [tgt, setTgt] = useState('')
  const [addErr, setAddErr] = useState('')

  const canAdd = src.trim().length > 0 && tgt.trim().length > 0

  // 成功后才清空输入框；失败保留用户输入并提示
  const submit = async () => {
    if (!canAdd) return
    try {
      if (!(await onAdd(src, tgt))) return
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
          {/* §269：这一块的「还没有术语条目」在通道故障时是第二张谎脸 ⇒ 让位给**同一份**失败句（遮罩外那份此时收掉了，
              同一时刻屏上只有一句、一颗键；不再造第二颗机关——§268 那条"两头钉"的口径：该有机关的数量要数得出，不该有的地方要为 0） */}
          {terms.length === 0 ? (
            failLine ?? (
              <p className="text-xs text-center text-[var(--color-text-muted)] py-6">
                {t('translate.glossary.empty')}
              </p>
            )
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
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && canAdd) void submit()
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
