import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useI18n } from '../../i18n'
import { SnippetButton } from '../../components/SnippetButton'
import { SlashMenu } from '../../components/SlashMenu'
import { MentionMenu, type MentionItem } from '../../components/MentionMenu'
import { SnippetVarsDialog } from '../../components/SnippetVarsDialog'
import { loadHistory, pushHistory } from '../../utils/input-history'
import { extractTemplateVars } from '../../utils/snippet-template'
import {
  getSnippetTrigger,
  snippetToCommand,
  filterSnippetCommands,
  buildBuiltinSlashCommands,
  type SlashCommand
} from '../../utils/snippet-slash'
import { getMentionQuery, filterMentionKbs, filterMentionFiles } from '../../utils/mention'
import type { ChatAttachment, KnowledgeBase, MessageRecord, PromptSnippetRecord } from '../../../../shared/types'

interface Props {
  streaming: boolean
  canSend: boolean
  onSend: (text: string, attachments?: ChatAttachment[], replyToId?: string | null, kbRefs?: string[]) => void
  onStop: () => void
  /** 当前待回复的引用消息（显示引用条） */
  replyTo?: MessageRecord | null
  /** 取消引用 */
  onCancelReply?: () => void
  /** 草稿归属会话 id（切换时触发旧会话提交 + 新会话回填） */
  draftKey: string
  /** 当前会话已保存的草稿文本（draftKey 变化后生效） */
  draft?: string
  /** 文本每次变化（防抖落库由父级负责；空串=立即清除） */
  onDraftChange?: (text: string) => void
  /** 切换会话：把旧会话最新文本同步交父级立即落库 */
  onDraftCommit?: (convId: string, text: string) => void
  /** 当前会话消息（用于 @ 面板提取最近附件） */
  messages?: MessageRecord[]
  /** 知识库列表（用于 @ 面板） */
  kbs?: KnowledgeBase[]
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript', 'application/x-yaml', 'text/x-yaml']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log', '.ini', '.conf', '.toml']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_TEXT_SIZE = 2 * 1024 * 1024 // 2MB

