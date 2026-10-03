// Agent 底部输入区：附件预览/拖拽/选择 + 斜杠快捷指令 + 提示词片段 + 输入框 + 发送/停止
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n'
import { SnippetButton } from '../../../components/SnippetButton'
import { SlashMenu } from '../../../components/SlashMenu'
import { MentionMenu, type MentionItem } from '../../../components/MentionMenu'
import { SnippetVarsDialog } from '../../../components/SnippetVarsDialog'
import type { useAttachments } from '../hooks/useAttachments'
import {
  getSnippetTrigger,
  snippetToCommand,
  filterSnippetCommands,
  buildBuiltinSlashCommands,
  type SlashCommand
} from '../../../utils/snippet-slash'
import { getMentionQuery, filterMentionKbs } from '../../../utils/mention'
import { extractTemplateVars } from '../../../utils/snippet-template'
import type { KnowledgeBase, PromptSnippetRecord } from '../../../../../shared/types'

interface Props {
  running: boolean
  canSend: boolean
  att: ReturnType<typeof useAttachments>
  onSend: (text: string) => void
  onAbort: () => void
}

export const AgentComposer: React.FC<Props> = ({ running, canSend, att, onSend, onAbort }) => {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const { attachments, dragOver, removeAt, clear, openPicker, fileInputProps, dropZoneProps, pasteProps } = att

  // 用户片段（首次触发时惰性拉取）
  const snippetsRef = useRef<PromptSnippetRecord[] | null>(null)
  const [snippetsReady, setSnippetsReady] = useState(0) // 仅作刷新信号

  // 变量填充态
  const [varSnippet, setVarSnippet] = useState<PromptSnippetRecord | null>(null)

  // @ 触发 mention 面板
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  // 知识库列表（首次触发时惰性拉取）
  const kbsRef = useRef<KnowledgeBase[] | null>(null)

  // 内置指令（随界面语言变化）
  const builtins = useMemo<SlashCommand[]>(() => buildBuiltinSlashCommands(t), [t])

  // 当前触发态（光标位置取自 textarea selectionStart）
  const cursor = taRef.current?.selectionStart ?? input.length
  const triggerInfo = slashDismissed ? null : getSnippetTrigger(input, cursor)
  const trigger = triggerInfo?.trigger ?? null

  // 合并命令列表：/ = builtin + snippets；# = snippets only
  const allCommands = useMemo<SlashCommand[]>(() => {
    const snippetCmds = (snippetsRef.current ?? []).map(snippetToCommand)
    if (trigger === '#') return snippetCmds
    if (trigger === '/') return [...builtins, ...snippetCmds]
    return []
  }, [trigger, builtins, snippetsReady])

  const filtered = useMemo(() => {
    if (!triggerInfo) return []
    return filterSnippetCommands(allCommands, triggerInfo.query)
  }, [triggerInfo, allCommands])

  const menuOpen = trigger !== null

  // @ 触发态
  const mentionInfo = mentionDismissed ? null : getMentionQuery(input, cursor)
  const mentionItems = useMemo<MentionItem[]>(() => {
    if (!mentionInfo) return []
    const q = mentionInfo.query
    // 选择新文件
    const newFile = [{ type: 'newFile' as const, label: t('mention.newFile'), value: 'newFile' }]
    // 知识库
    const kbList = filterMentionKbs(kbsRef.current ?? [], q).map((kb) => ({
      type: 'kb' as const,
      label: kb.name,
      meta: `${kb.documentCount} ${t('common.docs')}`,
      value: kb.id
    }))
    return [...newFile, ...kbList]
  }, [mentionInfo, t])

  const mentionMenuOpen = mentionInfo !== null

  // @ 触发词变化时高亮回到第一项
  useEffect(() => {
    setMentionIndex(0)
  }, [mentionInfo?.query])

  // 首次进入 @ 触发态时惰性拉取知识库列表
  useEffect(() => {
    if (mentionInfo && kbsRef.current === null) {
      kbsRef.current = [] // 占位防并发重复拉取
      window.pocketai.listKnowledgeBases()
        .then((list) => {
          kbsRef.current = list
        })
        .catch(() => {})
    }
  }, [mentionInfo])

  // 过滤结果变化时高亮回到第一项
  useEffect(() => {
    setActiveIndex(0)
  }, [triggerInfo?.query])

  // 首次触发时惰性拉取片段列表
  useEffect(() => {
    if (trigger && snippetsRef.current === null) {
      window.pocketai.listPromptSnippets()
        .then((list) => {
          snippetsRef.current = list
          setSnippetsReady((n) => n + 1)
        })
        .catch(() => {})
    }
  }, [trigger])

  const handleInputChange = (value: string) => {
    setInput(value)
    if (getSnippetTrigger(value) !== null) setSlashDismissed(false)
  }

  // 片段变量填充弹出时保存当时的触发位置
  const pendingReplaceRef = useRef<{ startPos: number } | null>(null)

  /** 替换区间 [startPos, 当前光标] 为指定内容 */
  const replaceTriggerRange = useCallback(
    (content: string, startPos?: number) => {
      const sp = startPos ?? triggerInfo?.startPos
      if (sp === undefined) return
      const cur = taRef.current?.selectionStart ?? input.length
      const next = input.slice(0, sp) + content + input.slice(cur)
      setInput(next)
      requestAnimationFrame(() => {
        const ta = taRef.current
        ta?.focus()
        const pos = sp + content.length
        ta?.setSelectionRange(pos, pos)
      })
    },
    [triggerInfo, input]
  )

  /** 选中菜单项：片段含 {{var}} 先弹变量填充层，否则直接替换触发区间 */
  const pickCommand = useCallback(
    (index: number) => {
      const cmd = filtered[index]
      if (!cmd) return
      const info = triggerInfo
      if (!info) return
      if (cmd.kind === 'snippet') {
        const snippetId = cmd.name.replace(/^snippet:/, '')
        const snippet = snippetsRef.current?.find((s) => s.id === snippetId)
        if (!snippet) return
        if (extractTemplateVars(snippet.content).length > 0) {
          pendingReplaceRef.current = { startPos: info.startPos }
          setVarSnippet(snippet)
          return
        }
        replaceTriggerRange(snippet.content, info.startPos)
        return
      }
      replaceTriggerRange(`${cmd.template} `, info.startPos)
    },
    [filtered, triggerInfo, replaceTriggerRange]
  )

  const doSend = () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !canSend || running) return
    onSend(text)
    setInput('')
    setSlashDismissed(false)
    clear()
    setVarSnippet(null)
  }

  // 提示词片段按钮：在 textarea 光标处替换选区插入
  const insertAtCursor = (insert: string) => {
    const ta = taRef.current
    const start = ta?.selectionStart ?? input.length
    const end = ta?.selectionEnd ?? start
    const next = input.slice(0, start) + insert + input.slice(end)
    setInput(next)
    requestAnimationFrame(() => {
      ta?.focus()
      const pos = start + insert.length
      ta?.setSelectionRange(pos, pos)
    })
  }

  /** 选中 @ 菜单项：知识库追加为 kb chip，文件追加为普通附件 */
  const pickMentionItem = (index: number) => {
    const item = mentionItems[index]
    if (!item) return
    const info = mentionInfo
    if (!info) return
    // 先移除触发区间文本（@query）
    const next = input.slice(0, info.startPos) + input.slice(taRef.current?.selectionStart ?? input.length)
    setInput(next)
    if (item.type === 'kb') {
      const kb = (kbsRef.current ?? []).find((k) => k.id === item.value)
      if (!kb) return
      att.addAttachment({
        type: 'kb',
        name: kb.name,
        mimeType: '',
        size: 0,
        data: '',
        kbId: kb.id
      })
    }
    requestAnimationFrame(() => {
      taRef.current?.focus()
    })
  }

  /** 选择新文件：触发隐藏 file input */
  const pickMentionNewFile = () => {
    const info = mentionInfo
    if (info) {
      const next = input.slice(0, info.startPos) + input.slice(taRef.current?.selectionStart ?? input.length)
      setInput(next)
    }
    openPicker()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    // @ 菜单打开时优先处理菜单导航
    if (mentionMenuOpen) {
      if (e.key === 'ArrowDown' && mentionItems.length > 0) {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowUp' && mentionItems.length > 0) {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && mentionItems.length > 0) {
        e.preventDefault()
        pickMentionItem(mentionIndex)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    if (menuOpen) {
      if (e.key === 'ArrowDown' && filtered.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp' && filtered.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filtered.length > 0) {
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
              ) : attachment.type === 'kb' ? (
                <span>📚</span>
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
        {...pasteProps}
      >
        {menuOpen && !varSnippet && (
          <SlashMenu
            commands={filtered}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={pickCommand}
          />
        )}
        {/* @ 触发菜单 */}
        {mentionMenuOpen && (
          <MentionMenu
            items={mentionItems}
            activeIndex={mentionIndex}
            onHover={setMentionIndex}
            onPick={pickMentionItem}
            onPickNewFile={pickMentionNewFile}
          />
        )}
        {varSnippet && (
          <SnippetVarsDialog
            snippet={varSnippet}
            onCancel={() => {
              setVarSnippet(null)
              pendingReplaceRef.current = null
            }}
            onInsert={(text) => {
              replaceTriggerRange(text, pendingReplaceRef.current?.startPos)
              setVarSnippet(null)
              pendingReplaceRef.current = null
            }}
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
        <SnippetButton onInsert={insertAtCursor} disabled={running} />
        <textarea
          ref={taRef}
          data-agent-composer-input
          className="input flex-1 text-sm min-h-[40px] max-h-[120px] resize-none"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
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
