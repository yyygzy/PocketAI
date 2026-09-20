// 文件模块：数据目录（DATA_DIR）文件管理器
// 只读浏览 + 管理应用自有数据（上传/新建文件夹/删除/另存为），范围严格限制在 data/ 内
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, FileReadResult } from '../../../../shared/types'
import { useI18n } from '../../i18n'

export const FilesModule: React.FC = () => {
  const { t } = useI18n()
  const [relDir, setRelDir] = useState('') // '' = data 根目录
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState<{ entry: FileEntry; result: FileReadResult } | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (dir: string) => {
    setLoading(true)
    try {
      const list = await window.pocketai.listFiles(dir)
      setEntries(list)
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(relDir)
  }, [relDir, load])

  const flash = (ok: boolean, text: string) => {
    setNotice({ ok, text })
    window.setTimeout(() => setNotice(null), 2600)
  }

  // ---------- 面包屑 ----------
  const crumbs = useMemo(() => {
    const parts = relDir ? relDir.split('/').filter(Boolean) : []
    const acc: { name: string; rel: string }[] = [{ name: 'data', rel: '' }]
    parts.forEach((p, i) => {
      acc.push({ name: p, rel: parts.slice(0, i + 1).join('/') })
    })
    return acc
  }, [relDir])

  // ---------- 操作 ----------
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    let failCount = 0
    for (const f of Array.from(files)) {
      if (f.size > 100 * 1024 * 1024) {
        failCount++
        continue
      }
      const buf = await f.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buf)
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      const res = await window.pocketai.uploadFile(relDir, f.name, btoa(binary))
      if (!res.ok) failCount++
    }
    flash(
      failCount === 0,
      failCount === 0 ? t('fm.uploadDone') : t('fm.uploadPartial', { count: failCount })
    )
    load(relDir)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Electron 未实现 window.prompt，新建文件夹改用应用内弹窗 MkdirDialog
  const handleMkdir = () => setMkdirOpen(true)

  const handleDelete = async (e: FileEntry) => {
    const msg = e.isDir ? t('fm.deleteDirConfirm', { name: e.name }) : t('fm.deleteConfirm', { name: e.name })
    if (!window.confirm(msg)) return
    const res = await window.pocketai.deleteFile(e.relPath)
    flash(res.ok, res.ok ? t('fm.deleteDone') : (res.error ?? t('fm.opFailed')))
    load(relDir)
  }

  const handleOpenPreview = async (e: FileEntry) => {
    const result = await window.pocketai.readFile(e.relPath)
    setPreview({ entry: e, result })
  }

  const handleSaveAs = async (e: FileEntry) => {
    const res = await window.pocketai.saveFileAs(e.relPath)
    if (!res.ok) flash(false, res.error ?? t('fm.opFailed'))
  }

  const fmtSize = (size: number): string => {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  const fmtTime = (ms: number): string => {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const iconOf = (e: FileEntry): string => {
    if (e.isDir) return '📁'
    const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) return '🖼️'
    if (['.db', '.sqlite'].includes(ext)) return '🗄️'
    if (['.zip', '.7z', '.gz', '.tar', '.rar'].includes(ext)) return '🗜️'
    if (['.log'].includes(ext)) return '📋'
    if (['.lic'].includes(ext)) return '🔑'
    if (['.exe', '.dll', '.node', '.so'].includes(ext)) return '⚙️'
    return '📄'
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button className="btn-primary text-xs" onClick={() => fileInputRef.current?.click()}>
          ⬆ {t('fm.upload')}
        </button>
        <button className="btn-ghost text-xs" onClick={handleMkdir}>
          📂 {t('fm.mkdir')}
        </button>
        <button className="btn-ghost text-xs" onClick={() => load(relDir)}>
          🔄 {t('fm.refresh')}
        </button>
        <button className="btn-ghost text-xs" onClick={() => window.pocketai.openFileLocation(relDir || '.')}>
          📤 {t('fm.openDataDir')}
        </button>
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
      </div>

      {/* 面包屑 */}
      <div className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] flex-wrap">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.rel || 'root'}>
            {i > 0 && <span className="opacity-50">/</span>}
            <button
              className="hover:text-[var(--color-accent)] hover:underline"
              onClick={() => setRelDir(c.rel)}
            >
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* 文件表格 */}
      <div className="flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)]">
        {loading ? (
          <div className="p-6 text-sm text-[var(--color-text-muted)] text-center">{t('common.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-sm text-[var(--color-text-muted)] text-center">{t('fm.empty')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                <th className="text-left font-medium px-3 py-2">{t('fm.colName')}</th>
                <th className="text-right font-medium px-3 py-2 w-24">{t('fm.colSize')}</th>
                <th className="text-right font-medium px-3 py-2 w-40">{t('fm.colMtime')}</th>
                <th className="w-px" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.relPath}
                  className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-hover-overlay)]"
                >
                  <td className="px-3 py-2">
                    <div
                      className="flex items-center gap-2 cursor-pointer"
                      onClick={() => (e.isDir ? setRelDir(e.relPath) : handleOpenPreview(e))}
                    >
                      <span>{iconOf(e)}</span>
                      <span className="truncate max-w-[380px]" title={e.name}>{e.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-[var(--color-text-muted)]">
                    {e.isDir ? '—' : fmtSize(e.size)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-[var(--color-text-muted)]">
                    {fmtTime(e.mtime)}
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-0.5">
                      {!e.isDir && (
                        <button
                          className="px-1.5 py-1 rounded text-xs hover:bg-[var(--color-hover-overlay)]"
                          title={t('fm.preview')}
                          onClick={() => handleOpenPreview(e)}
                        >
                          👁
                        </button>
                      )}
                      <button
                        className="px-1.5 py-1 rounded text-xs hover:bg-[var(--color-hover-overlay)]"
                        title={t('fm.openExternal')}
                        onClick={() => window.pocketai.openFileExternal(e.relPath)}
                      >
                        ↗
                      </button>
                      <button
                        className="px-1.5 py-1 rounded text-xs hover:bg-[var(--color-hover-overlay)]"
                        title={t('fm.openLocation')}
                        onClick={() => window.pocketai.openFileLocation(e.relPath)}
                      >
                        📍
                      </button>
                      {!e.isDir && (
                        <button
                          className="px-1.5 py-1 rounded text-xs hover:bg-[var(--color-hover-overlay)]"
                          title={t('fm.saveAs')}
                          onClick={() => handleSaveAs(e)}
                        >
                          💾
                        </button>
                      )}
                      <button
                        className="px-1.5 py-1 rounded text-xs text-[var(--color-danger)] hover:bg-[var(--color-hover-overlay)]"
                        title={t('common.delete')}
                        onClick={() => handleDelete(e)}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 预览 Modal */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm"
          onClick={() => setPreview(null)}
        >
          <div
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl p-5 max-w-3xl w-[min(760px,90vw)] max-h-[80vh] flex flex-col"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3 shrink-0">
              <h4 className="text-sm font-semibold truncate">
                {iconOf(preview.entry)} {preview.entry.name}
                {!preview.result.ok && (
                  <span className="ml-2 text-xs font-normal text-[var(--color-danger)]">
                    {preview.result.mime ?? t('fm.readFailed')}
                  </span>
                )}
              </h4>
              <button
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none"
                onClick={() => setPreview(null)}
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-auto min-h-0">
              {preview.result.kind === 'image' && preview.result.content ? (
                <img src={preview.result.content} alt={preview.entry.name} className="max-w-full max-h-[60vh] mx-auto" />
              ) : preview.result.kind === 'text' && preview.result.content !== null ? (
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--color-text)]">
                  {preview.result.content}
                </pre>
              ) : (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">{iconOf(preview.entry)}</div>
                  <p className="text-sm text-[var(--color-text-muted)]">{t('fm.noPreview')}</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">
                    {fmtSize(preview.result.size)}
                  </p>
                  <button className="btn-ghost text-xs mt-4" onClick={() => handleSaveAs(preview.entry)}>
                    💾 {t('fm.saveAs')}
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--color-border)] shrink-0">
              <span className="text-xs text-[var(--color-text-muted)]">
                {preview.result.truncated ? t('fm.truncated') : `${fmtSize(preview.result.size)} · ${fmtTime(preview.entry.mtime)}`}
              </span>
              <div className="flex gap-2">
                <button className="btn-ghost text-xs" onClick={() => handleSaveAs(preview.entry)}>
                  💾 {t('fm.saveAs')}
                </button>
                <button className="btn-ghost text-xs" onClick={() => window.pocketai.openFileExternal(preview.entry.relPath)}>
                  ↗ {t('fm.openExternal')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 新建文件夹 Modal（替代 Electron 不支持的 window.prompt） */}
      {mkdirOpen && (
        <MkdirDialog
          relDir={relDir}
          onClose={() => setMkdirOpen(false)}
          onCreated={() => {
            setMkdirOpen(false)
            flash(true, t('fm.mkdirDone'))
            load(relDir)
          }}
        />
      )}
    </div>
  )
}

// ---------- 新建文件夹弹窗 ----------
const MkdirDialog: React.FC<{
  relDir: string
  onClose: () => void
  onCreated: () => void
}> = ({ relDir, onClose, onCreated }) => {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    const res = await window.pocketai.mkdir(relDir, trimmed)
    setBusy(false)
    if (res.ok) {
      onCreated()
    } else {
      setError(res.error ?? t('fm.opFailed'))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)]"
      onClick={onClose}
    >
      <div
        className="w-[420px] bg-[var(--color-sidebar)] rounded-lg border border-[var(--color-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-semibold">📂 {t('fm.mkdir')}</h3>
          <button onClick={onClose} className="btn-ghost text-xs">
            {t('common.close')}
          </button>
        </div>
        <div className="p-4 space-y-2">
          <input
            className="input w-full"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={t('fm.mkdirPrompt')}
          />
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--color-border)]">
          <button onClick={onClose} className="btn-ghost text-xs" disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || busy}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
