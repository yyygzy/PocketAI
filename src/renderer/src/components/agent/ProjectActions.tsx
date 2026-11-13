// 多文件项目卡片（v70）：产物是**文件夹**，不是一个文件。
//
// 入口判定：根目录有 index.html → 沙箱 iframe 预览（allow-scripts + CSP）；
// 否则有 README.md → 直接显示正文；都没有 → 只列文件清单。
// 不承诺整站预览：css/js/图片没有本地静态服务，iframe 只看入口 HTML 自身。
import { useState } from 'react'
import { useI18n } from '../../i18n'
import { formatBytes } from '../../utils/format'
import { errText } from '../../utils/error'
import { hasIpcFailed, ipcFailureText } from '../../utils/ipc'
import { injectCsp } from '../../lib/html-csp'
import type { ProjectPreview } from '../../../../shared/types'

interface ProjectResult {
  ok?: unknown
  id?: unknown
  name?: unknown
  dirName?: unknown
  relPath?: unknown
  fileCount?: unknown
  totalBytes?: unknown
  reused?: unknown
}

export interface ParsedProjectResult {
  id: string
  name: string
  relPath: string
  fileCount: number
  totalBytes: number
}

/** 只认 project_create 的完整成功形状；解析不出来就回退普通文本结果 */
export function readProjectResult(content: string): ParsedProjectResult | null {
  try {
    const p = JSON.parse(content) as ProjectResult
    if (p.ok !== true) return null
    if (typeof p.id !== 'string' || !p.id) return null
    if (typeof p.relPath !== 'string' || !p.relPath) return null
    return {
      id: p.id,
      name: typeof p.name === 'string' && p.name ? p.name : p.id,
      relPath: p.relPath,
      fileCount: typeof p.fileCount === 'number' && Number.isFinite(p.fileCount) ? p.fileCount : 0,
      totalBytes: typeof p.totalBytes === 'number' && Number.isFinite(p.totalBytes) ? p.totalBytes : 0
    }
  } catch {
    return null
  }
}

/** 工作目录项目只认 `location:'workspace'` 这一种成功形状（没有 id/relPath，也不进 projects 表） */
export interface ParsedWorkspaceProject {
  name: string
  dirAbs: string
  fileCount: number
  totalBytes: number
}

export function readWorkspaceProjectResult(content: string): ParsedWorkspaceProject | null {
  try {
    const p = JSON.parse(content) as ProjectResult & { location?: unknown; dirAbs?: unknown }
    if (p.ok !== true || p.location !== 'workspace') return null
    if (typeof p.dirAbs !== 'string' || !p.dirAbs) return null
    return {
      name: typeof p.name === 'string' && p.name ? p.name : p.dirAbs,
      dirAbs: p.dirAbs,
      fileCount: typeof p.fileCount === 'number' && Number.isFinite(p.fileCount) ? p.fileCount : 0,
      totalBytes: typeof p.totalBytes === 'number' && Number.isFinite(p.totalBytes) ? p.totalBytes : 0
    }
  } catch {
    return null
  }
}

