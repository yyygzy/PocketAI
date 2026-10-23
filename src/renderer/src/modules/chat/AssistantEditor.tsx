import React, { useCallback, useEffect, useState } from 'react'
import type { AssistantRecord, ProviderRecord, KnowledgeBase, ToolSchema, SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { hasIpcFailed, isIpcFail, ipcFailText, logIpcError } from '../../utils/ipc'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { errText } from '../../utils/error'

interface Props {
  initial: Partial<AssistantRecord>
  providers: ProviderRecord[]
  onCancel: () => void
  onSaved: (a: AssistantRecord) => void
}

const VARIABLE_KEYS = ['ae.var.date', 'ae.var.time', 'ae.var.weekday', 'ae.var.user', 'ae.var.knowledge', 'ae.var.tools', 'ae.var.skills']

export const AssistantEditor: React.FC<Props> = ({ initial, providers, onCancel, onSaved }) => {
  const { t } = useI18n()
  const [avatar, setAvatar] = useState(initial.avatar ?? '🤖')
  const [name, setName] = useState(initial.name ?? '')
  const [description, setDescription] = useState(initial.description ?? '')
  const [welcomeMessage, setWelcomeMessage] = useState(initial.welcomeMessage ?? '')
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '')
  const [providerId, setProviderId] = useState(initial.defaultProviderId ?? '')
  const [model, setModel] = useState(initial.defaultModel ?? '')
  const [kbIds, setKbIds] = useState<string[]>(initial.knowledgeBaseIds ?? [])
  const [skillIds, setSkillIds] = useState<string[]>(initial.skillIds ?? [])
  const [toolPermissions, setToolPermissions] = useState<string[]>(initial.toolPermissions ?? [])
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [skills, setSkills] = useState<SkillRecord[]>([])
  /**
   * §270：这三发清单读失败时过去什么都不做 ⇒ 三块勾选区各摆「尚未创建知识库／暂无可用技能／暂无可用工具」，
   * 把通道故障演成"这台没配"——而这里是新建／编辑助手的必经屏。三份是**不同数据**，各挂一句（§268 口径，
   * 不是 §269 那种"同一份数据两次取并一张脸"）。
   */
  const [kbsUnread, setKbsUnread] = useState<{ error?: string } | null>(null)
  const [toolsUnread, setToolsUnread] = useState<{ error?: string } | null>(null)
  const [skillsUnread, setSkillsUnread] = useState<{ error?: string } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // ---------- 三份清单读（§270）：两条失败路各写原因、读到即收回；失败侧保持上一份 ----------
  /**
   * 三发都在挂载读，**只有关掉编辑器再开才会重拉**——那要丢掉正在填的名称、SystemPrompt 与已勾的选项，
   * 出口代价大到等于没出口 ⇒ 按 §268 的判据每发各配一颗重试键（各点各的发，不是一把键重发三份）。
   */
  const loadKbs = useCallback(() => {
    window.pocketai.listKnowledgeBases()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setKbsUnread({ error: v.error })
          return
        }
        setKbsUnread(null)
        setKbs(v)
      })
      .catch((e: unknown) => {
        setKbsUnread({ error: errText(e, '') })
        logIpcError('assistantEditor.listKbs', e)
      })
  }, [])

  const loadTools = useCallback(() => {
    window.pocketai.listAvailableTools()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setToolsUnread({ error: v.error })
          return
        }
        setToolsUnread(null)
        setTools(v)
      })
      .catch((e: unknown) => {
        setToolsUnread({ error: errText(e, '') })
        logIpcError('assistantEditor.listTools', e)
      })
  }, [])

  const loadSkills = useCallback(() => {
    window.pocketai.listSkills()
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
        logIpcError('assistantEditor.listSkills', e)
      })
  }, [])

  useEffect(() => {
    loadKbs()
    loadTools()
    loadSkills()
    // 三发都是挂载那一次的读；三根 loader 都是 useCallback([]) ⇒ 依赖恒稳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** §270：三份清单共用那句一键的形状。键放在 alert 盒子**外面**（§268：盒子里的话会被算进句子的 textContent） */
  const listFailLine = (what: string, fail: { error?: string }, testid: string, retry: () => void): React.ReactNode => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <LoadFailNotice what={what} msg={ipcFailText(fail, t('common.unknownError'))} />
      <button
        data-testid={testid}
        className="text-xs underline text-[var(--color-text-muted)]"
        onClick={retry}
      >
        {t('agent.retryRead')}
      </button>
    </div>
  )

  const enabledProviders = providers.filter((p) => p.enabled)
  const provider = enabledProviders.find((p) => p.id === providerId)

  const toggleKb = (id: string) => {
    setKbIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }
  const toggleSkill = (id: string) => {
    setSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }
  const toggleTool = (id: string) => {
    setToolPermissions((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }
  const toggleAllowAll = () => {
    setToolPermissions((prev) => (prev.includes('*') ? prev.filter((x) => x !== '*') : ['*']))
  }

  // 工具分组：内置 vs MCP
  const builtinTools = tools.filter((t) => t.source !== 'mcp')
  const mcpTools = tools.filter((t) => t.source === 'mcp')
  const allowAll = toolPermissions.includes('*')

  const selectGroup = (group: ToolSchema[]) => {
    setToolPermissions((prev) => {
      const next = prev.filter((id) => !group.some((t) => t.id === id))
      return [...next, ...group.map((t) => t.id)]
    })
  }
  const clearGroup = (group: ToolSchema[]) => {
    setToolPermissions((prev) => prev.filter((id) => !group.some((t) => t.id === id)))
  }

  const chipCls = (on: boolean) =>
    `text-[11px] px-2 py-1 rounded border ${
      on
        ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
    }`

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('ae.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const saved = await window.pocketai.saveAssistant({
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        avatar: avatar.trim() || '🤖',
        description: description.trim(),
        welcomeMessage: welcomeMessage.trim(),
        systemPrompt,
        defaultProviderId: providerId || null,
        defaultModel: providerId && model ? model : null,
        knowledgeBaseIds: kbIds,
        skillIds,
        toolPermissions
      })
      // 196：safeHandle 把「助手数量超限」这类抛错转成 {ok:false} 返回值，不是 rejection
      // ⇒ 只挂 catch 会照常走 onSaved，界面闪一句「已保存」而实际什么都没存。
      if (isIpcFail(saved)) {
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
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="w-20 shrink-0">
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.avatar')}</label>
          <input
            className="input text-center text-2xl"
            value={avatar}
            onChange={(e) => setAvatar(e.target.value)}
            maxLength={4}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.description')}</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.welcome')}</label>
        <input className="input" value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.defaultModel')}</label>
        <div className="flex gap-2">
          <select className="select-mini flex-1" value={providerId} onChange={(e) => { setProviderId(e.target.value); setModel('') }}>
            <option value="">{t('ae.followCurrent')}</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {provider && provider.models.length > 0 && (
            <select className="select-mini flex-1" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t('ae.selectModel')}</option>
              {provider.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.prompt')}</label>
        <textarea
          className="input font-mono text-xs min-h-[180px] leading-relaxed"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t('ae.promptPh')}
        />
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {VARIABLE_KEYS.map((vk) => (
            <span key={vk} className="badge badge-muted">
              {t(vk)}
            </span>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('ae.kbLabel')}
        </label>
        {kbsUnread ? (
          listFailLine(t('common.kbList'), kbsUnread, 'assistant-editor-kbs-retry', loadKbs)
        ) : kbs.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('ae.noKb')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {kbs.map((kb) => (
              <button
                key={kb.id}
                onClick={() => toggleKb(kb.id)}
                className={chipCls(kbIds.includes(kb.id))}
              >
                {kb.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('ae.skillsLabel')}
        </label>
        {skillsUnread ? (
          listFailLine(t('common.skillsList'), skillsUnread, 'assistant-editor-skills-retry', loadSkills)
        ) : skills.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('ae.noSkills')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {skills.map((sk) => (
              <button
                key={sk.id}
                onClick={() => toggleSkill(sk.id)}
                title={sk.description}
                className={chipCls(skillIds.includes(sk.id))}
              >
                {sk.icon} {sk.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('ae.toolsLabel')}
        </label>
        <div className="flex flex-wrap gap-1.5 mb-1">
          <button onClick={toggleAllowAll} className={chipCls(allowAll)}>
            {t('ae.allowAll')}
          </button>
        </div>
        {toolsUnread ? (
          listFailLine(t('common.toolsList'), toolsUnread, 'assistant-editor-tools-retry', loadTools)
        ) : (
          tools.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('ae.noTools')}
            </p>
          )
        )}
        {builtinTools.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                ⚡ {t('ae.groupBuiltin')}
              </span>
              <button
                onClick={() => selectGroup(builtinTools)}
                disabled={allowAll}
                className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] disabled:opacity-40"
              >
                {t('ae.selectAll')}
              </button>
              <button
                onClick={() => clearGroup(builtinTools)}
                disabled={allowAll}
                className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] disabled:opacity-40"
              >
                {t('ae.clearAll')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {builtinTools.map((tl) => (
                <button
                  key={tl.id}
                  onClick={() => toggleTool(tl.id)}
                  disabled={allowAll}
                  title={tl.description}
                  className={`${chipCls(allowAll || toolPermissions.includes(tl.id))} ${
                    allowAll ? 'opacity-60' : ''
                  }`}
                >
                  ⚡ {tl.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {mcpTools.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                🔌 {t('ae.groupMcp')}
              </span>
              <button
                onClick={() => selectGroup(mcpTools)}
                className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              >
                {t('ae.selectAll')}
              </button>
              <button
                onClick={() => clearGroup(mcpTools)}
                className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              >
                {t('ae.clearAll')}
              </button>
            </div>
            {/* 允许全部(*) 不覆盖 MCP，所以这一组始终可点、勾选态只按显式 id 显示 */}
            <p className="text-[10px] text-[var(--color-text-muted)] mb-1">{t('ae.mcpNotInAll')}</p>
            <div className="flex flex-wrap gap-1.5">
              {mcpTools.map((tl) => (
                <button
                  key={tl.id}
                  onClick={() => toggleTool(tl.id)}
                  title={tl.description}
                  className={chipCls(toolPermissions.includes(tl.id))}
                >
                  🔌 {tl.name}
                </button>
              ))}
            </div>
          </div>
        )}
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
