// 技能管理模块：技能列表 / 创建编辑 / 启用开关 / 删除 / 市场（浏览/搜索/复制/导入导出）
// 技能 = 可复用提示词片段，关联到助手后自动注入 SystemPrompt
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { reportIpcError, hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { useToast } from '../../components/ToastProvider'
import { errText } from '../../utils/error'
import { SkillMarket } from './SkillMarket'
import { useConfirm } from '../../components/ConfirmDialog'

export const SkillModule: React.FC = () => {
  const { t } = useI18n()
  const { confirm, dialog } = useConfirm()
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'detail' | 'create' | 'edit'>('detail')
  const [marketOpen, setMarketOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const toast = useToast()

  // 返回最新列表供调用方复用：市场内写操作后市场与本页共享同一次 listSkills 结果，
  // 避免市场自刷 + 本页 onChanged 双查
  // 最后一次真正拉到的列表：拉失败时交回它，而不是把 undefined 交给调用方（onChanged 的返回值会被 setSkills 用）
  const lastList = useRef<SkillRecord[]>([])
  const load = useCallback(async () => {
    const list = await window.pocketai.listSkills()
    // §217：失败对象不是数组 ⇒ skills.filter/find 当场 TypeError
    if (hasIpcFailed(list)) {
      toast.error(ipcFailText(list, t('common.unknownError')))
      return lastList.current
    }
    lastList.current = list
    setSkills(list)
    return list
  }, [t, toast])
  useEffect(() => {
    // 打开技能页时自动同步内置（支持开发时热更新 + 生产环境首次载入）
    // §333：syncSkills 失败要说原因，不能只进 console ⇒ 改 await + 判信封
    ;(async () => {
      const r = await window.pocketai.syncSkills()
      if (hasIpcFailed(r)) toast.error(ipcFailText(r, t('common.unknownError')))
      load()
    })()
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
    const r = await window.pocketai.saveSkill({ id: s.id, name: s.name, enabled: !s.enabled })
    if (hasIpcFailed(r)) {
      toast.error(ipcFailText(r, t('common.unknownError')))
      return
    }
    load()
  }

  const toggleResident = async (s: SkillRecord) => {
    const r = await window.pocketai.saveSkill({ id: s.id, name: s.name, resident: !s.resident })
    if (hasIpcFailed(r)) {
      toast.error(ipcFailText(r, t('common.unknownError')))
      return
    }
    load()
  }

  const handleDelete = async (s: SkillRecord) => {
    if (!(await confirm({ message: t('skill.deleteConfirm', { name: s.name }), danger: true }))) return
    const r = await window.pocketai.deleteSkill(s.id)
    if (hasIpcFailed(r)) {
      toast.error(ipcFailText(r, t('common.unknownError')))
      return
    }
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
            onToggleResident={() => void toggleResident(selected)}
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

      {dialog}
    </div>
  )
}

/**
 * 技能自带的文件（§236 第三层）。三张脸分开：读不到／确实没有／有清单。
 * "读不到"演成"没有"是这一族的老毛病（§222／§226），所以这里宁可多一句。
 */
const SkillFilesPanel: React.FC<{ skillId: string }> = ({ skillId }) => {
  const { t } = useI18n()
  const [files, setFiles] = useState<Array<{ path: string; size: number }> | null>(null)
  const [unread, setUnread] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFiles(null)
    setUnread(null)
    void window.pocketai
      .listSkillFiles(skillId)
      .then((r) => {
        if (cancelled) return
        if (hasIpcFailed(r) || r.ok !== true) {
          setUnread(ipcFailText(r, t('skill.filesUnread')))
          return
        }
        setFiles(r.files)
      })
      .catch((e) => {
        reportIpcError('skills.listFiles')(e)
        if (!cancelled) setUnread(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [skillId, t])

  return (
    <div>
      <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('skill.files')}</label>
      {unread && (
        <div data-testid="skill-files-unread" className="text-xs text-[var(--color-danger)]" title={unread}>
          {t('skill.filesUnread')}
        </div>
      )}
      {!unread && files === null && <div className="text-xs">{t('common.loading')}</div>}
      {!unread && files !== null && files.length === 0 && (
        <div data-testid="skill-files-empty" className="text-xs text-[var(--color-text-muted)]">
          {t('skill.filesEmpty')}
        </div>
      )}
      {!unread && files !== null && files.length > 0 && (
        <ul data-testid="skill-files-list" className="text-xs space-y-0.5">
          {files.map((f) => (
            <li key={f.path} className="font-mono">
              {f.path} <span className="text-[var(--color-text-muted)]">({f.size})</span>
            </li>
          ))}
          <li className="text-[var(--color-text-muted)] mt-1">{t('skill.filesHint')}</li>
        </ul>
      )}
    </div>
  )
}

// ---------- 技能详情 ----------
const SkillDetail: React.FC<{
  skill: SkillRecord
  onEdit: () => void
  onToggle: () => void
  onToggleResident: () => void
  onDelete: () => void
}> = ({ skill, onEdit, onToggle, onToggleResident, onDelete }) => {
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
                <span className="badge badge-muted">
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

      {/* §236：常驻 vs 按需。默认常驻=今天的行为；关到按需后正文不再每次请求都带，模型要用时调 load_skill */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          data-testid="skill-resident-badge"
          className={`text-[11px] px-2 py-1 rounded ${
            skill.resident
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
          }`}
        >
          {skill.resident ? t('skill.residentOn') : t('skill.residentOff')}
        </span>
        <button className="btn-ghost" onClick={onToggleResident}>
          {skill.resident ? t('skill.makeOnDemand') : t('skill.makeResident')}
        </button>
        <span className="text-xs text-[var(--color-text-muted)]">{t('skill.residentHint')}</span>
      </div>

      <SkillFilesPanel skillId={skill.id} />

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
  const [validation, setValidation] = useState<{ ok: boolean; warnings: string[] } | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string; shape: { name: string; description: string; icon: string; content: string } }>>([])

  /**
   * §273：改前这里的注释写着「失败仅记诊断日志，保持空列表不影响 UI」——**这条是错的**，回读 JSX 后改口：
   * 模板入口那一整块的条件是 `!skill && templates.length > 0`，失败时列表停在 `[]`
   * ⇒ 新建技能表单里那颗「+ 从模板创建」**整颗消失**＝把"模板读不到"演成"没有模板可用"，
   * 而且抹掉的是入口本身，用户连试都没法试。这一发只有挂载一处读 ⇒ 配一颗重试键，那句挂在入口原位。
   */
  const [templatesUnread, setTemplatesUnread] = useState<{ error?: string } | null>(null)

  const loadTemplates = useCallback(() => {
    window.pocketai
      .getSkillTemplates()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setTemplatesUnread({ error: v.error })
          return
        }
        setTemplatesUnread(null)
        setTemplates(v)
      })
      .catch((e: unknown) => {
        setTemplatesUnread({ error: errText(e, '') })
        logIpcError('skills.getTemplates', e)
      })
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  // 实时校验（防抖 500ms）
  useEffect(() => {
    if (!content && !name) {
      setValidation(null)
      return
    }
    const text = JSON.stringify({ name, description, icon, content })
    const timer = setTimeout(() => {
      // 实时校验为后台辅助，失败仅记诊断日志，保持原校验状态不打断输入
      window.pocketai.validateSkill(text).then((r) => setValidation({ ok: r.ok, warnings: r.warnings })).catch(reportIpcError('skills.validate'))
    }, 500)
    return () => clearTimeout(timer)
  }, [name, description, icon, content])

  const applyTemplate = (tpl: { name: string; description: string; icon: string; content: string }) => {
    setName(tpl.name)
    setDescription(tpl.description)
    setIcon(tpl.icon)
    setContent(tpl.content)
    setShowTemplates(false)
  }

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
      // 失败不判就 onSaved(失败对象) ⇒ 表单关掉、正在写的技能内容丢掉，列表里也没有它（§216）
      if (hasIpcFailed(saved)) {
        setError(ipcFailText(saved, t('common.unknownError')))
        return
      }
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

      {/* 实时校验结果 */}
      {validation && (
        <div className={`text-xs px-3 py-2 rounded ${validation.ok ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'}`}>
          {validation.ok ? '✓ 技能格式合法' : '✗ 技能格式不合法'}
          {validation.warnings.length > 0 && (
            <ul className="mt-1 list-disc list-inside opacity-80">
              {validation.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* 模板选择 */}
      {!skill && templatesUnread && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice
            what={t('common.skillTemplatesList')}
            msg={ipcFailText(templatesUnread, t('common.unknownError'))}
          />
          <button
            data-testid="skill-form-templates-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={loadTemplates}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )}
      {!skill && !templatesUnread && templates.length > 0 && (
        <div>
          <button className="btn-ghost text-xs" onClick={() => setShowTemplates(!showTemplates)}>
            {showTemplates ? '− 收起模板' : '+ 从模板创建'}
          </button>
          {showTemplates && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  className="text-left p-3 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)] transition-colors"
                  onClick={() => applyTemplate(tpl.shape)}
                >
                  <div className="font-medium text-sm">{tpl.name}</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{tpl.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
