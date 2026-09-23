// Ollama 便携运行时管理面板：一键安装 → 启动 → 拉取推荐模型 → 自动注册 provider
// 两种密度：向导页 compact（精简引导）/ 设置页 full（含路径与完整操作）
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  OllamaRuntimeStatus,
  OllamaInstallEvent,
  OllamaPullEvent,
  ModelRecommendation
} from '../../../shared/types'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'
import { useTransientNotice } from '../hooks/useTransientNotice'

function formatMB(bytes: number | null | undefined): string {
  if (!bytes) return ''
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`
}

export const OllamaPanel: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useI18n()
  const [status, setStatus] = useState<OllamaRuntimeStatus | null>(null)
  const [installEvt, setInstallEvt] = useState<OllamaInstallEvent | null>(null)
  const [installing, setInstalling] = useState(false)
  const [err, setErr] = useState('')
  const [starting, setStarting] = useState(false)
  const [pullEvt, setPullEvt] = useState<OllamaPullEvent | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const { notice: pullDone, show: markPullDone, clear: clearPullDone } = useTransientNotice<string>(4000)
  const [customModel, setCustomModel] = useState('')
  const [rec, setRec] = useState<ModelRecommendation | null>(null)
  const [mirror, setMirror] = useState('')
  const [mirrorDraft, setMirrorDraft] = useState('')
  const { notice: mirrorSaved, show: markMirrorSaved } = useTransientNotice<boolean>(2000)
  // handleStop 的延时回调：组件卸载后必须清理，避免对已卸载组件 setState
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    window.pocketai.getOllamaStatus().then(setStatus).catch(reportIpcError('ollama.getStatus'))
  }, [])

  useEffect(() => {
    refresh()
    window.pocketai.getOllamaMirror().then((r) => {
      if (r.ok && r.mirror != null) {
        setMirror(r.mirror)
        setMirrorDraft(r.mirror)
      }
    }).catch(reportIpcError('ollama.getMirror'))
    const off1 = window.pocketai.onOllamaInstallEvent((e) => setInstallEvt(e))
    const off2 = window.pocketai.onOllamaPullEvent((e) => setPullEvt(e))
    const timer = setInterval(refresh, 8000) // 兜底轮询（外部启停/系统 ollama 变化）
    return () => {
      off1()
      off2()
      clearInterval(timer)
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
    }
  }, [refresh])

  useEffect(() => {
    window.pocketai
      .recommendModels()
      .then((r) => r.ok && r.data && setRec(r.data))
      .catch(reportIpcError('ollama.recommendModels'))
  }, [])

  async function handleInstall() {
    setErr('')
    setInstalling(true)
    setInstallEvt({ stage: 'download', percent: 0 })
    try {
      const finalStatus = await window.pocketai.installOllama()
      setStatus(finalStatus)
      // 安装成功后自动启动
      setStarting(true)
      const r = await window.pocketai.startOllama()
      if (r.status) setStatus(r.status)
      else refresh()
    } catch (e) {
      setErr(errText(e, t('ollama.installFailed')))
    } finally {
      setInstalling(false)
      setStarting(false)
    }
  }

  async function handleStart() {
    setErr('')
    setStarting(true)
    try {
      const r = await window.pocketai.startOllama()
      if (r.ok && r.status) setStatus(r.status)
      else if (!r.ok) setErr(r.error || 'start failed')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setStarting(false)
    }
  }

  async function handleStop() {
    try {
      await window.pocketai.stopOllama()
    } catch (e) {
      // stopOllama reject（通道失败/进程已退出）必须兜底，否则 unhandled 且 refresh 不执行
      setErr(errText(e))
    }
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    stopTimerRef.current = setTimeout(() => {
      stopTimerRef.current = null
      refresh()
    }, 800)
  }

  /** @returns 是否拉取成功（调用方据此决定是否清空输入框） */
  async function pull(model: string): Promise<boolean> {
    const name = model.trim()
    if (!name || pulling) return false
    setErr('')
    clearPullDone()
    setPulling(name)
    setPullEvt({ model: name, status: '', percent: 0, done: false })
    try {
      const r = await window.pocketai.pullOllamaModel(name)
      if (r.ok) {
        markPullDone(name)
        refresh()
        return true
      }
      setErr(`${name}: ${r.error}`)
      return false
    } catch (e) {
      // IPC 层 reject（主进程异常/通道失败）：必须复位 pulling，否则按钮永久卡在拉取中
      setErr(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setPulling(null)
    }
  }

  const stageText = (e: OllamaInstallEvent | null): string => {
    if (!e) return ''
    if (e.stage === 'download') return t('ollama.stageDownload')
    if (e.stage === 'extract') return t('ollama.stageExtract')
    if (e.stage === 'verify') return t('ollama.stageVerify')
    return t('ollama.stageDone')
  }

  // 推荐里排除纯向量模型单独标注，其余作为对话模型快捷拉取
  const chatPicks = (rec?.localPicks ?? []).filter((p) => p.tag !== '向量').slice(0, 3)
  const embedPick = (rec?.localPicks ?? []).find((p) => p.tag === '向量')

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-base leading-none">🦙</span>
        <span className="text-xs font-semibold text-[var(--color-text)]">{t('ollama.title')}</span>
        {status?.running && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-success)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
            {status.source === 'portable' ? t('ollama.portableSource') : t('ollama.systemSource')}
            {status.version ? ` · ${status.version}` : ''}
          </span>
        )}
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('ollama.desc')}</p>

      {/* 平台不支持 */}
      {status && !status.platformSupported && (
        <p className="text-[11px] text-[var(--color-warning)] leading-relaxed">⚠️ {t('ollama.unsupported')}</p>
      )}

      {/* 安装进度 */}
      {(installing || starting) && (
        <div className="space-y-1">
          <div className="h-2 rounded bg-[var(--color-hover-overlay)] overflow-hidden">
            <div
              className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
              style={{ width: `${starting ? 100 : Math.max(2, installEvt?.percent ?? 0)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>{starting ? t('ollama.starting') : stageText(installEvt)}</span>
            {!starting && installEvt?.stage === 'download' && (
              <span>
                {formatMB(installEvt.receivedBytes)} / {formatMB(installEvt.totalBytes)} ·{' '}
                {installEvt.percent.toFixed(0)}%
              </span>
            )}
          </div>
        </div>
      )}

      {/* 操作区 */}
      {status && status.platformSupported && !status.running && !installing && (
        <div className="flex flex-wrap items-center gap-2">
          {!status.installed && (
            <button className="btn-primary text-xs px-3 py-1.5" onClick={handleInstall}>
              ⬇️ {t('ollama.install')}
            </button>
          )}
          {status.installed && (
            <button className="btn-primary text-xs px-3 py-1.5" onClick={handleStart} disabled={starting}>
              ▶️ {t('ollama.start')}
            </button>
          )}
          <span className="text-[10px] text-[var(--color-text-muted)]">{t('ollama.sizeHint')}</span>
        </div>
      )}

      {/* 下载镜像（国内加速）；仅未安装时需要 */}
      {status && status.platformSupported && !status.installed && !installing && (
        <details className="text-[10px] text-[var(--color-text-muted)]">
          <summary className="cursor-pointer select-none hover:text-[var(--color-text)]">
            {t('ollama.mirror')}
          </summary>
          <div className="mt-1.5 flex gap-1.5">
            <input
              className="input flex-1 py-1 text-[10px]"
              placeholder={t('ollama.mirrorPh')}
              value={mirrorDraft}
              onChange={(e) => setMirrorDraft(e.target.value)}
            />
            <button
              className="shrink-0 px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text)]"
              onClick={async () => {
                try {
                  const r = await window.pocketai.setOllamaMirror(mirrorDraft)
                  if (r.ok) {
                    setMirror(mirrorDraft.trim())
                    markMirrorSaved(true)
                  } else {
                    setErr(r.error || 'bad mirror')
                  }
                } catch (e) {
                  // IPC reject 必须兜底，否则 unhandled 且用户无反馈
                  setErr(errText(e))
                }
              }}
            >
              {t('ollama.mirrorSave')}
            </button>
          </div>
          <div className="mt-1 leading-relaxed">
            {mirror ? t('ollama.mirrorOn') : t('ollama.mirrorHint')}
            {mirrorSaved && <span className="text-[var(--color-success)]"> ✓ {t('ollama.mirrorSaved')}</span>}
          </div>
        </details>
      )}

      {status?.running && status.source === 'portable' && (
        <div className="flex items-center gap-2">
          <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={handleStop}>
            ⏹️ {t('ollama.stop')}
          </button>
        </div>
      )}

      {/* 已安装模型 + 拉取 */}
      {status?.running && (
        <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
          <div className="flex flex-wrap gap-1.5">
            {status.models.length === 0 && (
              <span className="text-[11px] text-[var(--color-text-muted)]">{t('ollama.noModels')}</span>
            )}
            {status.models.map((m) => (
              <span key={m} className="px-2 py-0.5 rounded bg-[var(--color-hover-overlay)] text-[10px] font-mono text-[var(--color-text)]">
                {m}
              </span>
            ))}
          </div>

          {/* 推荐模型快捷按钮 */}
          {chatPicks.length > 0 && (
            <div>
              <div className="text-[10px] text-[var(--color-text-muted)] mb-1">{rec?.tier ? `（${rec.tier}）${t('ollama.recommend')}` : t('ollama.recommend')}</div>
              <div className="flex flex-wrap gap-1.5">
                {chatPicks.map((p) => (
                  <button
                    key={p.id}
                    disabled={!!pulling || p.installed}
                    title={p.reason}
                    onClick={() => pull(p.id)}
                    className={`text-[10px] px-2 py-1 rounded border font-mono ${
                      p.installed
                        ? 'border-[var(--color-success)] text-[var(--color-success)] cursor-default'
                        : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-50'
                    }`}
                  >
                    {p.installed ? '✓ ' : '⬇️ '}
                    {p.id}
                  </button>
                ))}
                {embedPick && (
                  <button
                    disabled={!!pulling || embedPick.installed}
                    title={embedPick.reason}
                    onClick={() => pull(embedPick.id)}
                    className={`text-[10px] px-2 py-1 rounded border font-mono ${
                      embedPick.installed
                        ? 'border-[var(--color-success)] text-[var(--color-success)] cursor-default'
                        : 'border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] disabled:opacity-50'
                    }`}
                  >
                    {embedPick.installed ? '✓ ' : '⬇️ '}
                    {embedPick.id}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 自定义拉取 */}
          <div className="flex gap-1.5">
            <input
              className="input flex-1 py-1 text-[11px]"
              placeholder={t('ollama.pullPlaceholder')}
              value={customModel}
              disabled={!!pulling}
              onChange={(e) => setCustomModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void pull(customModel).then((ok) => { if (ok) setCustomModel('') })}
            />
            {pulling ? (
              <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-warning)]"
                onClick={() => window.pocketai.abortOllamaPull()}>
                ✕ {t('ollama.abort')}
              </button>
            ) : (
              <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]"
                onClick={() => void pull(customModel).then((ok) => { if (ok) setCustomModel('') })}>
                {t('ollama.pullBtn')}
              </button>
            )}
          </div>

          {/* pull 进度 */}
      {pulling && pullEvt && (
            <div className="space-y-1">
              <div className="h-1.5 rounded bg-[var(--color-hover-overlay)] overflow-hidden">
                <div className="h-full bg-[var(--color-accent)] transition-[width] duration-200" style={{ width: `${pullEvt.percent}%` }} />
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {t('ollama.pulling')} {pulling} · {pullEvt.status} · {pullEvt.percent.toFixed(0)}%
              </div>
            </div>
          )}
          {pullDone && <div className="text-[11px] text-[var(--color-success)]">✓ {t('ollama.pullDone')}：{pullDone}</div>}
        </div>
      )}

      {err && <div className="text-[11px] text-[var(--color-danger)] leading-relaxed">⚠️ {err}</div>}

      {!compact && status?.installed && (
        <div className="text-[10px] text-[var(--color-text-muted)] pt-1 border-t border-[var(--color-border)] space-y-0.5">
          <div>{t('ollama.modelsDir')}: <span className="font-mono">{status.modelsDir}</span></div>
        </div>
      )}
    </div>
  )
}
