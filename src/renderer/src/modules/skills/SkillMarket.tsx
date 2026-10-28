// 技能市场：本地 + 在线商店 + URL 导入
//
// Tab 状态机：tab='local'|'online'
// - local: 原有技能列表（grid/detail），支持启停/复制/导出/删除
// - online: 远程 registry index 拉取 + 网格展示 + 一键导入
// URL 导入：粘贴 raw URL（.json 或 .md），safeFetch 后 parse 导入
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { useConfirm } from '../../components/ConfirmDialog'

interface Props {
  onClose: () => void
  onChanged: () => Promise<SkillRecord[]>
}

type Tab = 'local' | 'online'
type View = { mode: 'grid' } | { mode: 'detail'; id: string }

/** 远程 registry index 条目 */
interface RemoteSkill {
  id: string
  name: string
  description?: string
  icon?: string
  url: string
}

/** 默认 registry（自建 GitHub 托管） */
const DEFAULT_REGISTRY =
  'https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json'

export const SkillMarket: React.FC<Props> = ({ onClose, onChanged }) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('local')
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [remoteSkills, setRemoteSkills] = useState<RemoteSkill[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [registryUrl, setRegistryUrl] = useState(DEFAULT_REGISTRY)
  const [view, setView] = useState<View>({ mode: 'grid' })
  const [keyword, setKeyword] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const { notice: toast, show: showToast } = useTransientNotice<{ ok: boolean; text: string }>(2400)
  const { confirm, dialog } = useConfirm()

  const flash = useCallback((ok: boolean, text: string) => showToast({ ok, text }), [showToast])

  /**
   * §273：本地那一 tab 的清单读。改前失败侧是 `if (!hasIpcFailed(v)) setSkills(v)`＝什么都不做，
   * 屏上摆「还没有任何技能，点击「导入」或新建一个吧」——把通道故障演成"你一个技能都没装"，
   * 而这句话正好指着市场里那两颗导入键，用户会照着做第二次错的事。
   * 这一发的出路只有"关掉整个市场再开"（`load()` 全文件只在挂载调一次，导入／启停走的是 onChanged），
   * 按 §268 判据等于没出口 ⇒ 配一颗重试键。
   */
  const [skillsUnread, setSkillsUnread] = useState<{ error?: string } | null>(null)

  const load = useCallback(() => {
    window.pocketai
      .listSkills()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setSkillsUnread({ error: v.error })
          return
        }
        setSkillsUnread(null)
        setSkills(v)
      })
      .catch((e: unknown) => {
        setSkillsUnread({ error: errText(e, '') })
        logIpcError('skills.list', e)
      })
  }, [])

  /**
   * 在线清单那一发的代次（§322）：`fetchRemote` 可以被"进 tab"、URL 框的 Enter、「刷新」键叠着发，
   * 而先发起的那条常常后回 ⇒ 旧那份把新 URL 的清单覆盖掉，同时"还在加载"被先回的那条翻成"已就绪"——
   * 屏上摆着结果、内容却是另一个索引的。只有**最后发起那次**的响应允许写屏（清单、错误句、loading 都算）。
   */
  const remoteSeqRef = useRef(0)

  const fetchRemote = useCallback(
    async (url: string) => {
      const seq = ++remoteSeqRef.current
      setRemoteLoading(true)
      setRemoteError(null)
      const res = await window.pocketai.fetchSkillIndex(url)
      if (seq !== remoteSeqRef.current) return
      setRemoteLoading(false)
      if (res.ok && res.skills) {
        setRemoteSkills(res.skills)
        if (res.skills.length === 0) setRemoteError(t('skill.market.onlineEmpty'))
      } else {
        setRemoteError(res.error ?? t('skill.market.onlineFailed'))
        setRemoteSkills([])
      }
    },
    [t]
  )

  useEffect(() => {
    load()
    // §322：`registryUrl` **不进依赖**。那颗输入框是受控的、逐字符 setRegistryUrl，
    // 把 URL 放进依赖等于"每敲一个字符发一条真实网络请求"（默认值是 GitHub 上的真索引，主进程不缓存）。
    // 换完 URL 要重头发的是那两颗显式入口：URL 框的 Enter 与「刷新」按钮。
    if (tab === 'online') fetchRemote(registryUrl)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, load, fetchRemote, onClose])

  // 搜索过滤
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const pool = tab === 'local' ? skills : remoteSkills
    if (!kw) return pool
    return pool.filter(
      (s) => s.name.toLowerCase().includes(kw) || (s.description ?? '').toLowerCase().includes(kw)
    )
  }, [tab, skills, remoteSkills, keyword])

  const current =
    view.mode === 'detail'
      ? (tab === 'local'
          ? skills.find((s) => s.id === view.id)
          : remoteSkills.find((s) => s.id === view.id)) ?? null
      : null

  const handleTabSwitch = (t: Tab) => {
    setTab(t)
    setView({ mode: 'grid' })
    setKeyword('')
    setUrlInput('')
  }

  // ---------- 本地技能操作 ----------
  const handleToggle = useCallback(
    async (s: SkillRecord) => {
      const r = await window.pocketai.saveSkill({ id: s.id, name: s.name, enabled: !s.enabled })
      // §217：失败不判就照常拉一次列表并把「已创建副本」之外的一切当成成功 ⇒ 开关弹回去也没有原因
      if (hasIpcFailed(r)) {
        flash(false, ipcFailText(r, t('common.unknownError')))
        return
      }
      setSkills(await onChanged())
    },
    [onChanged, t, flash]
  )

  const handleDuplicate = useCallback(
    async (s: SkillRecord) => {
      const copy = await window.pocketai.saveSkill({
        name: `${s.name} ${t('skill.market.copySuffix')}`,
        description: s.description,
        icon: s.icon,
        content: s.content,
        enabled: true
      })
      // 失败不判就是绿色「已创建可编辑副本」＋随后空白详情（copy.id 是 undefined）（§216）
      if (hasIpcFailed(copy)) {
        flash(false, ipcFailText(copy, t('common.unknownError')))
        return
      }
      setSkills(await onChanged())
      setView({ mode: 'detail', id: copy.id })
      flash(true, t('skill.market.duplicated'))
    },
    [flash, t, onChanged]
  )

  const handleExport = useCallback(
    async (s: SkillRecord) => {
      const r = await window.pocketai.exportSkill(s.id)
      if (r.ok && !r.canceled) flash(true, t('skill.market.exportDone'))
      else if (!r.ok) flash(false, r.error ?? t('skill.market.exportFailed'))
    },
    [flash, t]
  )

  const handleImport = useCallback(async () => {
    const r = await window.pocketai.importSkill()
    if (!r.ok) {
      const keyMap: Record<string, string> = {
        NOT_SKILL_FILE: 'skill.market.notSkillFile',
        FILE_TOO_LARGE: 'skill.market.fileTooLarge',
        PARSE_FAILED: 'skill.market.parseFailed',
        MISSING_FIELDS: 'skill.market.missingFields'
      }
      flash(false, t(keyMap[r.error ?? ''] ?? 'skill.market.importFailed'))
      return
    }
    if (r.canceled) return
    if (r.skill) {
      setSkills(await onChanged())
      setView({ mode: 'detail', id: r.skill.id })
      flash(true, r.nameDuplicated ? t('skill.market.importedDupName') : t('skill.market.importDone'))
    }
  }, [flash, t, onChanged])

  /** §236：导入一个上游 SKILL.md 技能目录（正文进库，scripts/references 复制成这份技能的快照） */
  const handleImportFolder = useCallback(async () => {
    const r = await window.pocketai.importSkillFolder()
    if (!r.ok) {
      const keyMap: Record<string, string> = {
        NO_SKILL_MD: 'skill.market.noSkillMd',
        NOT_A_DIRECTORY: 'skill.market.notADirectory',
        ENTRY_TOO_LARGE: 'skill.market.entryTooLarge',
        // §326：资源回滚做成了、库里那条删不掉——这一张脸必须单独说一句（列表里会留下打不开的记录）
        SKILL_ROW_RESIDUE: 'skill.market.rowResidue'
      }
      flash(false, t(keyMap[r.error ?? ''] ?? 'skill.market.importFailed'))
      return
    }
    if (r.canceled) return
    if (r.skill) {
      setSkills(await onChanged())
      setView({ mode: 'detail', id: r.skill.id })
      const notes: string[] = [
        r.forcedOnDemand ? t('skill.market.forcedOnDemand') : '',
        (r.ignoredKeys ?? []).length > 0 ? t('skill.market.ignoredKeys').replace('{keys}', r.ignoredKeys!.join('、')) : '',
        (r.skipped ?? []).length > 0 ? t('skill.market.skippedFiles').replace('{n}', String(r.skipped!.length)) : ''
      ].filter(Boolean)
      flash(true, [t('skill.market.importFolderDone'), ...notes].filter(Boolean).join(' '))
    }
  }, [flash, t, onChanged])

  const handleDelete = useCallback(
    async (s: SkillRecord) => {
      if (!(await confirm({ message: t('skill.deleteConfirm', { name: s.name }), danger: true }))) return
      const r = await window.pocketai.deleteSkill(s.id)
      if (hasIpcFailed(r)) {
        flash(false, ipcFailText(r, t('common.unknownError')))
        return
      }
      setSkills(await onChanged())
      setView({ mode: 'grid' })
    },
    [t, onChanged, flash]
  )

  // ---------- 在线技能操作 ----------
  const handleImportRemote = useCallback(
    async (s: RemoteSkill) => {
      const r = await window.pocketai.importSkillFromUrl(s.url)
      if (r.ok && r.skill) {
        await onChanged()
        flash(true, t('skill.market.importDone'))
      } else {
        flash(false, r.error ?? t('skill.market.importFailed'))
      }
    },
    [flash, t, onChanged]
  )

  const handleImportFromUrl = useCallback(async () => {
    const url = urlInput.trim()
    if (!url) {
      flash(false, t('skill.market.urlEmpty'))
      return
    }
    const r = await window.pocketai.importSkillFromUrl(url)
    if (r.ok && r.skill) {
      setSkills(await onChanged())
      flash(true, t('skill.market.importDone'))
      setUrlInput('')
    } else {
      flash(false, r.error ?? t('skill.market.importFailed'))
    }
  }, [urlInput, flash, t, onChanged])

  const builtinBadge =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] shrink-0'
  const mineBadge =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)] shrink-0'
  const onlineBadge =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] shrink-0'

  // ---------- 渲染 ----------
  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--color-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-[82vh] flex flex-col rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="shrink-0 flex items-center justify-between px-5 h-14 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3 min-w-0">
            {view.mode === 'detail' && (
              <button
                onClick={() => setView({ mode: 'grid' })}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg"
                title={t('common.back')}
              >
                ←
              </button>
            )}
            <h2 className="font-semibold shrink-0">
              {view.mode === 'grid'
                ? tab === 'local'
                  ? t('skill.market.title')
                  : t('skill.market.onlineTitle')
                : t('skill.market.detail')}
            </h2>
            {view.mode === 'grid' && (
              <input
                className="input text-xs py-1 w-56"
                placeholder={t('skill.market.searchPh')}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            {view.mode === 'grid' && tab === 'local' && (
              <>
                <button className="btn-primary text-xs" onClick={handleImport}>
                  {t('skill.market.import')}
                </button>
                {/* §236：上游 SKILL.md 技能包是按目录发的，只给单文件入口等于装不了 */}
                <button
                  className="btn-ghost text-xs"
                  data-testid="skill-import-folder"
                  onClick={handleImportFolder}
                >
                  {t('skill.market.importFolder')}
                </button>
              </>
            )}
            {view.mode === 'grid' && tab === 'online' && (
              <button
                className="btn-ghost text-xs"
                onClick={() => fetchRemote(registryUrl)}
                disabled={remoteLoading}
              >
                {remoteLoading ? '…' : t('skill.market.refresh')}
              </button>
            )}
            <button
              onClick={onClose}
              title={t('common.close')}
              className="w-8 h-8 rounded hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>

        {/* Tab 栏 */}
        {view.mode === 'grid' && (
          <div className="shrink-0 px-5 pt-3 flex items-center gap-2">
            <button
              className={`text-xs px-3 py-1.5 rounded-md border font-medium transition-colors ${
                tab === 'local'
                  ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] border-[var(--color-accent)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
              }`}
              onClick={() => handleTabSwitch('local')}
            >
              🛒 {t('skill.market.tabLocal')}
            </button>
            <button
              className={`text-xs px-3 py-1.5 rounded-md border font-medium transition-colors ${
                tab === 'online'
                  ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] border-[var(--color-accent)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
              }`}
              onClick={() => handleTabSwitch('online')}
            >
              🌐 {t('skill.market.tabOnline')}
            </button>
          </div>
        )}

        {/* 在线 tab 的 URL 栏 + 粘贴导入 */}
        {view.mode === 'grid' && tab === 'online' && (
          <div className="shrink-0 px-5 pt-3 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="shrink-0">{t('skill.market.registryLabel')}:</span>
              <input
                className="input text-xs py-1 flex-1"
                value={registryUrl}
                onChange={(e) => setRegistryUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) fetchRemote(registryUrl)
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                className="input text-xs py-1 flex-1"
                placeholder={t('skill.market.urlImportPh')}
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleImportFromUrl()
                }}
              />
              <button
                className="btn-primary text-xs shrink-0"
                onClick={handleImportFromUrl}
                disabled={!urlInput.trim()}
              >
                {t('skill.market.importUrl')}
              </button>
            </div>
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-5">
          {view.mode === 'grid' ? (
            // ========== Grid 视图 ==========
            filtered.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="text-3xl mb-2">{tab === 'online' ? '🌐' : '🛒'}</div>
                {/* §273：本地那份读不到时，「还没有任何技能…」这张脸让位（同一时刻只说一件事，§262 口径） */}
                {!(tab === 'local' && skillsUnread) && (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {tab === 'online'
                      ? remoteLoading
                        ? t('skill.market.loading')
                        : remoteError
                          ? remoteError
                          : t('skill.market.onlineEmpty')
                      : skills.length === 0
                        ? t('skill.market.empty')
                        : t('skill.market.noMatch')}
                  </p>
                )}
                {tab === 'local' && skillsUnread && (
                  <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                    <LoadFailNotice what={t('common.skillsList')} msg={ipcFailText(skillsUnread, t('common.unknownError'))} />
                    <button
                      data-testid="skill-market-skills-retry"
                      className="text-xs underline text-[var(--color-text-muted)]"
                      onClick={load}
                    >
                      {t('agent.retryRead')}
                    </button>
                  </div>
                )}
              </div>
            ) : tab === 'local' ? (
              // 本地网格
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {(filtered as SkillRecord[]).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setView({ mode: 'detail', id: s.id })}
                    className="text-left rounded-xl border border-[var(--color-border)] p-3 hover:border-[var(--color-accent)] hover:shadow-sm transition-all bg-[var(--color-bg)]"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xl">{s.icon}</span>
                      <span className="text-sm font-medium truncate">{s.name}</span>
                      <span className={`ml-auto ${s.isBuiltin ? builtinBadge : mineBadge}`}>
                        {s.isBuiltin ? t('skill.builtin') : t('skill.market.mine')}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed line-clamp-2 min-h-[2.4em]">
                      {s.description || '—'}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          s.enabled
                            ? 'bg-[var(--color-accent)]'
                            : 'bg-[var(--color-text-muted)] opacity-40'
                        }`}
                      />
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        {s.enabled ? t('skill.on') : t('skill.off')}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              // 在线网格
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {(filtered as RemoteSkill[]).map((s) => (
                  <div
                    key={s.id}
                    className="rounded-xl border border-[var(--color-border)] p-3 bg-[var(--color-bg)]"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xl">{s.icon ?? '⚡'}</span>
                      <span className="text-sm font-medium truncate flex-1">{s.name}</span>
                      <span className={onlineBadge}>{t('skill.market.onlineBadge')}</span>
                    </div>
                    <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed line-clamp-2 min-h-[2.4em] mb-2">
                      {s.description || '—'}
                    </p>
                    <button
                      className="btn-primary text-xs w-full"
                      onClick={() => handleImportRemote(s)}
                    >
                      {t('skill.market.importRemote')}
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : // ========== Detail 视图 ==========
          current && tab === 'local' ? (
            <LocalDetail
              skill={current as SkillRecord}
              onToggle={handleToggle}
              onDuplicate={handleDuplicate}
              onExport={handleExport}
              onDelete={handleDelete}
              builtinBadge={builtinBadge}
              mineBadge={mineBadge}
            />
          ) : current && tab === 'online' ? (
            <OnlineDetail
              skill={current as RemoteSkill}
              onImport={handleImportRemote}
              onlineBadge={onlineBadge}
            />
          ) : null}
        </div>

        {/* toast */}
        {toast && (
          <div
            className={`absolute bottom-4 left-1/2 -translate-x-1/2 text-xs px-3 py-1.5 rounded shadow ${
              toast.ok
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
            }`}
          >
            {toast.text}
          </div>
        )}
      </div>

      {dialog}
    </div>
  )
}

// ---------- 详情子组件 ----------
const LocalDetail: React.FC<{
  skill: SkillRecord
  onToggle: (s: SkillRecord) => void
  onDuplicate: (s: SkillRecord) => void
  onExport: (s: SkillRecord) => void
  onDelete: (s: SkillRecord) => void
  builtinBadge: string
  mineBadge: string
}> = ({ skill, onToggle, onDuplicate, onExport, onDelete, builtinBadge, mineBadge }) => {
  const { t } = useI18n()
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-3xl">{skill.icon}</span>
        <div className="min-w-0">
          <div className="font-semibold flex items-center gap-2">
            {skill.name}
            <span className={skill.isBuiltin ? builtinBadge : mineBadge}>
              {skill.isBuiltin ? t('skill.builtin') : t('skill.market.mine')}
            </span>
          </div>
          {skill.description && (
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{skill.description}</div>
          )}
        </div>
        <span
          className={`ml-auto shrink-0 text-[11px] px-2 py-1 rounded ${
            skill.enabled
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
          }`}
        >
          {skill.enabled ? t('skill.on') : t('skill.off')}
        </span>
      </div>

      <pre className="input whitespace-pre-wrap font-mono text-xs leading-relaxed min-h-[200px] max-h-[46vh] overflow-y-auto">
        {skill.content}
      </pre>

      <div className="flex flex-wrap gap-2 pt-1">
        <button className="btn-ghost text-xs" onClick={() => onToggle(skill)}>
          {skill.enabled ? t('skill.disable') : t('skill.enable')}
        </button>
        <button className="btn-primary text-xs" onClick={() => onDuplicate(skill)}>
          {t('skill.market.duplicate')}
        </button>
        <button className="btn-ghost text-xs" onClick={() => onExport(skill)}>
          {t('skill.market.export')}
        </button>
        {!skill.isBuiltin && (
          <button className="btn-ghost text-xs text-[var(--color-danger)]" onClick={() => onDelete(skill)}>
            {t('common.delete')}
          </button>
        )}
      </div>
      {skill.isBuiltin && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          {t('skill.market.builtinHint')}
        </p>
      )}
    </div>
  )
}

const OnlineDetail: React.FC<{
  skill: RemoteSkill
  onImport: (s: RemoteSkill) => void
  onlineBadge: string
}> = ({ skill, onImport, onlineBadge }) => {
  const { t } = useI18n()
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-3xl">{skill.icon ?? '⚡'}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold flex items-center gap-2">
            {skill.name}
            <span className={onlineBadge}>{t('skill.market.onlineBadge')}</span>
          </div>
          {skill.description && (
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{skill.description}</div>
          )}
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate" title={skill.url}>
            ↗ {skill.url}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <button className="btn-primary text-xs" onClick={() => onImport(skill)}>
          {t('skill.market.importRemote')}
        </button>
      </div>
    </div>
  )
}
