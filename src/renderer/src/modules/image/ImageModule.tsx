// 绘图模块（V2 批次四）
//
// 结构：
//  - 生成配置区：Provider / 模型（datalist + 手输）/ 尺寸 / 提示词（≤4000 字符）+ 生成/停止
//  - 最新结果区：生成成功后的大图 + 元信息
//  - 历史画廊：缩略图网格（主进程 nativeImage 缩略），点击开预览弹窗
//  - 预览弹窗：全图 + 复制提示词 / 重新生成回填 / 另存为 / 打开位置 / 外部打开 / 删除
// 图片文件在 DATA_DIR/images/ 内，打开位置/外部打开直接复用 Files 模块的 openFileLocation/openFileExternal。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ImageListItem,
  ImageRecord,
  ImageSize,
  ProviderRecord
} from '../../../../shared/types'
import { IMAGE_SIZES } from '../../../../shared/types'
import { useI18n } from '../../i18n'

const MAX_PROMPT_CHARS = 4000
const THUMB_MISSING_ICON = '🖼️'

const fmtTime = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export const ImageModule: React.FC = () => {
  const { t } = useI18n()

  // ---------- 配置 ----------
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [prompt, setPrompt] = useState('')

  // ---------- 请求状态 ----------
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------- 结果与历史 ----------
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [latest, setLatest] = useState<ImageRecord | null>(null)
  const [latestDuration, setLatestDuration] = useState(0)
  const [latestDataUrl, setLatestDataUrl] = useState<string | null>(null)
  /** 当前「最新结果」记录 id（防止连续生成后慢响应串图） */
  const latestIdRef = useRef<string | null>(null)
  const [gallery, setGallery] = useState<ImageListItem[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers])
  const activeProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) ?? null,
    [enabledProviders, providerId]
  )
  const previewRecord = useMemo(
    () => gallery.find((g) => g.id === previewId) ?? null,
    [gallery, previewId]
  )
  /** 模型 datalist 候选（图像模型常不在 /models 列表，允许手输） */
  const modelOptions = activeProvider?.models ?? []

  const flash = useCallback((ok: boolean, text: string) => {
    setNotice({ ok, text })
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2600)
  }, [])

  // ---------- 初始加载 ----------
  useEffect(() => {
    window.pocketai.listProviders().then((list) => {
      setProviders(list)
      const first = list.find((p) => p.enabled)
      if (first) setProviderId(first.id)
    })
    window.pocketai.listImages().then(setGallery)
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      // 离开模块时中止进行中的生成
      if (runningRef.current && requestIdRef.current) {
        window.pocketai.abortImage(requestIdRef.current).catch(() => {})
      }
    }
  }, [])

  // ---------- 预览弹窗：懒加载全图 + Esc 关闭 ----------
  useEffect(() => {
    if (!previewId) {
      setPreviewDataUrl(null)
      return
    }
    let alive = true
    setPreviewLoading(true)
    setPreviewDataUrl(null)
    window.pocketai
      .getImageFile(previewId)
      .then((r) => {
        if (alive && r.ok && r.dataUrl) setPreviewDataUrl(r.dataUrl)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setPreviewLoading(false)
      })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
    }
  }, [previewId])

  // ---------- 生成 ----------
  const handleGenerate = useCallback(async () => {
    if (runningRef.current) return
    if (enabledProviders.length === 0) {
      flash(false, t('image.needProvider'))
      return
    }
    if (!providerId) {
      flash(false, t('image.needProvider'))
      return
    }
    if (!model.trim()) {
      flash(false, t('image.needModel'))
      return
    }
    const text = prompt.trim()
    if (!text) {
      flash(false, t('image.errEmptyPrompt'))
      return
    }
    if (text.length > MAX_PROMPT_CHARS) {
      flash(false, t('image.tooLong'))
      return
    }

    setRunning(true)
    runningRef.current = true
    const requestId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    requestIdRef.current = requestId

    const res = await window.pocketai.generateImage({
      requestId,
      providerId,
      model: model.trim(),
      prompt: text,
      size
    })

    runningRef.current = false
    setRunning(false)
    requestIdRef.current = null

    if (res.ok) {
      flash(true, t('image.generateDone'))
      setLatest(res.record)
      setLatestDuration(res.durationMs)
      latestIdRef.current = res.record.id
      setLatestDataUrl(null)
      // 懒加载最新结果大图（校验仍是最新的那次生成，防串图）
      window.pocketai
        .getImageFile(res.record.id)
        .then((r) => {
          if (latestIdRef.current === res.record.id && r.ok && r.dataUrl) {
            setLatestDataUrl(r.dataUrl)
          }
        })
        .catch(() => {})
      window.pocketai.listImages().then(setGallery)
    } else if (res.aborted) {
      flash(false, t('image.aborted'))
    } else {
      flash(false, `${t('image.generateFailed')}: ${res.error}`)
    }
  }, [enabledProviders.length, providerId, model, prompt, size, flash, t])

  const handleStop = useCallback(() => {
    if (requestIdRef.current) window.pocketai.abortImage(requestIdRef.current).catch(() => {})
  }, [])

  // ---------- 历史操作 ----------
  const handleDelete = useCallback(
    async (id: string) => {
      const rec = gallery.find((g) => g.id === id)
      if (!rec) return
      if (!window.confirm(t('image.deleteConfirm'))) return
      const res = await window.pocketai.deleteImage(id)
      if (res.ok) {
        setGallery((prev) => prev.filter((g) => g.id !== id))
        setPreviewId((cur) => (cur === id ? null : cur))
        setLatest((cur) => (cur?.id === id ? null : cur))
      } else {
        flash(false, res.error ?? t('image.generateFailed'))
      }
    },
    [gallery, t, flash]
  )

  const handleRegenerate = useCallback(
    (rec: ImageRecord) => {
      setProviderId(rec.providerId)
      setPrompt(rec.prompt)
      setModel(rec.model)
      if ((IMAGE_SIZES as readonly string[]).includes(rec.size)) setSize(rec.size as ImageSize)
      setPreviewId(null)
      rootRef.current?.scrollTo({ top: 0 })
    },
    []
  )

  const handleCopyPrompt = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
      } catch {
        /* 剪贴板不可用 */
      }
    },
    []
  )

  const canGenerate = !running && providerId !== '' && model.trim() !== ''

  return (
    <div ref={rootRef} className="flex flex-col h-full gap-3 overflow-y-auto">
      {/* ---------- 生成配置区 ---------- */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input text-xs py-1 w-auto"
            value={providerId}
            disabled={running}
            onChange={(e) => {
              setProviderId(e.target.value)
              const p = enabledProviders.find((x) => x.id === e.target.value)
              setModel(p?.models[0] ?? '')
            }}
          >
            {enabledProviders.length === 0 && <option value="">{t('image.noProvider')}</option>}
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.type === 'ollama' ? `（${t('image.ollamaHint')}）` : ''}
              </option>
            ))}
          </select>
          <input
            className="input text-xs py-1 w-52"
            list="image-model-options"
            placeholder={t('image.modelPlaceholder')}
            value={model}
            disabled={running}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="image-model-options">
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <select
            className="input text-xs py-1 w-auto"
            value={size}
            disabled={running}
            onChange={(e) => setSize(e.target.value as ImageSize)}
            title={t('image.sizeHint')}
          >
            {IMAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="relative">
          <textarea
            className="input text-xs py-2 w-full resize-y min-h-[72px]"
            placeholder={t('image.promptPlaceholder')}
            value={prompt}
            disabled={running}
            maxLength={MAX_PROMPT_CHARS + 100}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className="absolute right-2 bottom-1.5 text-[10px] text-[var(--color-text-muted)] pointer-events-none">
            {prompt.length}/{MAX_PROMPT_CHARS}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <button className="btn-ghost text-xs" onClick={handleStop}>
              ⏹ {t('image.stop')}
            </button>
          ) : (
            <button className="btn-primary text-xs" onClick={handleGenerate} disabled={!canGenerate}>
              🎨 {t('image.generate')}
            </button>
          )}
          <span className="text-[11px] text-[var(--color-text-muted)]">{t('image.costHint')}</span>
          {notice && (
            <span
              className={`text-xs px-2 py-1 rounded ${
                notice.ok
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
              }`}
            >
              {notice.text}
            </span>
          )}
        </div>
      </div>

      {/* ---------- 最新结果 ---------- */}
      {latest && (
        <div className="rounded-lg border border-[var(--color-border)] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">{t('image.latest')}</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {latest.model} · {latest.size} · {fmtBytes(latest.bytes)} ·{' '}
              {t('image.duration', { s: (latestDuration / 1000).toFixed(1) })}
            </span>
          </div>
          {latestDataUrl ? (
            <img
              src={latestDataUrl}
              alt={latest.prompt}
              className="max-h-[46vh] max-w-full rounded border border-[var(--color-border)] cursor-zoom-in"
              onClick={() => setPreviewId(latest.id)}
            />
          ) : (
            <div className="h-24 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
              {t('common.loading')}
            </div>
          )}
        </div>
      )}

      {/* ---------- 历史画廊 ---------- */}
      <div className="flex-1 min-h-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium">{t('image.gallery')}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{gallery.length}</span>
        </div>
        {gallery.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center">
            <div className="text-3xl mb-2">{THUMB_MISSING_ICON}</div>
            <p className="text-xs text-[var(--color-text-muted)]">{t('image.empty')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {gallery.map((g) => (
              <div
                key={g.id}
                className="group rounded-lg border border-[var(--color-border)] overflow-hidden cursor-pointer hover:border-[var(--color-accent)] transition-colors bg-[var(--color-bg-secondary)]"
                onClick={() => setPreviewId(g.id)}
              >
                <div className="aspect-square flex items-center justify-center bg-[var(--color-hover-overlay)] overflow-hidden">
                  {g.thumbDataUrl ? (
                    <img src={g.thumbDataUrl} alt={g.prompt} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-2xl">{THUMB_MISSING_ICON}</span>
                  )}
                </div>
                <div className="p-1.5">
                  <p className="text-[11px] truncate" title={g.prompt}>
                    {g.prompt}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{fmtTime(g.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- 预览弹窗 ---------- */}
      {previewRecord && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm"
          onClick={() => setPreviewId(null)}
        >
          <div
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl p-5 max-w-4xl w-[min(860px,92vw)] max-h-[86vh] flex flex-col"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3 shrink-0">
              <div className="min-w-0">
                <p className="text-sm break-words">{previewRecord.prompt}</p>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                  {previewRecord.providerName} · {previewRecord.model} · {previewRecord.size} ·{' '}
                  {fmtBytes(previewRecord.bytes)} · {fmtTime(previewRecord.createdAt)}
                </p>
              </div>
              <button
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none"
                onClick={() => setPreviewId(null)}
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-auto min-h-0 flex items-center justify-center">
              {previewLoading ? (
                <div className="text-xs text-[var(--color-text-muted)] py-8">{t('common.loading')}</div>
              ) : previewDataUrl ? (
                <img
                  src={previewDataUrl}
                  alt={previewRecord.prompt}
                  className="max-w-full max-h-[58vh] rounded border border-[var(--color-border)]"
                />
              ) : (
                <div className="text-center py-8">
                  <div className="text-3xl mb-2">{THUMB_MISSING_ICON}</div>
                  <p className="text-xs text-[var(--color-text-muted)]">{t('image.loadFailed')}</p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 mt-3 pt-3 border-t border-[var(--color-border)] shrink-0">
              <button
                className="btn-ghost text-xs"
                onClick={() => handleCopyPrompt(previewRecord.prompt)}
              >
                {copied ? `✓ ${t('image.copied')}` : `📋 ${t('image.copyPrompt')}`}
              </button>
              <button className="btn-ghost text-xs" onClick={() => handleRegenerate(previewRecord)}>
                ♻ {t('image.regenerate')}
              </button>
              <button
                className="btn-ghost text-xs"
                onClick={async () => {
                  const r = await window.pocketai.saveImageAs(previewRecord.id)
                  if (!r.ok) flash(false, r.error ?? t('image.generateFailed'))
                }}
              >
                💾 {t('image.saveAs')}
              </button>
              <button
                className="btn-ghost text-xs"
                onClick={() => window.pocketai.openFileLocation(previewRecord.fileName)}
              >
                📍 {t('image.openLocation')}
              </button>
              <button
                className="btn-ghost text-xs"
                onClick={() => window.pocketai.openFileExternal(previewRecord.fileName)}
              >
                ↗ {t('image.openExternal')}
              </button>
              <button
                className="btn-ghost text-xs text-[var(--color-danger)]"
                onClick={() => handleDelete(previewRecord.id)}
              >
                🗑 {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
