// Agent 底部输入区：附件预览/拖拽/选择 + 斜杠快捷指令 + 提示词片段 + 输入框 + 发送/停止
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n'
import { SnippetButton } from '../../../components/SnippetButton'
import { FloatingPanel } from '../../../components/FloatingPanel'
import { SlashMenu } from '../../../components/SlashMenu'
import { MentionMenu, type MentionItem } from '../../../components/MentionMenu'
import { SnippetVarsDialog } from '../../../components/SnippetVarsDialog'
import type { useAttachments } from '../hooks/useAttachments'
import { MAX_QUEUE_ITEMS, type AgentQueueItem } from '../hooks/useAgentChat'
import { useToast } from '../../../components/ToastProvider'
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
import { hasIpcFailed, ipcFailText, logIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

interface Props {
  running: boolean
  canSend: boolean
  att: ReturnType<typeof useAttachments>
  onSend: (text: string) => void
  onAbort: () => void
  /**
   * 运行中排队条（V4-Iter-238）。渲染层内存里的待发消息，**只带文字**：
   * 附件走的是"这一轮"的入库与注入链（attachment-ingestion 要知道 message id），
   * 排队项还没有 id，硬塞会变成"附件在界面上但没人读它"。
   */
  queue: AgentQueueItem[]
  queueFull: boolean
  onQueue: (text: string) => void
  onInterject: (text: string) => void
  onDropQueued: (clientRef: string) => void
  onSendQueuedNow: (clientRef: string) => void
  /**
   * §399②a：顶栏那两颗徽标（模型级「走文本协议」／📁 工作目录）搬进这颗菜单。
   * 「关闭入口要常驻可达」这条既有契约（Iter-113 的死路：开关只藏在零调用提示里，
   * 协议一生效提示就再也不出现、开关也就关不掉）靠的是**「+」本身一直在输入行上**，
   * 不是靠菜单开着——所以搬进来不破它，但前提是那句「读不到」绝不能只写在菜单里（下面那两处句子在浮层外面）。
   */
  textProtocolAvailable: boolean
  textProtocolForced: boolean
  textProtocolUnread: string | null
  onToggleTextProtocol: (on: boolean) => void
  onRetryTextProtocol: () => void
  workspaceDir: string
  workspaceUnread: string | null
  onPickWorkspace: () => void
  onRetryWorkspace: () => void
}

export const AgentComposer: React.FC<Props> = ({
  running,
  canSend,
  att,
  onSend,
  onAbort,
  queue,
  queueFull,
  onQueue,
  onInterject,
  onDropQueued,
  onSendQueuedNow,
  textProtocolAvailable,
  textProtocolForced,
  textProtocolUnread,
  onToggleTextProtocol,
  onRetryTextProtocol,
  workspaceDir,
  workspaceUnread,
  onPickWorkspace,
  onRetryWorkspace
}) => {
  const { t } = useI18n()
  const toast = useToast()
  const [input, setInput] = useState('')
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const { attachments, dragOver, removeAt, clear, openPicker, fileInputProps, dropZoneProps, pasteProps } = att

  // 用户片段（首次触发时惰性拉取）
  const snippetsRef = useRef<PromptSnippetRecord[] | null>(null)
  const [snippetsReady, setSnippetsReady] = useState(0) // 仅作刷新信号
  // §268：这两发惰性读失败时以前整组清单原地消失（`/` 只剩内置、@ 的知识库组不见），屏上零字。
  // 各挂一句、各给一次重试——入口是打字，而 ref 的占位是防"每次渲染重拉一趟"的刻意设计（§221），所以句子必须自带出口
  const [snippetsFail, setSnippetsFail] = useState<{ error?: string } | null>(null)

  // 变量填充态
  const [varSnippet, setVarSnippet] = useState<PromptSnippetRecord | null>(null)

  // @ 触发 mention 面板
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  // 知识库列表（首次触发时惰性拉取）
  const kbsRef = useRef<KnowledgeBase[] | null>(null)
  const [kbsFail, setKbsFail] = useState<{ error?: string } | null>(null)
  // §399：输入行左端那两颗键（📎／📝）收进一颗「+」，知识库清单也从这里点得到（不必打字触发 @）
  const [plusOpen, setPlusOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)
  // `kbsRef` 是 ref，读到了不会自己重渲染——开菜单那一发落回来时要敲一下这记信号
  const [kbsReady, setKbsReady] = useState(0)

  // 内置指令（随界面语言变化）
  const builtins = useMemo<SlashCommand[]>(() => buildBuiltinSlashCommands(t), [t])

  // 「+」菜单里那组知识库：清单本体在 ref 里（防并发重拉），靠 `kbsReady` 这记信号重取一次
  const menuKbs = useMemo(() => kbsRef.current ?? [], [kbsReady])

  // §399②a 升级回显：常态输入行上只有一颗「+」，被它收进去的项**不**在屏上占行。
  // 但任一项处于「读不到」时，这颗徽标转危险色，并且下面就地长出那一句＋同级出口——
  // 只在坏消息时占行。判据是四项自己那张脸，不是"菜单开没开"：折叠起来就等于没说过（§222／§268）。
  const plusDanger = !!(kbsFail || snippetsFail || textProtocolUnread || workspaceUnread)

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
  const loadKbs = useCallback(() => {
    if (kbsRef.current !== null) return
    kbsRef.current = [] // 占位防并发重复拉取
    window.pocketai.listKnowledgeBases()
      .then((list) => {
        // §221：失败不能把 `{ok:false}` 写进 ref（读它的那句 `.map` 崩）。
        // 也**不能**清回 null——这根 effect 的依赖 `mentionInfo` 是每次渲染新建的对象，
        // 清 null 就变成"每次渲染重拉一趟"（真挂载用例里量到过：输入框卡死在转圈）
        if (hasIpcFailed(list)) {
          setKbsFail({ error: list.error })
          return
        }
        kbsRef.current = list
        setKbsFail(null)
        setKbsReady((n) => n + 1)
      })
      .catch((e: unknown) => {
        setKbsFail({ error: errText(e, '') })
        logIpcError('agent.listKnowledgeBases', e)
      })
  }, [])

  useEffect(() => {
    if (mentionInfo) loadKbs()
  }, [mentionInfo, loadKbs])

  // §268 重试：只有点这句上的键才清占位（effect 那条"非 null 就不重拉"的防重逻辑照旧）
  const retryKbs = (): void => {
    kbsRef.current = null
    loadKbs()
  }

  // 过滤结果变化时高亮回到第一项
  useEffect(() => {
    setActiveIndex(0)
  }, [triggerInfo?.query])

  // 首次触发时惰性拉取片段列表
  useEffect(() => {
    if (trigger && snippetsRef.current === null) {
      window.pocketai.listPromptSnippets()
        .then((list) => {
          // §221：失败不写进 ref（读它的那句 `.map` 崩）；ref 保持 null ⇒ 下次进触发态自己会重拉
          if (hasIpcFailed(list)) {
            setSnippetsFail({ error: list.error })
          } else {
            snippetsRef.current = list
            setSnippetsFail(null)
          }
          setSnippetsReady((n) => n + 1)
        })
        .catch((e: unknown) => {
          // 同上：这里**不配重试键**——退出再进入触发态就会自己重拉（ref 没被占位写死），句子只说后果
          setSnippetsFail({ error: errText(e, '') })
          setSnippetsReady((n) => n + 1)
          logIpcError('agent.listPromptSnippets', e)
        })
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

  /**
   * 运行中要交出去的一句话（入队与插队共用一条判据）。
   * 排队项只带文字：附件的入库链要等 message id（这一轮才有），带进条里就是"看起来发出去了、
   * 其实没人读它"。所以这里拦下并说清楚，不偷偷丢掉用户挑好的文件。
   */
  const takeQueueText = (): string => {
    const text = input.trim()
    if (!text) return ''
    if (attachments.length > 0) {
      toast.error(t('agent.queue.textOnly'))
      return ''
    }
    return text
  }

  const doQueue = () => {
    const text = takeQueueText()
    if (!text || !canSend) return
    onQueue(text)
    setInput('')
    setSlashDismissed(false)
    setVarSnippet(null)
  }

  const doInterject = () => {
    const text = takeQueueText()
    if (!text || !canSend) return
    onInterject(text)
    setInput('')
    setSlashDismissed(false)
    setVarSnippet(null)
  }

  const doSend = () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !canSend) return
    // 运行中的 Enter 与「入队」按钮同一条路（V4-Iter-238）：输入框不再被禁用，
    // 但这句话不会插进正在跑的那一轮，除非按「立即插队」
    if (running) {
      doQueue()
      return
    }
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

  /** 挑中一个知识库＝追加成一颗 kb chip（@ 那条路与「+」菜单里那一组共用同一份形状） */
  const addKbChip = (kb: KnowledgeBase): void => {
    att.addAttachment({
      type: 'kb',
      name: kb.name,
      mimeType: '',
      size: 0,
      data: '',
      kbId: kb.id
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
      addKbChip(kb)
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
      {/* 运行中排队条（V4-Iter-238）：条上每一项都还没进正在跑的这一轮 */}
      {queue.length > 0 && (
        <div className="pt-2" data-testid="agent-queue-bar">
          <div className="text-[11px] text-[var(--color-text-muted)] mb-1">{t('agent.queue.barTitle')}</div>
          <ul className="flex flex-col gap-1">
            {queue.map((q) => (
              <li
                key={q.clientRef}
                className="flex items-center gap-2 text-xs bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg px-2 py-1"
              >
                <span className="flex-1 truncate" title={q.text}>
                  {q.text}
                </span>
                {q.interjecting ? (
                  // 已经交给引擎、等它在下个步边界收下；此时撤回按钮要禁用——
                  // 那句话随时可能落库，让条项消失而卡片出现是正常顺序，撤回反而会说谎
                  <span
                    className="shrink-0 text-[var(--color-text-muted)]"
                    data-testid={`agent-queue-state-${q.clientRef}`}
                  >
                    {t('agent.queue.interjecting')}
                  </span>
                ) : (
                  <button
                    className="btn-ghost text-xs shrink-0"
                    onClick={() => onSendQueuedNow(q.clientRef)}
                    data-testid={`agent-queue-send-${q.clientRef}`}
                  >
                    {running ? t('agent.queue.interject') : t('common.send')}
                  </button>
                )}
                <button
                  onClick={() => onDropQueued(q.clientRef)}
                  disabled={q.interjecting}
                  title={t('agent.queue.drop')}
                  className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] disabled:opacity-40"
                  data-testid={`agent-queue-drop-${q.clientRef}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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

      {/* §268：两发惰性读各挂一句，各自独立成行（不互相挂靠、也不挂在菜单浮层里——浮层一关句子就没了＝替这次失败闭嘴）。
          知识库那句带一次重试（它的 ref 被占位写死，再打字不会重拉）；片段那句**不带键**（它的 ref 失败时仍是 null，
          退出再进入触发态自己会重拉＝天然出口，多一颗键是多余机关，同 §266 那三处的道理） */}
      {/* 键放在 `role="alert"` 外面 ⇒ 那句的 textContent 是纯句子，用例可整值比（§264 的教训） */}
      {kbsFail && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span role="alert" className="text-xs text-[var(--color-danger)]">
            {t('common.loadFailedNamed', { what: t('common.kbList'), msg: ipcFailText(kbsFail, t('common.unknownError')) })}
          </span>
          <button data-testid="agent-composer-kbs-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={retryKbs}>{t('agent.retryRead')}</button>
        </div>
      )}
      {snippetsFail && (
        <div role="alert" className="text-xs text-[var(--color-danger)]">
          {t('common.loadFailedNamed', { what: t('common.snippetList'), msg: ipcFailText(snippetsFail, t('common.unknownError')) })}
        </div>
      )}
      {/* §399②a：搬进来的这两项各自那句「读不到」也住在这里（浮层外面），原因挂在那句的悬停上，
          出口是同级那颗键——这两发的读都只在挂载跑一次，没有"再点那一格就自己重拉"的天然出口（§268 分档）。
          句子用的是这两项既有那两张 title（四语齐全、且已经说明"这里按未启用/未设置显示"），零新文案。 */}
      {textProtocolUnread && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span role="alert" className="text-xs text-[var(--color-danger)]" title={textProtocolUnread}>
            {t('agent.textProtocolUnread')}
          </span>
          <button data-testid="agent-composer-text-protocol-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={onRetryTextProtocol}>{t('agent.retryRead')}</button>
        </div>
      )}
      {workspaceUnread && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span role="alert" className="text-xs text-[var(--color-danger)]" title={workspaceUnread}>
            {t('agent.workspaceUnread')}
          </span>
          <button data-testid="agent-composer-workspace-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={onRetryWorkspace}>{t('agent.retryRead')}</button>
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
        {/* §399：输入行左端收成一颗「+」。三行接的都是**已有的出口**——附件仍是那颗隐藏 input、
            片段仍是 SnippetButton 那套三态弹层、知识库仍是同一发惰性读＋同一颗 kb chip（不另起第二份清单机关）。
            「清单读不到」那句仍然在浮层**外面**（上面那两处 §268 的句子）：菜单一关就不说话＝替这次失败闭嘴。 */}
        <button
          ref={plusRef}
          type="button"
          data-testid="agent-composer-plus"
          aria-haspopup="menu"
          aria-expanded={plusOpen}
          title={t('agent.plusMenu')}
          aria-label={t('agent.plusMenu')}
          onClick={() => {
            if (plusOpen) setPlusOpen(false)
            else {
              setPlusOpen(true)
              loadKbs()
            }
          }}
          className={`shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-[17px] transition-colors ${
            plusDanger
              ? 'text-[var(--color-danger)] hover:bg-[var(--color-hover-overlay)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
          }`}
        >
          ＋
        </button>
        {plusOpen && (
          <FloatingPanel anchorRef={plusRef} width={252} onClose={() => setPlusOpen(false)} data-testid="agent-composer-plus-menu">
            <button
              type="button"
              role="menuitem"
              data-testid="agent-composer-plus-file"
              disabled={running}
              title={running ? t('agent.queue.textOnly') : t('common.attachFile')}
              onClick={() => {
                setPlusOpen(false)
                openPicker()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors disabled:opacity-40"
            >
              <span aria-hidden>📎</span>
              <span>{t('common.attachFile')}</span>
            </button>
            <SnippetButton
              onInsert={(text) => {
                setPlusOpen(false)
                insertAtCursor(text)
              }}
              disabled={running}
              variant="row"
            />
            {/* §399②a：这两行搬自顶栏。执行设置放在**知识库那组之前**——知识库是一份可长的清单，
                浮层向上长，把它排到最后才不会把这两行顶出窗口。
                点文本协议那行**不收菜单**：这一发的写是异步的，留着才看得见那张脸翻过去（关菜单再点是第二次点击）。 */}
            {textProtocolAvailable && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={textProtocolForced}
                data-testid="agent-composer-plus-text-protocol"
                title={
                  textProtocolUnread
                    ? `${t('agent.textProtocolUnread')} — ${textProtocolUnread}`
                    : textProtocolForced
                      ? t('agent.textProtocolOnHint')
                      : t('agent.textProtocolHint')
                }
                onClick={() => onToggleTextProtocol(!textProtocolForced)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  textProtocolUnread
                    ? 'text-[var(--color-danger)]'
                    : textProtocolForced
                      ? 'text-[var(--color-accent)]'
                      : 'text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
                }`}
              >
                <span className="flex-1 min-w-0 truncate">
                  {/* 三档分开：读不到既不是"已启用"也不是"没启用"（§257 那张脸，一个字没改地搬过来） */}
                  {textProtocolUnread
                    ? t('agent.textProtocolReadFail')
                    : textProtocolForced
                      ? t('agent.textProtocolOn')
                      : t('agent.textProtocol')}
                </span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              data-testid="agent-composer-plus-workspace"
              title={
                workspaceUnread
                  ? `${t('agent.workspaceUnread')} — ${workspaceUnread}`
                  : workspaceDir || t('agent.workspacePickTip')
              }
              onClick={() => {
                setPlusOpen(false)
                onPickWorkspace()
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                workspaceUnread
                  ? 'text-[var(--color-danger)]'
                  : 'text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
              }`}
            >
              <span aria-hidden>📁</span>
              <span className="flex-1 min-w-0 truncate">
                {/* 三档分开：读不到／已设（取末段目录名）／真没设过——读不到时不许把默认字面量「未设置」冒充读数（§257） */}
                {workspaceUnread
                  ? t('agent.workspaceReadFail')
                  : workspaceDir
                    ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir
                    : t('agent.workspaceNone')}
              </span>
            </button>
            <div className="my-1 border-t border-[var(--color-border)]" />
            <div className="px-3 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              {t('mention.knowledge')}
            </div>
            {menuKbs.length === 0 && kbsRef.current === null && (
              <div className="px-3 py-2 text-[10px] text-[var(--color-text-muted)]">…</div>
            )}
            {menuKbs.length === 0 && kbsRef.current !== null && !kbsFail && (
              // 读成功、库里真的没有东西才说这句。读失败时这里**一个字都不加**＝菜单里不装"这里没东西"，
              // 说话的是浮层外面那句既有的「知识库清单读不到」＋那颗重试键（§268：藏进浮层＝替这次失败闭嘴）
              <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{t('ccb.none')}</div>
            )}
            {menuKbs.map((kb) => (
              <button
                key={kb.id}
                type="button"
                role="menuitem"
                data-testid={`agent-composer-plus-kb-${kb.id}`}
                onClick={() => {
                  setPlusOpen(false)
                  addKbChip(kb)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors"
              >
                <span className="flex-1 min-w-0 truncate">{kb.name}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {kb.documentCount} {t('common.docs')}
                </span>
              </button>
            ))}
          </FloatingPanel>
        )}
        <textarea
          ref={taRef}
          data-agent-composer-input
          className="input flex-1 text-sm min-h-[40px] max-h-[120px] resize-none"
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? t('agent.inputPhRunning') : t('agent.inputPh')}
          title={t('agent.composerTitle')}
        />
        {running ? (
          // 运行中三键（V4-Iter-238）：停止是原来的那颗；入队等本轮结束自动发；立即插队交给引擎，
          // 由它在**下一个步边界**收下（不是打断当前这一步）
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              className="btn-ghost"
              onClick={doQueue}
              disabled={!input.trim() || queueFull}
              title={queueFull ? t('agent.queue.tooMany', { max: MAX_QUEUE_ITEMS }) : t('agent.queue.enqueueTitle')}
              data-testid="agent-queue-enqueue"
            >
              {t('agent.queue.enqueue')}
            </button>
            <button
              className="btn-ghost"
              onClick={doInterject}
              disabled={!input.trim() || queueFull}
              title={queueFull ? t('agent.queue.tooMany', { max: MAX_QUEUE_ITEMS }) : t('agent.queue.interjectTitle')}
              data-testid="agent-queue-interject"
            >
              {t('agent.queue.interject')}
            </button>
            <button className="btn-ghost" onClick={onAbort}>{t('common.stop')}</button>
          </div>
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
