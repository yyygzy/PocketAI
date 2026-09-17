// 对话配置条：挂在输入框下方，快捷管理当前助手的技能/知识库，以及临时提示词覆盖
// 工具权限仅 Agent 模式生效，统一在助手编辑器里配置，不在对话页展示
import React, { useState } from 'react'
import type { AssistantRecord, KnowledgeBase, SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'

interface Props {
  assistant: AssistantRecord | null
  onAssistantUpdated: (a: AssistantRecord) => void
  tempPrompt: string
  onTempPromptChange: (s: string) => void
}

type Section = 'skills' | 'kb' | 'temp' | null

export const ChatConfigBar: React.FC<Props> = ({
  assistant,
  onAssistantUpdated,
  tempPrompt,
  onTempPromptChange
}) => {
  const { t } = useI18n()
  const [open, setOpen] = useState<Section>(null)
  const [skills, setSkills] = useState<SkillRecord[] | null>(null)
  const [kbs, setKbs] = useState<KnowledgeBase[] | null>(null)

  const toggleSection = async (s: Exclude<Section, null>) => {
    if (open === s) {
      setOpen(null)
      return
    }
    setOpen(s)
    if (s === 'skills' && skills === null) {
      window.pocketai.listSkills().then(setSkills)
    } else if (s === 'kb' && kbs === null) {
      window.pocketai.listKnowledgeBases().then(setKbs)
    }
  }

  /** 修改助手单个 id 数组字段并保存（整条记录下发，避免覆盖丢失） */
  const toggleId = async (field: 'skillIds' | 'knowledgeBaseIds', id: string) => {
    if (!assistant) return
    const cur = assistant[field] ?? []
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    const saved = await window.pocketai.saveAssistant({ ...assistant, [field]: next })
    onAssistantUpdated(saved)
  }

  const chipCls = (on: boolean) =>
    `text-[11px] px-2 py-1 rounded border ${
      on
        ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
    }`

  const barBtn = (active: boolean) =>
    `text-[11px] px-2 py-1 rounded-md border transition-colors ${
      active
        ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
        : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
    }`

  if (!assistant) return null

  const skillCount = assistant.skillIds?.length ?? 0
  const kbCount = assistant.knowledgeBaseIds?.length ?? 0

  return (
    <div className="max-w-3xl mx-auto mt-1.5">
      {/* 快捷按钮行 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button className={barBtn(open === 'skills')} onClick={() => toggleSection('skills')}>
          ⚡ {t('ccb.skills')} <span className="opacity-60">({skillCount})</span>
        </button>
        <button className={barBtn(open === 'kb')} onClick={() => toggleSection('kb')}>
          📚 {t('ccb.kb')} <span className="opacity-60">({kbCount})</span>
        </button>
        <button className={barBtn(open === 'temp' || !!tempPrompt.trim())} onClick={() => toggleSection('temp')}>
          📝 {t('ccb.tempPrompt')}
          {tempPrompt.trim() && <span className="ml-1 text-[var(--color-accent)]">●</span>}
        </button>
      </div>

      {/* 展开面板 */}
      {open && (
        <div className="mt-1.5 border border-[var(--color-border)] rounded-xl p-3 space-y-2 bg-[var(--color-bg)]">
          {assistant.isBuiltin && open !== 'temp' ? (
            <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.builtinHint')}</p>
          ) : open === 'skills' ? (
            <>
              {skills === null ? null : skills.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.none')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {skills.map((s) => (
                    <button
                      key={s.id}
                      className={chipCls(assistant.skillIds?.includes(s.id) ?? false)}
                      title={s.description}
                      onClick={() => toggleId('skillIds', s.id)}
                    >
                      {s.icon} {s.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : open === 'kb' ? (
            <>
              {kbs === null ? null : kbs.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.none')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {kbs.map((k) => (
                    <button
                      key={k.id}
                      className={chipCls(assistant.knowledgeBaseIds?.includes(k.id) ?? false)}
                      title={k.description}
                      onClick={() => toggleId('knowledgeBaseIds', k.id)}
                    >
                      📚 {k.name}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[var(--color-text-muted)]">{t('ccb.kbHint')}</p>
            </>
          ) : (
            <>
              <textarea
                className="input text-xs min-h-[64px] resize-y"
                value={tempPrompt}
                onChange={(e) => onTempPromptChange(e.target.value)}
                placeholder={t('ccb.tempPh')}
              />
              <div className="flex justify-end">
                {tempPrompt && (
                  <button className="text-[11px] px-2 py-1 rounded btn-ghost" onClick={() => onTempPromptChange('')}>
                    {t('ccb.clear')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
