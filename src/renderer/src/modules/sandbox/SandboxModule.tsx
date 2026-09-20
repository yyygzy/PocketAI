// 沙箱模块（V2 批次八 / 九）：AI 生成 HTML 的隔离运行与产物管理
//
// 安全边界：
//  - 预览 iframe 仅 sandbox="allow-scripts"：无 same-origin / 导航 / 弹窗 / 表单
//  - 加载前注入 CSP meta：default-src 'none'（禁外连、禁外部脚本），允许内联脚本/样式与 data:/blob: 图片
//  - 与宿主零 postMessage 通信（通信桥为迷你应用后续扩展点，本期刻意不开放）
//
// V2 批次九扩展：迷你应用（isApp）视图——网格展示已标记为应用的产物，支持设为应用/编辑/取消标记
import React, { useEffect, useState } from 'react'
import type { SandboxFileMeta } from '../../../../shared/types'
import { useI18n } from '../../i18n'

const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:"

// 预设 emoji 图标（迷你应用用）
const ICON_PRESETS = ['📦', '🎮', '🎨', '📊', '📝', '🧮', '🔧', '🎵', '🌐', '⚡', '🚀', '🎯']

/** 注入 CSP meta：DOMParser 结构化解析后插到真实 <head> 首位（杜绝正则定位被
 *  注释/属性/字符串中的字面 <head> 规避）；并剥离 meta-refresh——iframe 自导航后的
 *  新文档不继承 meta CSP（JS location 自导航无法用 CSP 阻止，为残余风险，见 review Minor-1） */
function injectCsp(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
    const he = (m.getAttribute('http-equiv') || '').trim().toLowerCase()
    if (he === 'refresh') m.remove()
  })
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', PREVIEW_CSP)
  doc.head.insertBefore(meta, doc.head.firstChild)
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

type ViewTab = 'all' | 'apps'

// 「安装后跳转应用库」的确定性通道：其他模块（Agent 安装入口）先置位再切模块，
// SandboxModule 挂载时消费。Workspace 只渲染激活模块，纯事件会在未挂载时丢失。
let pendingOpenAppsTab = false
export function requestSandboxOpenApps(): void {
  pendingOpenAppsTab = true
}

