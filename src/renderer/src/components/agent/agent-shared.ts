// Agent 模块共享：类型、常量与纯函数（MCP 面板 / 对话壳 / Channels 共用）
import type { ChatAttachment, MessageRecord, MessageRetrieval, TodoItem, ToolCall, ToolResult, MessageSource } from '../../../../shared/types'
import { readDelegateRoleForDisplay, type DelegateRole } from '../../../../shared/delegation-rules'
import type { SlashCommand } from '../../utils/snippet-slash'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  reasoning?: string
  toolCall?: ToolCall
  toolResult?: ToolResult
  todos?: TodoItem[] // 任务清单卡片（todo_write 步骤，随每次调用整卡更新）
  stepIndex?: number
  isFinal?: boolean
  isError?: boolean
  attachments?: ChatAttachment[]
  /** 知识库引用来源（RAG 检索命中的 chunk） */
  sources?: MessageSource[]
  /** 本轮知识库检索事实（有没有检索/命中几条/失败）；旧消息没有 */
  retrieval?: MessageRetrieval
  dbId?: string // 对应 DB message.id（用于删除单条消息；live 占位卡需等主进程回传）
}

// ---------- 斜杠快捷指令 ----------

/** 运行中实时步骤条的一步（chip 流数据；todo 步骤不进 chip，已有 checklist 卡） */
export interface LiveStep {
  stepIndex: number
  type: 'thought' | 'tool_call' | 'tool_result' | 'replan' | 'error'
  /** tool_call 步骤的工具名 */
  toolName?: string
  /**
   * 这一步是委派时派出去的角色（148）。只有 tool_call 会有：tool_result 的
   * `ToolResult.arguments` 在委派那条路上是空的（引擎只在持久化时才补 arguments），
   * 给结果卡打标签会做成"live 有、刷新后也有、但内容不同"的两张脸。
   */
  role?: DelegateRole
  /**
   * 去重键的一部分（148）：同一步里可以真有两条调用（145 的并行委派，云端点在今天就到得了），
   * 只按 stepIndex+type 去重会把第二条**连角色一起吞掉**。thought 的"占位→正式"两条都没有它，
   * 所以那条去重照旧成立。
   */
  callId?: string
  /**
   * tool_call 时：`web_search` 且参数 depth=deep。auto 档位下界面据此显示「深度检索中…」
   * （配置为 quick/deep 时以配置为准，不看这个字段）。
   */
  deepSearch?: boolean
}

/** chip 流最大保留长度（防超长运行撑爆 UI；超出丢最旧） */
export const LIVE_STEPS_MAX = 50

/**
 * 角色标签的取词（三条字面量 `t()` 调用，不是查表）。
 * 写成字面量是因为 i18n 对等用例只扫源码里的 `t('key')` 字面量：
 * `t('agent.role.' + role)` 拼出来的动态 key 它抓不到，漏一门翻译就只会白屏出一个裸 key
 * （146 的 `judgement.reason.${code}` 踩过同一坑，那边的处置是补一份逐码字典用例）。
 * 这里能三行写完，就直接写三行。
 */
export function delegateRoleLabel(t: (key: string) => string, role: DelegateRole): string {
  if (role === 'researcher') return t('agent.role.researcher')
  if (role === 'writer') return t('agent.role.writer')
  return t('agent.role.reviewer')
}

/**
 * web_search 的 depth 参数是否 deep（auto 档位下界面据此显示「深度检索中…」）。
 * 参数是模型生成的 JSON，可能畸形——解析失败按 quick（与 builtin 的兜底一致）。
 */
function readDeepSearchArg(name?: string, raw?: string): boolean {
  if (name !== 'web_search' || !raw) return false
  try {
    const args = JSON.parse(raw) as { depth?: unknown } | null
    return args?.depth === 'deep'
  } catch {
    return false
  }
}

/**
 * liveSteps 归约（纯函数，可单测）：把 step 事件追加到 chip 流。
 * - 不在白名单的类型（user/todo/final）返回原数组（引用不变，不触发重渲染）
 * - 同一 stepIndex 的 thought 占位→正式更新会去重为一条（同 index 同类型同 callId 覆盖）
 * - 超出 LIVE_STEPS_MAX 丢最旧
 */
export function reduceLiveSteps(prev: LiveStep[], event: { stepIndex: number; type: string; toolCall?: ToolCall }): LiveStep[] {
  const t = event.type
  if (t !== 'thought' && t !== 'tool_call' && t !== 'tool_result' && t !== 'replan' && t !== 'error') return prev
  const step: LiveStep = {
    stepIndex: event.stepIndex,
    type: t,
    toolName: t === 'tool_call' ? event.toolCall?.function?.name : undefined,
    role: t === 'tool_call'
      ? readDelegateRoleForDisplay(event.toolCall?.function?.name, event.toolCall?.function?.arguments) ?? undefined
      : undefined,
    callId: t === 'tool_call' ? event.toolCall?.id : undefined,
    deepSearch: t === 'tool_call' ? readDeepSearchArg(event.toolCall?.function?.name, event.toolCall?.function?.arguments) : undefined
  }
  // 同 stepIndex 同类型同 callId 覆盖（thought 先 emit 占位再 emit 正式文本，chip 只留一条）
  const dupIdx = prev.findIndex(
    (s) => s.stepIndex === step.stepIndex && s.type === step.type && s.callId === step.callId
  )
  const next = dupIdx >= 0
    ? prev.map((s, i) => (i === dupIdx ? step : s))
    : [...prev, step]
  return next.length > LIVE_STEPS_MAX ? next.slice(next.length - LIVE_STEPS_MAX) : next
}