export function ProjectActions({ resultContent }: { resultContent: string }) {
  const { t } = useI18n()
  const info = readProjectResult(resultContent)
  const workspace = info ? null : readWorkspaceProjectResult(resultContent)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<ProjectPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [deleted, setDeleted] = useState(false)

  if (!info && !workspace) return null
  // 工作目录项目：只给「打开所在目录 / 导出 ZIP」，不承诺预览与撤销
  if (workspace) return <WorkspaceProjectCard info={workspace} />
  if (!info) return null

  const run = async (fn: () => Promise<void>, failMessage: string): Promise<void> => {
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setError(`${failMessage}：${errText(e)}`)
    }
  }

  const togglePreview = (): void => {
    if (previewOpen) {
      setPreviewOpen(false)
      return
    }
    setPreviewOpen(true)
    if (preview) return
    setLoading(true)
    void run(async () => {
      const p = await window.pocketai.previewProject(info.id)
      if (!p) {
        setError(t('agent.project.previewFailed'))
        return
      }
      setPreview(p)
    }, t('agent.project.previewFailed')).finally(() => setLoading(false))
  }

  const exportZip = (): void => {
    void run(async () => {
      const res = await window.pocketai.exportProjectZip(info.id)
      if (!res.ok || !res.relPath) {
        setError(`${t('agent.project.exportFailed')}${res.message ? `：${res.message}` : ''}`)
        return
      }
      const saved = await window.pocketai.saveFileAs(res.relPath)
      if (!saved.ok) {
        setError(`${t('agent.project.exportFailed')}${saved.error ? `：${saved.error}` : ''}`)
        return
      }
      setNotice(t('agent.project.exported'))
    }, t('agent.project.exportFailed'))
  }

  const undo = (): void => {
    void run(async () => {
      const res = await window.pocketai.deleteProject(info.id)
      if (!res.ok) {
        if (res.code === 'SNAPSHOT_DIVERGED') {
          setError(`${t('agent.project.undoDiverged')}${res.path ? `（${res.path}）` : ''}`)
        } else if (res.code === 'PROJECT_NOT_FOUND') {
          setError(`${t('agent.project.undoMissing')}${res.path ? `（${res.path}）` : ''}`)
        } else {
          setError(`${t('agent.project.undoFailed')}${res.path ? `（${res.path}）` : ''}`)
        }
        return
      }
      setDeleted(true)
      setPreviewOpen(false)
      setPreview(null)
      setNotice(t('agent.project.undone'))
    }, t('agent.project.undoFailed'))
  }

  return (
    <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-accent)]">
          PROJECT
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">
          {info.name}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
          {formatBytes(info.totalBytes)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
        {t('agent.project.folderHint', { n: info.fileCount })}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
        {t('agent.project.folderNotFile')}
      </div>

      {deleted && (
        <div role="status" className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          {t('agent.project.deleted')}
        </div>
      )}
      {error && (
        <div role="status" className="mt-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="mt-1.5 text-[11px] text-[var(--color-success)]">
          {notice}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          className="btn-primary px-2 py-1 text-[11px]"
          disabled={deleted}
          onClick={() =>
            void run(async () => {
              const res = await window.pocketai.openFileLocation(info.relPath)
              if (!res.ok) setError(`${t('agent.project.openFailed')}${res.error ? `：${res.error}` : ''}`)
            }, 'agent.project.openFailed')
          }
        >
          {t('agent.project.openFolder')}
        </button>
        <button className="btn-ghost text-[11px]" disabled={deleted} onClick={exportZip}>
          {t('agent.project.exportZip')}
        </button>
        <button className="btn-ghost text-[11px]" disabled={deleted} onClick={togglePreview}>
          {previewOpen ? t('agent.project.previewHide') : t('agent.project.preview')}
        </button>
        {confirmUndo ? (
          <>
            <button className="btn-ghost text-[11px] text-[var(--color-danger)]" disabled={deleted} onClick={undo}>
              {t('agent.project.undoConfirm')}
            </button>
            <button
              className="btn-ghost text-[11px]"
              onClick={() => setConfirmUndo(false)}
            >
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <button className="btn-ghost text-[11px]" disabled={deleted} onClick={() => setConfirmUndo(true)}>
            {t('agent.project.undo')}
          </button>
        )}
      </div>

      {previewOpen && (
        <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
          {loading && (
            <div role="status" className="text-[11px] text-[var(--color-text-muted)]">
              {t('common.loading')}
            </div>
          )}
          {preview?.indexHtml ? (
            <>
              <div className="mb-1 text-[10px] text-[var(--color-text-muted)]">
                {t('agent.project.previewNote')}
              </div>
              <iframe
                sandbox="allow-scripts"
                srcDoc={injectCsp(preview.indexHtml)}
                title={preview.name}
                className="h-64 w-full rounded border-0 bg-white"
              />
            </>
          ) : preview?.readme ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-muted)]">
              {preview.readme}
            </pre>
          ) : preview ? (
            <div role="status" className="text-[11px] text-[var(--color-text-muted)]">
              {t('agent.project.listOnly')}
            </div>
          ) : null}
          {preview?.truncated && (
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {t('agent.project.previewTruncated')}
            </div>
          )}
          {preview && preview.files.length > 0 && (
            <div className="mt-2 max-h-40 overflow-auto">
              <div className="text-[10px] font-medium text-[var(--color-text-muted)]">
                {t('agent.project.fileList')}
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {preview.files.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                    <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                    <span className="shrink-0">{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 工作目录项目卡片：两个真动作（打开所在目录 / 导出 ZIP），明确"不在备份内" */
function WorkspaceProjectCard({ info }: { info: ParsedWorkspaceProject }) {
  const { t } = useI18n()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>, failMessage: string): Promise<void> => {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(`${failMessage}：${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const openDir = (): void => {
    void run(async () => {
      const res = await window.pocketai.openProjectDir(info.dirAbs)
      if (hasIpcFailed(res)) {
        setError(ipcFailureText(res, t))
        return
      }
      if (!res.ok) setError(t('agent.project.openFailed'))
    }, t('agent.project.openFailed'))
  }

  const exportZip = (): void => {
    void run(async () => {
      const res = await window.pocketai.exportProjectZipAbs(info.dirAbs)
      if (hasIpcFailed(res)) {
        setError(ipcFailureText(res, t))
        return
      }
      if (!res.ok) {
        setError(t('agent.project.exportFailed'))
        return
      }
      // 取消不是错误：静默（不弹提示、不报失败）
      if (res.canceled) return
      setNotice(t('agent.project.exported'))
    }, t('agent.project.exportFailed'))
  }

  return (
    <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-accent)]">
          PROJECT
        </span>
        <span className="min-w-0 flex-1 break-all text-xs font-medium text-[var(--color-text)]">
          {info.name}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
          {formatBytes(info.totalBytes)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
        {t('agent.project.folderHint', { n: info.fileCount })}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
        {t('agent.project.workspaceNotBackedUp')}
      </div>
      <div className="mt-0.5 break-all font-mono text-[10px] text-[var(--color-text-muted)]">
        {info.dirAbs}
      </div>

      {error && (
        <div role="status" className="mt-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="mt-1.5 text-[11px] text-[var(--color-success)]">
          {notice}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className="btn-primary px-2 py-1 text-[11px]" disabled={busy} onClick={openDir}>
          {t('agent.project.openWorkspaceDir')}
        </button>
        <button className="btn-ghost text-[11px]" disabled={busy} onClick={exportZip}>
          {t('agent.project.exportZip')}
        </button>
      </div>
    </div>
  )
}

