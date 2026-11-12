// artifact_create 结果卡：文件信息 + 打开/另存为/打开所在目录 + 文字大纲
//
// 三条界面口径：
//  · **不吹"预览成品"**：pptx 只能给文字大纲，文案必须写明「不还原版式」；
//  · 每个 IPC 都判 hasIpcFailed（形状闸门），失败走 toast，不把失败画成成功；
//  · 磁盘文件被外部删掉时，预览/打开会如实说"文件已不在"，不假装还能用。
import React, { useState } from 'react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { errText } from '../../utils/error'
import { hasIpcFailed, ipcFailureText, logIpcError } from '../../utils/ipc'
import { formatBytes } from '../../utils/format'
import { artifactRelPath } from '../../../../shared/artifacts'
import type { ArtifactPreview } from '../../../../shared/types'

interface ArtifactResult {
  id?: unknown
  kind?: unknown
  title?: unknown
  fileName?: unknown
  size?: unknown
  slideCount?: unknown
  reused?: unknown
}

/** 只认 artifact_create 的完整成功形状；解析不出来就当普通工具结果，不硬画成产物卡 */
export function readArtifactResult(content: string): { id: string; kind: 'pptx' | 'md'; fileName: string; title: string; size: number; slideCount: number } | null {
  try {
    const p = JSON.parse(content) as ArtifactResult
    if (typeof p.id !== 'string' || !p.id) return null
    if (typeof p.fileName !== 'string' || !p.fileName) return null
    if (p.kind !== 'pptx' && p.kind !== 'md') return null
    return {
      id: p.id,
      kind: p.kind,
      fileName: p.fileName,
      title: typeof p.title === 'string' && p.title ? p.title : p.fileName,
      size: typeof p.size === 'number' && Number.isFinite(p.size) ? p.size : 0,
      slideCount: typeof p.slideCount === 'number' && Number.isFinite(p.slideCount) ? p.slideCount : 0
    }
  } catch {
    return null
  }
}

export const ArtifactActions: React.FC<{ resultContent: string }> = ({ resultContent }) => {
  const { t } = useI18n()
  const toast = useToast()
  const info = readArtifactResult(resultContent)
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  if (!info) return null
  const relPath = artifactRelPath(info.fileName)
  const missing = preview?.missing === true

  const runFileOp = async (label: string, op: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await op()
      if (hasIpcFailed(res)) {
        toast.error(ipcFailureText(res, t))
        return
      }
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
      logIpcError(label, e)
    } finally {
      setBusy(false)
    }
  }

  const togglePreview = async (): Promise<void> => {
    if (previewOpen) {
      setPreviewOpen(false)
      return
    }
    setPreviewOpen(true)
    if (preview || previewError) return
    setLoading(true)
    try {
      const res = await window.pocketai.previewArtifact(info.id)
      if (hasIpcFailed(res)) {
        setPreviewError(ipcFailureText(res, t))
        return
      }
      if (!res) {
        setPreviewError(t('agent.artifact.outlineEmpty'))
        return
      }
      setPreview(res)
    } catch (e) {
      setPreviewError(errText(e, t('common.unknownError')))
      logIpcError('agent.previewArtifact', e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          {info.kind === 'pptx' ? 'PPTX' : 'MD'}
        </span>
        <span className="truncate text-[13px] font-medium text-[var(--color-text)]" title={info.title}>
          {info.title}
        </span>
        {info.size > 0 && (
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{formatBytes(info.size)}</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
        {info.kind === 'pptx'
          ? t('agent.artifact.pptxHint', { n: info.slideCount })
          : t('agent.artifact.mdHint')}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
        {t('agent.artifact.backupHint')}
      </div>

      {missing && (
        <div role="status" className="mt-1.5 text-[11px] text-[var(--color-danger)]">
          {t('agent.artifact.missing')}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          className="btn-primary text-[11px] px-2 py-1"
          disabled={busy || missing}
          onClick={() =>
            void runFileOp('agent.openFileExternal', () => window.pocketai.openFileExternal(relPath))
          }
        >
          {t('agent.artifact.open')}
        </button>
        <button
          className="btn-ghost text-[11px]"
          disabled={busy || missing}
          onClick={() => void runFileOp('agent.saveFileAs', () => window.pocketai.saveFileAs(relPath))}
        >
          {t('agent.artifact.saveAs')}
        </button>
        <button
          className="btn-ghost text-[11px]"
          disabled={busy || missing}
          onClick={() =>
            void runFileOp('agent.openFileLocation', () => window.pocketai.openFileLocation(relPath))
          }
        >
          {t('agent.artifact.showInFolder')}
        </button>
        <button className="btn-ghost text-[11px]" disabled={loading} onClick={() => void togglePreview()}>
          {previewOpen ? t('agent.artifact.outlineHide') : t('agent.artifact.outline')}
        </button>
      </div>

      {previewOpen && (
        <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
          {loading && (
            <div role="status" className="text-[11px] text-[var(--color-text-muted)]">
              {t('common.loading')}
            </div>
          )}
          {previewError && (
            <div role="status" className="text-[11px] text-[var(--color-danger)]">
              {previewError}
            </div>
          )}
          {preview && !previewError && (
            <>
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {preview.kind === 'pptx' ? t('agent.artifact.outlineNote') : null}
              </div>
              {preview.missing ? (
                <div role="status" className="mt-1 text-[11px] text-[var(--color-danger)]">
                  {t('agent.artifact.missing')}
                </div>
              ) : preview.kind === 'md' ? (
                <>
                  <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-[var(--color-text)]">
                    {preview.markdown ?? ''}
                  </pre>
                  {preview.truncated && (
                    <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                      {t('agent.artifact.mdTruncated')}
                    </div>
                  )}
                </>
              ) : (preview.slides?.length ?? 0) === 0 ? (
                <div role="status" className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  {t('agent.artifact.outlineEmpty')}
                </div>
              ) : (
                <ol className="mt-1 max-h-60 overflow-y-auto space-y-1.5">
                  {preview.slides!.map((s, i) => (
                    <li key={i} className="text-[11px] leading-snug">
                      <div className="font-medium text-[var(--color-text)]">
                        {i + 1}. {s.title || t('agent.artifact.outlineNoTitle')}
                      </div>
                      {s.lines.length > 0 && (
                        <ul className="list-disc pl-4 text-[var(--color-text-muted)]">
                          {s.lines.map((line, j) => (
                            <li key={j}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