export const Composer: React.FC<Props> = ({ streaming, canSend, onSend, onStop, replyTo, onCancelReply, draftKey, draft, onDraftChange, onDraftCommit, messages = [], kbs = [] }) => {
  const { t } = useI18n()
  const [text, setText] = useState(draft ?? '')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 最新文本镜像：切会话 effect 里提交旧会话草稿时读取（effect 闭包里的 text 是旧值不可靠）
  const textRef = useRef(text)
  // 上一个草稿归属会话：draftKey 变化时先把旧会话文本同步提交
  const prevKeyRef = useRef(draftKey)
  // 输入历史导航：historyRef 惰性加载（首次按 ↑）；navIndex=null=未导航，0=最新一条，越大越早
  const historyRef = useRef<string[] | null>(null)
  const [navIndex, setNavIndex] = useState<number | null>(null)

  // / # 触发片段/指令菜单
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  // 用户片段（首次触发时惰性拉取；ref 存数据防重复请求，ready 仅作刷新信号）
  const snippetsRef = useRef<PromptSnippetRecord[] | null>(null)
  const [snippetsReady, setSnippetsReady] = useState(0)
  // 片段变量填充态（含 {{var}} 的片段选中后先收集变量再插入）
  const [varSnippet, setVarSnippet] = useState<PromptSnippetRecord | null>(null)

  // @ 触发 mention 面板
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  // 知识库列表（首次触发时惰性拉取）
  const kbsRef = useRef<KnowledgeBase[] | null>(null)

  // 内置斜杠指令（label/template 随界面语言）
  const builtins = useMemo<SlashCommand[]>(() => buildBuiltinSlashCommands(t), [t])

  // 当前触发态：光标前最后一个 / 或 #（行首/空白后才触发）
  const cursor = taRef.current?.selectionStart ?? text.length
  const triggerInfo = slashDismissed ? null : getSnippetTrigger(text, cursor)
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const snippetCmds = (snippetsRef.current ?? []).map(snippetToCommand)
    if (triggerInfo?.trigger === '#') return snippetCmds
    if (triggerInfo?.trigger === '/') return [...builtins, ...snippetCmds]
    return []
    // snippetsReady 变化时重建（snippetsRef.current 已更新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerInfo?.trigger, builtins, snippetsReady])

  const slashFiltered = useMemo(
    () => (triggerInfo ? filterSnippetCommands(slashCommands, triggerInfo.query) : []),
    [triggerInfo, slashCommands]
  )
  const slashMenuOpen = triggerInfo !== null

  // @ 触发态
  const mentionInfo = mentionDismissed ? null : getMentionQuery(text, cursor)
  const mentionItems = useMemo<MentionItem[]>(() => {
    if (!mentionInfo) return []
    const q = mentionInfo.query
    // 最近文件（从当前会话消息附件中提取）
    const recentFiles = filterMentionFiles(messages, q).map((att) => ({
      type: 'recent' as const,
      label: att.name,
      meta: att.type === 'image' ? t('common.image') : t('common.text'),
      value: att.name
    }))
    // 选择新文件
    const newFile = [{ type: 'newFile' as const, label: t('mention.newFile'), value: 'newFile' }]
    // 知识库
    const kbList = filterMentionKbs(kbsRef.current ?? kbs, q).map((kb) => ({
      type: 'kb' as const,
      label: kb.name,
      meta: `${kb.documentCount} ${t('common.docs')}`,
      value: kb.id
    }))
    return [...recentFiles, ...newFile, ...kbList]
  }, [mentionInfo, messages, kbs, t])

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

  // 触发词变化时高亮回到第一项
  useEffect(() => {
    setSlashIndex(0)
  }, [triggerInfo?.query])

  // 首次进入触发态时惰性拉取片段列表
  useEffect(() => {
    if (triggerInfo && snippetsRef.current === null) {
      snippetsRef.current = [] // 占位防并发重复拉取
      window.pocketai.listPromptSnippets()
        .then((list) => {
          snippetsRef.current = list
          setSnippetsReady((n) => n + 1)
        })
        .catch(() => {})
    }
  }, [triggerInfo])

  // draftKey 变化（切会话）或 draft 异步加载到达：提交旧会话 → 回填新会话草稿。
  // 同一次渲染内 draft 已随父级清空为 ''，异步加载完成后再次触发本 effect。
  useEffect(() => {
    if (prevKeyRef.current !== draftKey) {
      if (prevKeyRef.current) onDraftCommit?.(prevKeyRef.current, textRef.current)
      prevKeyRef.current = draftKey
    }
    setText(draft ?? '')
    textRef.current = draft ?? ''
    setNavIndex(null) // 切会话/草稿回填时退出历史导航，避免 ↑↓ 覆盖草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, draft])

  /** 更新文本并同步草稿回调（片段插入/历史召回也走这里） */
  const updateText = (next: string) => {
    setText(next)
    textRef.current = next
    onDraftChange?.(next)
  }

  const resize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }

  const submit = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || !canSend || streaming) return
    // 发送前推入历史（只推正文，附件/引用不加入历史）
    if (trimmed) pushHistory(trimmed)
    // 提取 kbRefs（kb 类型附件的 kbId）
    const kbRefs = attachments.filter((a) => a.type === 'kb').map((a) => a.kbId).filter(Boolean) as string[]
    onSend(trimmed, attachments.length > 0 ? attachments : undefined, replyTo?.id ?? null, kbRefs.length > 0 ? kbRefs : undefined)
    // 清空并立即删除草稿（空串走父级立即清除分支，不经防抖）
    updateText('')
    setAttachments([])
    setNavIndex(null)
    onCancelReply?.()
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto'
    })
  }

  // 片段变量填充弹出时保存当时的触发位置，供后续替换区间使用
  const pendingReplaceRef = useRef<{ startPos: number } | null>(null)

  /** 替换区间 [startPos, 当前光标] 为指定内容 */
  const replaceTriggerRange = (content: string, startPos?: number) => {
    const sp = startPos ?? triggerInfo?.startPos
    if (sp === undefined) return
    const cur = taRef.current?.selectionStart ?? text.length
    const next = text.slice(0, sp) + content + text.slice(cur)
    updateText(next)
    requestAnimationFrame(() => {
      const ta = taRef.current
      ta?.focus()
      const pos = sp + content.length
      ta?.setSelectionRange(pos, pos)
      resize()
    })
  }

  /** 选中菜单项：片段含 {{var}} 先弹变量填充层，否则直接替换触发区间 */
  const pickSlashCommand = (index: number) => {
    const cmd = slashFiltered[index]
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
  }

  /** 选中 @ 菜单项：知识库追加为 kb chip，文件追加为普通附件 */
  const pickMentionItem = (index: number) => {
    const item = mentionItems[index]
    if (!item) return
    const info = mentionInfo
    if (!info) return
    // 先移除触发区间文本（@query）
    const next = text.slice(0, info.startPos) + text.slice(taRef.current?.selectionStart ?? text.length)
    updateText(next)
    if (item.type === 'kb') {
      const kb = (kbsRef.current ?? kbs).find((k) => k.id === item.value)
      if (!kb) return
      const kbAtt: ChatAttachment = {
        type: 'kb',
        name: kb.name,
        mimeType: '',
        size: 0,
        data: '',
        kbId: kb.id
      }
      setAttachments((prev) => [...prev, kbAtt])
    } else if (item.type === 'recent') {
      // 最近文件：从历史消息附件中复制一份
      const found = messages
        .flatMap((m) => m.attachments ?? [])
        .find((a) => a.name === item.value)
      if (found) setAttachments((prev) => [...prev, found])
    }
    // newFile 类型走 fileRef.click()（见下方 onPickNewFile）
    requestAnimationFrame(() => {
      taRef.current?.focus()
      resize()
    })
  }

  /** 选择新文件：触发隐藏 file input */
  const pickMentionNewFile = () => {
    // 先移除触发区间文本
    const info = mentionInfo
    if (info) {
      const next = text.slice(0, info.startPos) + text.slice(taRef.current?.selectionStart ?? text.length)
      updateText(next)
    }
    fileRef.current?.click()
  }

  /** 历史导航：↑ 召回更旧，↓ 更新，Esc 退出；仅限空输入时由 ↑ 进入 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法候选期间不劫持任何键
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
    // 斜杠/片段菜单打开时优先处理菜单导航
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown' && slashFiltered.length > 0) {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashFiltered.length)
        return
      }
      if (e.key === 'ArrowUp' && slashFiltered.length > 0) {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashFiltered.length) % slashFiltered.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && slashFiltered.length > 0) {
        e.preventDefault()
        pickSlashCommand(slashIndex)
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
      submit()
      return
    }
    // 历史导航：空输入时 ↑ 进入；导航中继续 ↑↓（此时文本非空，须放行 navIndex 分支）
    if (e.key === 'ArrowUp') {
      if (text.trim() === '' || navIndex !== null) {
        if (navIndex === null) {
          const hist = historyRef.current ?? loadHistory()
          if (!historyRef.current) historyRef.current = hist
          if (hist.length > 0) {
            e.preventDefault()
            const idx = hist.length - 1 // 最新一条（索引最大）
            setNavIndex(idx)
            updateText(hist[idx] ?? '')
            requestAnimationFrame(resize)
          }
        } else if (navIndex !== null && navIndex > 0) {
          e.preventDefault()
          const idx = navIndex - 1
          setNavIndex(idx)
          updateText(historyRef.current?.[idx] ?? '')
          requestAnimationFrame(resize)
        }
      }
      return
    }
    if (e.key === 'ArrowDown') {
      if (navIndex !== null && historyRef.current) {
        e.preventDefault()
        if (navIndex < historyRef.current.length - 1) {
          const idx = navIndex + 1
          setNavIndex(idx)
          updateText(historyRef.current[idx] ?? '')
        } else {
          // 最新一条后再按 ↓ 回空串
          setNavIndex(null)
          updateText('')
        }
        requestAnimationFrame(resize)
      }
      return
    }
    if (e.key === 'Escape') {
      if (navIndex !== null) {
        e.preventDefault()
        setNavIndex(null)
        updateText('')
        requestAnimationFrame(resize)
      }
    }
  }

  const readFile = (file: File): Promise<ChatAttachment | null> => {
    return new Promise((resolve) => {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      const isImage = IMAGE_TYPES.includes(file.type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
      const isText = TEXT_TYPES.includes(file.type) || TEXT_EXTS.includes(ext)

      if (isImage) {
        if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
        const reader = new FileReader()
        reader.onload = () => {
          resolve({
            type: 'image',
            name: file.name,
            mimeType: file.type || 'image/png',
            size: file.size,
            data: reader.result as string
          })
        }
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(file)
      } else if (isText) {
        if (file.size > MAX_TEXT_SIZE) { resolve(null); return }
        const reader = new FileReader()
        reader.onload = () => {
          resolve({
            type: 'text',
            name: file.name,
            mimeType: file.type || 'text/plain',
            size: file.size,
            data: reader.result as string
          })
        }
        reader.onerror = () => resolve(null)
        reader.readAsText(file)
      } else {
        resolve(null)
      }
    })
  }

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files)
    const results = await Promise.all(fileArr.map(readFile))
    const valid = results.filter((r): r is ChatAttachment => r !== null)
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid].slice(0, 8))
  }, [])

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files)
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files)
  }

  // 粘贴附件：剪贴板带文件（截图工具复制的图片 / 复制的文件）时直接附加，
  // 阻止浏览器把图片路径/二进制塞进文本；纯文本粘贴完全放行
  const handlePaste = (e: React.ClipboardEvent) => {
    const files = e.clipboardData.files
    if (files && files.length > 0) {
      e.preventDefault()
      void handleFiles(files)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  // 提示词片段：在 textarea 光标处替换选区插入（受控组件，走 setText 而非直接改 DOM）
  const insertAtCursor = (insert: string) => {
    const ta = taRef.current
    const start = ta?.selectionStart ?? text.length
    const end = ta?.selectionEnd ?? start
    const next = text.slice(0, start) + insert + text.slice(end)
    updateText(next)
    requestAnimationFrame(() => {
      ta?.focus()
      const pos = start + insert.length
      ta?.setSelectionRange(pos, pos)
      resize()
    })
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto">
        {/* 附件预览 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1.5">
            {attachments.map((att, i) => (
              <div key={`${att.name}-${att.size}`} className="relative group flex items-center gap-1.5 bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg pl-1.5 pr-7 py-1 text-xs">
                {att.type === 'image' ? (
                  <img src={att.data} alt={att.name} className="w-6 h-6 rounded object-cover" />
                ) : att.type === 'kb' ? (
                  <span className="text-[var(--color-text-muted)]">📚</span>
                ) : (
                  <span className="text-[var(--color-text-muted)]">📄</span>
                )}
                <span className="max-w-[120px] truncate text-[var(--color-text)]">{att.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] leading-none"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 引用回复条：显示被引用消息的角色+内容预览，可取消 */}
        {replyTo && (
          <div className="flex items-start gap-2 mb-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-hover-overlay)] border-l-2 border-[var(--color-accent)]">
            <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${replyTo.role === 'user' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
              {replyTo.role === 'user' ? t('chat.you') : t('chat.assistant')}
            </span>
            <span className="flex-1 text-[12px] text-[var(--color-text-muted)] line-clamp-2 break-all">
              {replyTo.content || t('chat.replyEmpty')}
            </span>
            <button
              onClick={onCancelReply}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title={t('common.cancel')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div
          className={`relative flex items-end gap-2 bg-[var(--color-sidebar)] border rounded-2xl p-2 transition-colors ${
            dragOver ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragOver(false)}
          onPaste={handlePaste}
        >
          {/* / # 触发菜单（变量填充层打开时隐藏菜单避免重叠） */}
          {slashMenuOpen && !varSnippet && (
            <SlashMenu
              commands={slashFiltered}
              activeIndex={slashIndex}
              onHover={setSlashIndex}
              onPick={pickSlashCommand}
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
              onInsert={(content) => {
                replaceTriggerRange(content, pendingReplaceRef.current?.startPos)
                setVarSnippet(null)
                pendingReplaceRef.current = null
              }}
            />
          )}
          {/* 文件选择按钮 */}
          <button
            onClick={() => fileRef.current?.click()}
            title={t('common.attachFile')}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.html,.xml,.py,.js,.ts,.tsx,.jsx,.yaml,.yml,.sh,.sql,.log,.ini,.conf,.toml"
            className="hidden"
            onChange={handleFilePick}
          />

          <SnippetButton onInsert={insertAtCursor} />

          <textarea
            ref={taRef}
            data-chat-composer-input
            value={text}
            onChange={(e) => {
              // 用户主动输入（非导航回填）：退出历史导航，视为新文本
              if (navIndex !== null) setNavIndex(null)
              updateText(e.target.value)
              // 重新进入 / # 触发态时解除 Esc 关闭状态
              if (getSnippetTrigger(e.target.value, e.target.selectionStart) !== null) setSlashDismissed(false)
              resize()
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={canSend ? t('composer.ph') : t('composer.noProvider')}
            className="flex-1 bg-transparent resize-none outline-none text-[var(--chat-font-size)] leading-relaxed px-2 py-1.5 max-h-[200px]"
          />

          {streaming ? (
            <button
              onClick={onStop}
              className="shrink-0 h-9 px-4 rounded-xl bg-[var(--color-danger)] hover:opacity-90 text-white text-sm font-medium"
            >
              {t('common.stop')}
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend || (!text.trim() && attachments.length === 0)}
              className="shrink-0 h-9 px-4 rounded-xl bg-[var(--color-accent)] text-[var(--color-on-accent)] text-sm font-medium disabled:opacity-30 hover:opacity-90"
            >
              {t('common.send')}
            </button>
          )}
        </div>
        {dragOver && (
          <div className="text-[11px] text-[var(--color-accent)] mt-1 text-center">
            松开以添加文件
          </div>
        )}
      </div>
    </div>
  )
}
