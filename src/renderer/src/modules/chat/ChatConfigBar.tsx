// 对话配置条
// - 技能 / 知识库 收纳为一个「上下文」按钮，默认收起，降低视觉噪音
// - 按钮角标显示已配置项总数
import React, { useState } from 'react'
import type { AssistantRecord, KnowledgeBase, SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { reportIpcError } from '../../utils/ipc'

interface Props {
  assistant: AssistantRecord | null
  onAssistantUpdated: (a: AssistantRecord) => void
}

type Section = 'skills' | 'kb' | null

export const ChatConfigBar: React.FC<Props> = ({ assistant, onAssistantUpdated }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<Section>(null)
  const [skills, setSkills] = useState<SkillRecord[] | null>(null)
  const [kbs, setKbs] = useState<KnowledgeBase[] | null>(null)

  const toggleSection = async (s: Exclude<Section, null>) => {
    setSection((prev) => (prev === s ? null : s))
    if (s === 'skills' && skills === null) {
      window.pocketai.listSkills().then(setSkills).catch(reportIpcError('chatConfig.listSkills'))
    } else if (s === 'kb' && kbs === null) {
      window.pocketai.listKnowledgeBases().then(setKbs).catch(reportIpcError('chatConfig.listKnowledgeBases'))
    }
  }

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

  if (!assistant) return null

  const skillCount = assistant.skillIds?.length ?? 0
  const kbCount = assistant.knowledgeBaseIds?.length ?? 0
  const total = skillCount + kbCount

  return (
    <div className="max-w-3xl mx-auto mt-1.5">
      {/* 单一入口：上下文 */}
      <div className="flex items-center gap-1.5">
        <button
          className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
            open || total > 0
              ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
          }`}
          onClick={() => {
            setOpen((o) => !o)
            if (open) setSection(null)
          }}
          title={t('ccb.context')}
        >
          ⚙ {t('ccb.context')}
          {total > 0 && <span className="ml-1 opacity-70">({total})</span>}
        </button>
      </div>

      {/* 展开面板 */}
      {open && (
        <div className="mt-1.5 border border-[var(--color-border)] rounded-xl p-3 space-y-2 bg-[var(--color-bg)]">
          {/* 子入口 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              className={`text-[11px] px-2 py-1 rounded border ${
                section === 'skills'
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
              }`}
              onClick={() => toggleSection('skills')}
            >
              ⚡ {t('ccb.skills')} <span className="opacity-60">({skillCount})</span>
            </button>
            <button
              className={`text-[11px] px-2 py-1 rounded border ${
                section === 'kb'
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
              }`}
              onClick={() => toggleSection('kb')}
            >
              📚 {t('ccb.kb')} <span className="opacity-60">({kbCount})</span>
            </button>
          </div>

          {/* 子面板 */}
          {section && (
            <div className="pt-2 border-t border-[var(--color-border)]">
              {assistant.isBuiltin ? (
                <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.builtinHint')}</p>
              ) : section === 'skills' ? (
                skills === null ? null : skills.length === 0 ? (
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
                )
              ) : (
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
                  <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{t('ccb.kbHint')}</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