// SlashCommand 统一收口到 utils/snippet-slash（含 kind 分组字段），此处再导出保持既有引用路径
export type { SlashCommand } from '../../utils/snippet-slash'

/**
 * 解析输入框当前是否处于斜杠指令输入态。
 * 规则：去掉前导空白后以 / 开头，且 / 之后不含空白与第二个 /（单个命令词）。
 * @returns 命令词（可能为空串，表示刚敲入 /）；非指令态返回 null
 */
export function getSlashQuery(input: string): string | null {
  const m = /^\s*\/([^\s/]*)$/.exec(input)
  return m ? (m[1] ?? '') : null
}

/** 按命令词前缀过滤（大小写不敏感）；query 为空时返回全部 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => c.name.toLowerCase().startsWith(q))
}

// ---------- 附件读取 ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log', '.ini', '.conf', '.toml']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_TEXT_SIZE = 2 * 1024 * 1024
/** 单条消息最多附带的附件数（与原实现保持一致） */
export const MAX_ATTACHMENTS = 8
/** 文件选择框 accept 列表（与 Chat Composer 对齐） */
export const ATTACHMENT_ACCEPT = 'image/*,.txt,.md,.json,.csv,.html,.xml,.py,.js,.ts,.tsx,.jsx,.yaml,.yml,.sh,.sql,.log,.ini,.conf,.toml'

export async function readFileAsAttachment(file: File): Promise<ChatAttachment | null> {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  const isImage = IMAGE_TYPES.includes(file.type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
  const isText = TEXT_TYPES.includes(file.type) || TEXT_EXTS.includes(ext)
  return new Promise((resolve) => {
    if (isImage) {
      if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
      const r = new FileReader()
      r.onload = () => resolve({ type: 'image', name: file.name, mimeType: file.type || 'image/png', size: file.size, data: r.result as string })
      r.onerror = () => resolve(null)
      r.readAsDataURL(file)
    } else if (isText) {
      if (file.size > MAX_TEXT_SIZE) { resolve(null); return }
      const r = new FileReader()
      r.onload = () => resolve({ type: 'text', name: file.name, mimeType: file.type || 'text/plain', size: file.size, data: r.result as string })
      r.onerror = () => resolve(null)
      r.readAsText(file)
    } else { resolve(null) }
  })
}

/** 运行耗时人类可读：<1s 显示毫秒，否则秒（保留 1 位小数） */
export function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 提取消息文本中第一个 ```html 代码块（供「在沙箱运行」按钮使用） */
export function extractFirstHtmlBlock(text: string): string | null {
  const m = text.match(/```html\s*\r?\n([\s\S]*?)```/i)
  return m ? m[1] ?? null : null
}

/**
 * 零调用提示里那两条「为什么」的互斥规则（V4-Iter-113 定的口径，抽出来才能被断言）。
 * 已知有 MCP 工具被 `'*'` 挡下时只说这件事——那时更可能的原因是授权而不是端点，
 * 同屏再劝一次「改用文本协议」会把人带偏；反过来，没有工具被挡时才值得建议开开关。
 */
export function zeroCallNoticeFlags(s: {
  mcpHeldBack: number
  providerId: string
  model: string
  textProtocolForced: boolean
}): { showHeldBack: boolean; showSuggest: boolean } {
  return {
    showHeldBack: s.mcpHeldBack > 0,
    showSuggest: s.mcpHeldBack === 0 && !!s.providerId && !!s.model && !s.textProtocolForced
  }
}

/**
 * 零调用提示是否该亮：本轮有工具可用却一次都没调用**且整条会话都没有过工具卡**。
 * 只凭本轮就建议换模型，等于拿一轮的信号断言这台模型的行为（§242 真机读数里
 * 同一台模型上一轮调了、这一轮没调）。P4 批次 0 起两个壳（Agent / 对话）共用这一条判定。
 */
export function shouldShowZeroToolCallNotice(
  usedTools: boolean | undefined,
  hasToolHistory: boolean
): boolean {
  return usedTools === false && !hasToolHistory
}

/** DB MessageRecord[] → Agent 对话视图的 AgentMessage[]（tool 消息拆 call/result 两张卡） */
export function toAgentMessages(dbMsgs: MessageRecord[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const m of dbMsgs) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', text: m.content, attachments: m.attachments, dbId: m.id })
    } else if (m.role === 'assistant') {
      // 历史加载：streaming 残留（中断/出错未清理）视为终止，避免永远显示「思考中…」
      out.push({
        id: m.id,
        role: 'assistant',
        text: m.content || (m.status === 'streaming' ? '（中断）' : ''),
        isFinal: true,
        sources: m.sources ?? undefined,
        retrieval: m.retrieval ?? undefined,
        dbId: m.id
      })
    } else if (m.role === 'tool') {
      try {
        const tr = JSON.parse(m.content) as ToolResult
        // 若有调用参数，先显示 tool_call 步骤，再显示 tool_result
        if (tr.arguments) {
          out.push({
            id: `${m.id}-call`,
            role: 'tool',
            text: '',
            toolCall: {
              id: tr.toolCallId,
              type: 'function',
              function: { name: tr.name, arguments: tr.arguments }
            },
            dbId: m.id
          })
        }
        out.push({
          id: m.id,
          role: 'tool',
          text: tr.content,
          toolResult: tr,
          isError: tr.isError,
          dbId: m.id
        })
      } catch {
        out.push({ id: m.id, role: 'tool', text: m.content, dbId: m.id })
      }
    }
  }
  return out
}

