// Agent 底部输入区：附件预览/拖拽/选择 + 斜杠快捷指令 + 输入框 + 发送/停止
import React, { useMemo, useState } from 'react'
import { useI18n } from '../../../i18n'
import type { useAttachments } from '../hooks/useAttachments'
import { SlashCommandMenu } from './SlashCommandMenu'
import { filterSlashCommands, getSlashQuery, type SlashCommand } from '../agent-shared'

interface Props {
  running: boolean
  canSend: boolean
  att: ReturnType<typeof useAttachments>
  onSend: (text: string) => void
  onAbort: () => void
}

/** 斜杠指令定义顺序（触发词固定英文，显示名/模板走 i18n） */
const SLASH_NAMES = ['summary', 'translate', 'polish', 'explain', 'continue', 'review'] as const

export const AgentComposer: React.FC<Props> = ({ running, canSend, att, onSend, onAbort }) => {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const { attachments, dragOver, removeAt, clear, openPicker, fileInputProps, dropZoneProps } = att

  // 内置斜杠指令（label/template 随界面语言）
  const commands = useMemo<SlashCommand[]>(
    () =>
      SLASH_NAMES.map((name) => ({
        name,
        label: t(`agent.slash.${name}`),
        template: t(`agent.slash.${name}Tpl`)
      })),
    [t]
  )

  // 当前斜杠查询（null=非指令态）；Esc 后本轮 dismissed
  const slashQuery = slashDismissed ? null : getSlashQuery(input)
  const filtered = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(commands, slashQuery)),
    [slashQuery, commands]
  )
  const menuOpen = slashQuery !== null && filtered.length > 0

  // 过滤结果变化时高亮回到第一项
  React.useEffect(() => {
    setActiveIndex(0)
  }, [slashQuery])

  const handleInputChange = (value: string) => {
    setInput(value)
    // 重新输入 / 开头时解除 Esc 关闭状态
    if (getSlashQuery(value) !== null) setSlashDismissed(false)
  }

  const pickCommand = (index: number) => {
    const cmd = filtered[index]
    if (!cmd) return
    setInput(`${cmd.template} `)
    setSlashDismissed(false)
  }

  const doSend = () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !canSend || running) return
    onSend(text)
    // 乐观清空（与原实现一致，不等待 IPC）
    setInput('')
    setSlashDismissed(false)
    clear()
  }

  return (
    <>
      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2">
          {attachments.map((attachment, i) => (
            <div key={`${attachment.name}-${attachment.size}`} className="relative group flex items-center gap-1.5 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg pl-1.5 pr-7 py-1 text-xs">
              {attachment.type === 'image' ? (
                <img src={attachment.data} alt={attachment.name} className="w-6 h-6 rounded object-cover" />
              ) : (
                <span>📄</span>
              )}
              <span className="max-w-[120px] truncate text-[var(--color-text)]">{attachment.name}</span>
              <button
                onClick={() => removeAt(i)}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* 输入 */}
      <div
        className={`relative flex gap-2 pt-2 border-t border-[var(--color-border)] mt-2 rounded-b-xl ${
          dragOver ? 'ring-2 ring-[var(--color-accent)]' : ''
        }`}
        {...dropZoneProps}
      >
        {menuOpen && (
          <SlashCommandMenu
            commands={filtered}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={pickCommand}
          />
        )}
        <input {...fileInputProps} />
        <button
          onClick={openPicker}
          title={t('common.attachFile')}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          data-agent-composer-input
          className="input flex-1 text-sm min-h-[40px] max-h-[120px] resize-none"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIndex((i) => (i + 1) % filtered.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickCommand(activeIndex)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlashDismissed(true)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              doSend()
            }
          }}
          placeholder={t('agent.inputPh')}
          title={t('agent.composerTitle')}
          disabled={running}
        />
        {running ? (
          <button className="btn-ghost" onClick={onAbort}>{t('common.stop')}</button>
        ) : (
          <button
            className="btn-primary"
            onClick={doSend}
            disabled={(!input.trim() && attachments.length === 0) || !canSend}
          >
            {t('common.send')}
          </button>
        )}
      </div>
    </>
  )
}
