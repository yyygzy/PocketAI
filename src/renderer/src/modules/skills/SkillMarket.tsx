// 技能市场（V2 批次五）：浏览/搜索 + 复制为我的技能 + 导入/导出
//
// 复用 AssistantMarket 的模态模式：固定遮罩 + View 状态机（grid/detail）。
// 内置技能内容锁定，编辑路径 = 「复制为我的技能」生成自定义副本。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'

interface Props {
  onClose: () => void
  /** 市场 内启停/导入/删除等写操作后通知父级刷新技能列表 */
  onChanged: () => void
}

type View = { mode: 'grid' } | { mode: 'detail'; id: string }

export const SkillMarket: React.FC<Props> = ({ onClose, onChanged }) => {
  const { t } = useI18n()
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [view, setView] = useState<View>({ mode: 'grid' })
  const [keyword, setKeyword] = useState('')
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => window.pocketai.listSkills().then(setSkills), [])
  useEffect(() => {
    load()
    // Esc 关闭市场
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [load, onClose])

  const flash = useCallback((ok: boolean, text: string) => {
    setToast({ ok, text })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2400)
  }, [])

  // 搜索过滤：名称 + 描述，大小写不敏感；内置排前（与 skillRepo.list 排序一致）
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return skills
    return skills.filter(
      (s) => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)
    )
  }, [skills, keyword])

  const current = view.mode === 'detail' ? skills.find((s) => s.id === view.id) ?? null : null

  const handleToggle = useCallback(
    async (s: SkillRecord) => {
      await window.pocketai.saveSkill({ id: s.id, name: s.name, enabled: !s.enabled })
      await load()
      onChanged()
    },
    [load, onChanged]
  )

  /** 复制为我的技能：全字段另存（不传 id → 新建自定义副本），成功后跳副本详情 */
  const handleDuplicate = useCallback(
    async (s: SkillRecord) => {
      const copy = await window.pocketai.saveSkill({
        name: `${s.name} ${t('skill.market.copySuffix')}`,
        description: s.description,
        icon: s.icon,
        content: s.content,
        enabled: true
      })
      await load()
      onChanged()
      setView({ mode: 'detail', id: copy.id })
      flash(true, t('skill.market.duplicated'))
    },
    [load, flash, t, onChanged]
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
    if (r.ok && r.canceled) return
    if (r.ok && r.skill) {
      await load()
      setView({ mode: 'detail', id: r.skill.id })
      flash(true, t('skill.market.importDone'))
      onChanged()
      return
    }
    if (!r.ok) {
      const keyMap: Record<string, string> = {
        NOT_SKILL_FILE: 'skill.market.notSkillFile',
        FILE_TOO_LARGE: 'skill.market.fileTooLarge',
        PARSE_FAILED: 'skill.market.parseFailed',
        MISSING_FIELDS: 'skill.market.missingFields'
      }
      flash(false, t(keyMap[r.error ?? ''] ?? 'skill.market.importFailed'))
    }
  }, [load, flash, t, onChanged])

  const handleDelete = useCallback(
    async (s: SkillRecord) => {
      if (!window.confirm(t('skill.deleteConfirm', { name: s.name }))) return
      await window.pocketai.deleteSkill(s.id)
      await load()
      setView({ mode: 'grid' })
      onChanged()
    },
    [load, t, onChanged]
  )

  const builtinBadge =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] shrink-0'
  const mineBadge =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)] shrink-0'

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--color-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden"
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
              {view.mode === 'grid' ? t('skill.market.title') : t('skill.market.detail')}
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
            {view.mode === 'grid' && (
              <button className="btn-primary text-xs" onClick={handleImport}>
                {t('skill.market.import')}
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

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-5">
          {view.mode === 'grid' ? (
            filtered.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="text-3xl mb-2">🛒</div>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {skills.length === 0 ? t('skill.market.empty') : t('skill.market.noMatch')}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {filtered.map((s) => (
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
            )
          ) : current ? (
            <div className="max-w-2xl mx-auto space-y-4">
              <div className="flex items-start gap-3">
                <span className="text-3xl">{current.icon}</span>
                <div className="min-w-0">
                  <div className="font-semibold flex items-center gap-2">
                    {current.name}
                    <span className={current.isBuiltin ? builtinBadge : mineBadge}>
                      {current.isBuiltin ? t('skill.builtin') : t('skill.market.mine')}
                    </span>
                  </div>
                  {current.description && (
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {current.description}
                    </div>
                  )}
                </div>
                <span
                  className={`ml-auto shrink-0 text-[11px] px-2 py-1 rounded ${
                    current.enabled
                      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                      : 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
                  }`}
                >
                  {current.enabled ? t('skill.on') : t('skill.off')}
                </span>
              </div>

              <pre className="input whitespace-pre-wrap font-mono text-xs leading-relaxed min-h-[200px] max-h-[46vh] overflow-y-auto">
                {current.content}
              </pre>

              {/* 操作区 */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button className="btn-ghost text-xs" onClick={() => handleToggle(current)}>
                  {current.enabled ? t('skill.disable') : t('skill.enable')}
                </button>
                <button className="btn-primary text-xs" onClick={() => handleDuplicate(current)}>
                  {t('skill.market.duplicate')}
                </button>
                <button className="btn-ghost text-xs" onClick={() => handleExport(current)}>
                  {t('skill.market.export')}
                </button>
                {!current.isBuiltin && (
                  <>
                    <button
                      className="btn-ghost text-xs"
                      title={t('skill.market.editHint')}
                      onClick={() => {
                        // 市场内不做编辑表单，回技能页操作（避免 toast 随模态卸载不可见）
                        onClose()
                      }}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      className="btn-ghost text-xs text-[var(--color-danger)]"
                      onClick={() => handleDelete(current)}
                    >
                      {t('common.delete')}
                    </button>
                  </>
                )}
              </div>
              {current.isBuiltin && (
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  {t('skill.market.builtinHint')}
                </p>
              )}
            </div>
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
    </div>
  )
}
