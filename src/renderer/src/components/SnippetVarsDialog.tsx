// 片段变量填充层：选中含 {{变量}} 的片段后收集变量值再插入输入框。
// 供 SlashMenu 选中片段时使用（chat / Agent 双侧 Composer 共用），
// 与 SnippetButton 内部 vars 态同款交互，但定位为 absolute（跟随 Composer 容器）。
import React, { useState } from 'react'
import { useI18n } from '../i18n'
import { applyTemplateVars, extractTemplateVars } from '../utils/snippet-template'
import type { PromptSnippetRecord } from '../../../shared/types'

interface Props {
  snippet: PromptSnippetRecord
  onCancel: () => void
  onInsert: (text: string) => void
}

export const SnippetVarsDialog: React.FC<Props> = ({ snippet, onCancel, onInsert }) => {
  const { t } = useI18n()
  const vars = extractTemplateVars(snippet.content)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v, '']))
  )

  const insert = () => onInsert(applyTemplateVars(snippet.content, values))

  return (
    <div className="absolute bottom-full left-4 right-4 mb-2 z-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] shadow-lg p-3 flex flex-col gap-2">
      <span className="text-xs font-semibold text-[var(--color-text)]">
        {t('snippet.varTitle', { title: snippet.title })}
      </span>
      {vars.map((name, i) => (
        <div key={name} className="flex flex-col gap-1">
          <label className="text-[11px] text-[var(--color-text-muted)]">{name}</label>
          <input
            value={values[name] ?? ''}
            onChange={(e) => setValues((p) => ({ ...p, [name]: e.target.value }))}
            placeholder={t('snippet.varPh')}
            autoFocus={i === 0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                insert()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              }
            }}
            className="input text-xs w-full"
          />
        </div>
      ))}
      <div className="flex justify-end gap-2 mt-1">
        <button type="button" onClick={onCancel} className="btn-ghost text-xs px-2 py-1">
          {t('snippet.cancel')}
        </button>
        <button type="button" onClick={insert} className="btn-primary text-xs px-2 py-1">
          {t('snippet.insert')}
        </button>
      </div>
    </div>
  )
}