export const SandboxModule: React.FC = () => {
  const { t } = useI18n()
  const [tab, setTab] = useState<ViewTab>('all')
  const [files, setFiles] = useState<SandboxFileMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ meta: SandboxFileMeta; html: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newHtml, setNewHtml] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // 编辑中的产物（设为应用 / 改元数据）
  const [editingId, setEditingId] = useState<string | null>(null)

  const load = async () => {
    setFiles(await window.pocketai.listSandboxFiles())
  }

  useEffect(() => {
    void load()
  }, [])

  // 挂载时消费「打开应用库」标记（Agent 安装为迷你应用后跳转）
  useEffect(() => {
    if (pendingOpenAppsTab) {
      pendingOpenAppsTab = false
      setTab('apps')
    }
  }, [])

  // toast 自动消失（卸载清理定时器）
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const openPreview = async (id: string) => {
    const r = await window.pocketai.getSandboxFile(id)
    if (r) {
      setPreview(r)
      setSelectedId(id)
    } else {
      setToast(t('sandbox.fileMissing'))
    }
  }

  const handleCreate = async () => {
    if (!newHtml.trim() || busy) return
    setBusy(true)
    try {
      const meta = await window.pocketai.createSandboxFile(newName, newHtml)
      setNewName('')
      setNewHtml('')
      setCreating(false)
      await load()
      await openPreview(meta.id)
      setToast(t('sandbox.created'))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('sandbox.deleteConfirm'))) return
    try {
      await window.pocketai.deleteSandboxFile(id)
      if (selectedId === id) {
        setSelectedId(null)
        setPreview(null)
      }
      if (editingId === id) setEditingId(null)
      await load()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  const handleToggleApp = async (f: SandboxFileMeta, toApp: boolean) => {
    try {
      await window.pocketai.updateSandboxMeta(f.id, { isApp: toApp })
      await load()
      setToast(toApp ? t('miniapp.promoted') : t('miniapp.demoted'))
    } catch (err) {
      alert((err as Error).message)
    }
  }

  const appFiles = files.filter((f) => f.isApp)

  return (
    <div className="flex gap-4 h-full">
      {/* 左：产物列表 / 应用库 */}
      <div className="w-72 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">
            {tab === 'apps' ? t('miniapp.library') : t('sandbox.listTitle')}
          </h3>
          {tab === 'all' && (
            <button
              onClick={() => setCreating((v) => !v)}
              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
            >
              {creating ? t('common.cancel') : t('sandbox.new')}
            </button>
          )}
        </div>

        {/* Tab 切换 */}
        <div className="flex gap-1 mb-2 text-xs">
          <TabBtn active={tab === 'all'} onClick={() => setTab('all')}>
            {t('sandbox.tabAll')}
          </TabBtn>
          <TabBtn active={tab === 'apps'} onClick={() => setTab('apps')}>
            {t('sandbox.tabApps')}
            {appFiles.length > 0 && (
              <span className="ml-1 text-[10px] opacity-70">({appFiles.length})</span>
            )}
          </TabBtn>
        </div>

        {creating && (
          <div className="mb-2 p-2 rounded border border-[var(--color-border)] space-y-1.5">
            <input
              className="input-mini w-full"
              placeholder={t('sandbox.namePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <textarea
              className="input-mini w-full h-28 font-mono text-[11px] resize-none"
              placeholder={t('sandbox.htmlPlaceholder')}
              value={newHtml}
              onChange={(e) => setNewHtml(e.target.value)}
            />
            <div className="flex justify-end gap-1">
              <button className="btn-ghost text-xs" disabled={busy} onClick={handleCreate}>
                {busy ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        )}

        {tab === 'all' ? (
          <div className="space-y-1 overflow-y-auto">
            {files.length === 0 && (
              <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                {t('sandbox.emptyHint')}
              </p>
            )}
            {files.map((f) => (
              <SandboxItem
                key={f.id}
                f={f}
                selected={selectedId === f.id}
                editing={editingId === f.id}
                onPreview={() => void openPreview(f.id)}
                onDelete={() => void handleDelete(f.id)}
                onToggleApp={() => void handleToggleApp(f, !f.isApp)}
                onEdit={() => setEditingId(editingId === f.id ? null : f.id)}
                onSaved={async () => {
                  setEditingId(null)
                  await load()
                  setToast(t('miniapp.metaSaved'))
                }}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 overflow-y-auto">
            {appFiles.length === 0 && (
              <p className="col-span-2 text-xs text-[var(--color-text-muted)] leading-relaxed">
                {t('miniapp.emptyHint')}
              </p>
            )}
            {appFiles.map((f) => (
              <AppCard
                key={f.id}
                f={f}
                onPreview={() => void openPreview(f.id)}
                onEdit={() => {
                  setTab('all')
                  setEditingId(f.id)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 右：预览区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {preview ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium truncate">
                {preview.meta.isApp && <span className="mr-1">{preview.meta.icon}</span>}
                {preview.meta.name}
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-info-bg)] text-[var(--color-info)]">
                {t('sandbox.isolatedBadge')}
              </span>
            </div>
            <div className="flex-1 min-h-0 rounded-lg border border-[var(--color-border)] overflow-hidden bg-white">
              <iframe
                sandbox="allow-scripts"
                srcDoc={injectCsp(preview.html)}
                title={preview.meta.name}
                className="w-full h-full border-0"
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)] px-8 text-center leading-relaxed">
            {t('sandbox.previewEmpty')}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 px-3 py-2 rounded-md bg-[var(--color-accent)] text-[var(--color-on-accent)] text-xs shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// ===================== 子组件 =====================

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children
}) => (
  <button
    onClick={onClick}
    className={`px-2 py-1 rounded border ${
      active
        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`}
  >
    {children}
  </button>
)

/** 沙箱产物列表项（全部产物视图） */
const SandboxItem: React.FC<{
  f: SandboxFileMeta
  selected: boolean
  editing: boolean
  onPreview: () => void
  onDelete: () => void
  onToggleApp: () => void
  onEdit: () => void
  onSaved: () => void
}> = ({ f, selected, editing, onPreview, onDelete, onToggleApp, onEdit, onSaved }) => {
  const { t } = useI18n()
  const [name, setName] = useState(f.name)
  const [icon, setIcon] = useState(f.icon)
  const [desc, setDesc] = useState(f.description)
  const [saving, setSaving] = useState(false)

  // 切换编辑对象时同步表单
  useEffect(() => {
    if (editing) {
      setName(f.name)
      setIcon(f.icon)
      setDesc(f.description)
    }
  }, [editing, f])

  const save = async () => {
    setSaving(true)
    try {
      await window.pocketai.updateSandboxMeta(f.id, { name, icon, description: desc })
      onSaved()
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`px-3 py-2 rounded text-sm border ${
        selected ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <button className="font-medium truncate text-left flex-1" onClick={onPreview}>
          {f.isApp && <span className="mr-1">{f.icon}</span>}
          {f.name}
          {f.isApp && <span className="ml-1 text-[10px]">⭐</span>}
        </button>
        <MiniBtn onClick={onEdit}>{editing ? t('common.close') : t('miniapp.edit')}</MiniBtn>
      </div>
      <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
        {formatSize(f.size)} · {new Date(f.createdAt).toLocaleString()}
      </div>

      {editing && (
        <div className="mt-2 space-y-1.5 border-t border-[var(--color-border)] pt-2">
          <div className="flex items-center gap-1.5">
            <input
              className="input-mini w-10 text-center"
              value={icon}
              maxLength={4}
              onChange={(e) => setIcon(e.target.value)}
            />
            <input
              className="input-mini flex-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {ICON_PRESETS.map((ic) => (
              <button
                key={ic}
                onClick={() => setIcon(ic)}
                className={`w-6 h-6 rounded text-sm ${icon === ic ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-hover-overlay)]'}`}
              >
                {ic}
              </button>
            ))}
          </div>
          <textarea
            className="input-mini w-full h-14 resize-none text-[11px]"
            placeholder={t('miniapp.descPlaceholder')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="flex items-center justify-between gap-1">
            <MiniBtn onClick={onToggleApp}>
              {f.isApp ? t('miniapp.unmark') : t('miniapp.promote')}
            </MiniBtn>
            <div className="flex gap-1">
              <MiniBtn danger onClick={onDelete}>{t('common.delete')}</MiniBtn>
              <button
                className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-50"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 迷你应用卡片（应用库网格视图） */
const AppCard: React.FC<{
  f: SandboxFileMeta
  onPreview: () => void
  onEdit: () => void
}> = ({ f, onPreview, onEdit }) => {
  const { t } = useI18n()
  return (
    <div className="p-2 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)] cursor-pointer flex flex-col gap-1">
      <div className="flex items-start justify-between" onClick={onPreview}>
        <div className="text-2xl">{f.icon}</div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {t('miniapp.edit')}
        </button>
      </div>
      <div className="text-xs font-medium truncate" onClick={onPreview}>
        {f.name}
      </div>
      {f.description && (
        <div className="text-[10px] text-[var(--color-text-muted)] line-clamp-2 leading-snug">
          {f.description}
        </div>
      )}
      <div className="text-[10px] text-[var(--color-text-muted)] mt-auto">
        {new Date(f.createdAt).toLocaleDateString()}
      </div>
    </div>
  )
}

const MiniBtn: React.FC<{
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}> = ({ onClick, children, danger }) => (
  <button
    onClick={(e) => {
      e.stopPropagation()
      onClick()
    }}
    className={`text-[10px] px-1.5 py-0.5 rounded border ${
      danger
        ? 'border-[var(--color-danger-bg)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`}
  >
    {children}
  </button>
)
