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
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { useConfirm } from '../../components/ConfirmDialog'

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
  /** 服务商清单那一读失败的原因（§263 第五面）：`error` 为空＝拿到了但形状不对 */
  const [providersUnread, setProvidersUnread] = useState<{ error?: string } | null>(null)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [prompt, setPrompt] = useState('')

  // ---------- 请求状态 ----------
  const [running, setRunning] = useState(false)
  // §266 第六面：这一发过去只有 `.catch(reportIpcError(...))`——而 abort 走 safeHandle，失败是**已 resolve 的 `{ok:false}`**，
  // 那条 catch 根本不会经过 ⇒ 「按了停止、那一发还在跑」在屏上不留一个字。停止键此时仍在（running 没被动过），补一句就够，不再多加一颗键。
  const [stopUnread, setStopUnread] = useState<{ error?: string } | null>(null)
  const { notice, show: showNotice } = useTransientNotice<{ ok: boolean; text: string }>(2600)
  const requestIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  /** 复制提示词的「已复制」反馈（含剪贴板降级与定时器清理） */
  const { copied, copy: copyToClipboard } = useCopyFeedback()
  const { confirm, dialog } = useConfirm()

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
  // §256：这三发读的失败面以前各自被演成别的东西——画廊演成「还没有生成记录」、
  // 预览演成「文件已不存在」、最新结果演成永远转着的「加载中」。
  // 存的是失败对象本身（不是整句），因为这句话要在渲染时才拿 `t` 取兜底文案——
  // 挂载那条 effect 的 cleanup 会中止进行中的生成，不能为了加一个 `t` 依赖而让它重跑。
  const [galleryFail, setGalleryFail] = useState<{ error?: string } | null>(null)
  const [previewFail, setPreviewFail] = useState<{ error?: string } | null>(null)
  const [latestFail, setLatestFail] = useState<{ error?: string } | null>(null)

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers])
  const activeProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) ?? null,
    [enabledProviders, providerId]
  )
  const previewRecord = useMemo(
    () => {
      // §333：latest 刚生成时可能还没进 gallery（刷新在途或失败）⇒ 优先从 gallery 取，取不到再 fallback 到 latest
      if (!previewId) return null
      const fromGallery = gallery.find((g) => g.id === previewId)
      if (fromGallery) return fromGallery
      if (latest?.id === previewId) {
        return { ...latest, thumbDataUrl: latestDataUrl }
      }
      return null
    },
    [gallery, previewId, latest, latestDataUrl]
  )
  /** 模型 datalist 候选（图像模型常不在 /models 列表，允许手输） */
  const modelOptions = activeProvider?.models ?? []

  const flash = useCallback((ok: boolean, text: string) => showNotice({ ok, text }), [showNotice])

  // ---------- 初始加载 ----------
  useEffect(() => {
    window.pocketai.listProviders().then((list) => {
      // §263 第五面：这一支过去只有一句 `return`——第四面算它"接管了"（流程停了），
      // 但 `providers` 停在 `[]`，下拉里摆的是「还没有可用的服务商」（`image.noProvider`）⇒ 把"读不到"演成"一家都没有"。
      if (hasIpcFailed(list)) {
        setProvidersUnread({ error: list.error })
        return
      }
      setProvidersUnread(null)
      setProviders(list)
      const first = list.find((p) => p.enabled)
      if (first) setProviderId(first.id)
    }).catch((e: unknown) => {
      // reject 面同一张脸（旧写法 `.catch(reportIpcError(...))`＝只进 console）
      setProvidersUnread({ error: errText(e, '') })
      logIpcError('image.listProviders', e)
    })
    window.pocketai.listImages().then((v) => {
      if (hasIpcFailed(v)) {
        setGalleryFail(v)
        return
      }
      setGalleryFail(null)
      setGallery(v)
    }).catch((e: unknown) => {
      setGalleryFail({ error: errText(e, '') })
      logIpcError('image.listImages', e)
    })
    return () => {
      // 离开模块时中止进行中的生成；卸载路径上的失败不必打扰用户，但要留痕（§224）
      if (runningRef.current && requestIdRef.current) {
        window.pocketai.abortImage(requestIdRef.current).catch(reportIpcError('image.abortImage'))
      }
    }
  }, [])

  // ---------- 预览弹窗：懒加载全图 + Esc 关闭 ----------
  useEffect(() => {
    if (!previewId) {
      setPreviewDataUrl(null)
      setPreviewFail(null)
      return
    }
    let alive = true
    setPreviewLoading(true)
    setPreviewDataUrl(null)
    setPreviewFail(null)
    window.pocketai
      .getImageFile(previewId)
      .then((r) => {
        if (!alive) return
        if (r.ok && r.dataUrl) {
          setPreviewDataUrl(r.dataUrl)
          return
        }
        // 「成功但没带回文件」不是「读不到」⇒ 这一档留给渲染那边那句「文件已不存在」说
        if (hasIpcFailed(r)) setPreviewFail(r)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setPreviewFail({ error: errText(e, '') })
        logIpcError('image.getPreviewFile', e)
      })
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
    setStopUnread(null) // §266：这是新一轮生成，上一发"停止没送到"不再作数（陈旧谎报要自己退场，§256）
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
      setLatestFail(null)
      // 懒加载最新结果大图（校验仍是最新的那次生成，防串图）
      window.pocketai
        .getImageFile(res.record.id)
        .then((r) => {
          if (latestIdRef.current !== res.record.id) return
          if (r.ok && r.dataUrl) {
            setLatestDataUrl(r.dataUrl)
            return
          }
          if (hasIpcFailed(r)) setLatestFail(r)
        })
        .catch((e: unknown) => {
          if (latestIdRef.current !== res.record.id) return
          setLatestFail({ error: errText(e, '') })
          logIpcError('image.getLatestFile', e)
        })
      // §256 复核：这一发是生成成功之后的「顺带刷新画廊」——那张图与耗时已经在最新结果区摆着、flash 也说了「生成完成」，
      // 画廊只是索引少了这一条。判成设计内静默（同 §255 那发诊断刷新），闸门的单条 if 视角看不见这段理由 ⇒ 继续计数，不为清零改产品码。
      window.pocketai.listImages().then((v) => { if (!hasIpcFailed(v)) setGallery(v) }).catch(reportIpcError('image.refreshGallery'))
    } else if (res.aborted) {
      flash(false, t('image.aborted'))
    } else {
      flash(false, `${t('image.generateFailed')}: ${res.error}`)
    }
  }, [enabledProviders.length, providerId, model, prompt, size, flash, t])

  /** §266：停止指令送没送到，屏上要说一句（两条失败路同一张脸；成功即收回）。不打断界面——running 由那一发的 resolve 收尾 */
  const handleStop = useCallback(() => {
    const id = requestIdRef.current
    if (!id) return
    window.pocketai
      .abortImage(id)
      .then((r) => {
        if (hasIpcFailed(r)) {
          setStopUnread({ error: r.error })
          return
        }
        setStopUnread(null)
      })
      .catch((e: unknown) => {
        setStopUnread({ error: errText(e, '') })
        logIpcError('image.abortImage', e)
      })
  }, [])

  // ---------- 历史操作 ----------
  const handleDelete = useCallback(
    async (id: string) => {
      const rec = gallery.find((g) => g.id === id)
      if (!rec) return
      if (!(await confirm({ message: t('image.deleteConfirm'), danger: true }))) return
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
    (text: string) => {
      void copyToClipboard(text)
    },
    [copyToClipboard]
  )

  const canGenerate =
    !running && providerId !== '' && model.trim() !== '' && prompt.trim().length <= MAX_PROMPT_CHARS

  return (
    <div ref={rootRef} className="flex flex-col h-full gap-3 overflow-y-auto">
      {/* ---------- 生成配置区 ---------- */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
        {/* §263：那一读失败时下拉是空的，但那不是"没有服务商"——这句话要上屏（§222 那张脸，逐发点名 §259） */}
        {providersUnread && (
          <LoadFailNotice what={t('common.providersList')} msg={ipcFailText(providersUnread, t('common.unknownError'))} />
        )}
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
            {enabledProviders.length === 0 && !providersUnread && <option value="">{t('image.noProvider')}</option>}
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
          <span
            className={`absolute right-2 bottom-1.5 text-[10px] pointer-events-none ${
              prompt.length > MAX_PROMPT_CHARS
                ? 'text-[var(--color-danger)] font-medium'
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            {prompt.length}/{MAX_PROMPT_CHARS}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <>
              <button className="btn-ghost text-xs" onClick={handleStop}>
                ⏹ {t('image.stop')}
              </button>
              {/* §266：这句只在 running 为真时在场——它说的就是"这一发可能还在继续"，运行结束后再挂着它就是新的谎 */}
              {stopUnread && (
                <span role="alert" className="text-xs text-[var(--color-danger)]">
                  {t('common.stopNotSent', { msg: ipcFailText(stopUnread, t('common.unknownError')) })}
                </span>
              )}
            </>
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
          ) : latestFail ? (
            <LoadFailNotice msg={ipcFailText(latestFail, t('common.unknownError'))} />
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
          {/* §256：读不到时不报 0——0 会被读成「确实一张都没有」，同 §250 那颗角标的 `?`。
              只在屏上空着的时候说这句：清单一旦到货（生成后那发顺带刷新也会写它）就不该再挂着"读不到"。 */}
          <span className="text-[11px] text-[var(--color-text-muted)]">{gallery.length === 0 && galleryFail ? '?' : gallery.length}</span>
        </div>
        {gallery.length === 0 && galleryFail && <LoadFailNotice msg={ipcFailText(galleryFail, t('common.unknownError'))} />}
        {gallery.length === 0 && !galleryFail ? (
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
              ) : previewFail ? (
                <LoadFailNotice msg={ipcFailText(previewFail, t('common.unknownError'))} />
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
                onClick={async () => {
                  const r = await window.pocketai.openFileLocation(previewRecord.fileName)
                  // §333：失败（文件不在／系统没关联程序）要说原因，不能点了没反应
                  if (!r.ok) flash(false, t('common.opFailed', { msg: r.error ?? t('common.unknownError') }))
                }}
              >
                📍 {t('image.openLocation')}
              </button>
              <button
                className="btn-ghost text-xs"
                onClick={async () => {
                  const r = await window.pocketai.openFileExternal(previewRecord.fileName)
                  if (!r.ok) flash(false, t('common.opFailed', { msg: r.error ?? t('common.unknownError') }))
                }}
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

      {dialog}
    </div>
  )
}
