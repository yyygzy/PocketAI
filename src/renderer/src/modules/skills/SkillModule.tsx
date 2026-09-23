// 技能管理模块：技能列表 / 创建编辑 / 启用开关 / 删除 / 市场（浏览/搜索/复制/导入导出）
// 技能 = 可复用提示词片段，关联到助手后自动注入 SystemPrompt
import React, { useCallback, useEffect, useState } from 'react'
import type { SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { SkillMarket } from './SkillMarket'

export const SkillModule: React.FC = () => {
  const { t } = useI18n()
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'detail' | 'create' | 'edit'>('detail')
  const [marketOpen, setMarketOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  // 返回最新列表供调用方复用：市场内写操作后市场与本页共享同一次 listSkills 结果，
  // 避免市场自刷 + 本页 onChanged 双查
  const load = useCallback(async () => {
    const list = await window.pocketai.listSkills()
    setSkills(list)
    return list
  }, [])
  useEffect(() => {
    // 打开技能页时自动同步内置（支持开发时热更新 + 生产环境首次载入）
    window.pocketai.syncSkills().catch(reportIpcError('skills.syncBuiltin'))
    load()
  }, [])

  // 搜索过滤：名称 + 描述
  const filtered = React.useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return skills
    return skills.filter(
      (s) => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)
    )
  }, [skills, keyword])

  const selected = skills.find((s) => s.id === selectedId) ?? null

  const toggleEnabled = async (s: SkillRecord) => {
    await window.pocketai.saveSkill({ id: s.id, name: s.name, enabled: !s.enabled })
    load()
  }

  const handleDelete = async (s: SkillRecord) => {
    if (!window.confirm(t('skill.deleteConfirm', { name: s.name }))) return
    await window.pocketai.deleteSkill(s.id)
    if (selectedId === s.id) {
      setSelectedId(null)
      setMode('detail')
    }
    load()
  }

  return (
    <div className="flex gap-4 h-full">
      {/* 左侧：技能列表 */}
      <div className="w-60 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">{t('skill.title')}</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMarketOpen(true)}
              title={t('skill.market.title')}
              className="text-xs px-2 py-1 rounded bg-[var(--color-inline-code-bg)] hover:bg-[var(--color-hover-overlay)]"
            >
              🛒
            </button>
            <button
              onClick={() => {
                setMode('create')
                setSelectedId(null)
              }}
              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
            >
              {t('skill.new')}
            </button>
          </div>
        </div>
        <input
          className="input text-xs py-1 w-full mb-2"
          placeholder={t('skill.searchPh')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="space-y-1 overflow-y-auto flex-1">
          {filtered.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{t('skill.empty')}</p>
          )}
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setMode('detail')
                setSelectedId(s.id)
              }}
              className={`w-full text-left px-3 py-2 rounded text-sm ${
                mode === 'detail' && selectedId === s.id
                  ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-hover-overlay)]'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span>{s.icon}</span>
                <span className="truncate">{s.name}</span>
                {s.isBuiltin && (
                  <span className="text-[10px] px-1 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)] shrink-0">
                    {t('skill.builtin')}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 truncate">
                {s.enabled ? t('skill.on') : t('skill.off')}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧 */}
      <div className="flex-1 overflow-y-auto">
        {mode === 'create' ? (
          <SkillForm
            onSaved={() => {
              setMode('detail')
              load()
            }}
            onCancel={() => setMode('detail')}
          />
        ) : mode === 'edit' && selected && !selected.isBuiltin ? (
          <SkillForm
            skill={selected}
            onSaved={() => {
              setMode('detail')
              load()
            }}
            onCancel={() => setMode('detail')}
          />
        ) : selected ? (
          <SkillDetail
            skill={selected}
            onEdit={() => setMode('edit')}
            onToggle={() => toggleEnabled(selected)}
            onDelete={() => handleDelete(selected)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
            {t('skill.selectPrompt')}
          </div>
        )}
      </div>

      {/* 技能市场模态 */}
      {marketOpen && (
        <SkillMarket onClose={() => setMarketOpen(false)} onChanged={load} />
      )}
    </div>
  )
}

// ---------- 技能详情 ----------
const SkillDetail: React.FC<{
  skill: SkillRecord
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}> = ({ skill, onEdit, onToggle, onDelete }) => {
  const { t } = useI18n()
  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{skill.icon}</span>
          <div>
            <div className="font-semibold flex items-center gap-2">
              {skill.name}
              {skill.isBuiltin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]">
                  {t('skill.builtin')}
                </span>
              )}
            </div>
            {skill.description && (
              <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{skill.description}</div>
            )}
          </div>
        </div>
        <span
          className={`text-[11px] px-2 py-1 rounded ${
            skill.enabled
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
          }`}
        >
          {skill.enabled ? t('skill.on') : t('skill.off')}
        </span>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('skill.content')}</label>
        <pre className="input whitespace-pre-wrap font-mono text-xs leading-relaxed min-h-[160px] max-h-[50vh] overflow-y-auto">
          {skill.content}
        </pre>
      </div>

      <div className="flex gap-2">
        <button className="btn-ghost" onClick={onToggle}>
          {skill.enabled ? t('skill.disable') : t('skill.enable')}
        </button>
        {!skill.isBuiltin && (
          <>
            <button className="btn-ghost" onClick={onEdit}>
              {t('common.edit')}
            </button>
            <button
              className="btn-ghost text-[var(--color-danger)]"
              onClick={onDelete}
            >
              {t('common.delete')}
            </button>
          </>
        )}
      </div>

      <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
        {t('skill.usageHint')}
      </p>
    </div>
  )
}

// ---------- 技能创建/编辑表单 ----------
const SkillForm: React.FC<{
  skill?: SkillRecord
  onSaved: (s: SkillRecord) => void
  onCancel: () => void
}> = ({ skill, onSaved, onCancel }) => {
  const { t } = useI18n()
  const [icon, setIcon] = useState(skill?.icon ?? '⚡')
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [content, setContent] = useState(skill?.content ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('skill.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const saved = await window.pocketai.saveSkill({
        ...(skill?.id ? { id: skill.id } : {}),
        name: name.trim(),
        icon: icon.trim() || '⚡',
        description: description.trim(),
        content
      })
      onSaved(saved)
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex gap-3">
        <div className="w-20 shrink-0">
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('skill.icon')}</label>
          <input
            className="input text-center text-2xl"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={4}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('skill.name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('skill.desc')}</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('skill.content')}</label>
        <textarea
          className="input font-mono text-xs min-h-[200px] leading-relaxed"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('skill.contentPh')}
        />
      </div>

      {error && <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 rounded">{error}</div>}

      <div className="flex gap-2 pt-1">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
