// 命令面板跨模块导航总线（聊天会话 / 助手 / 知识库）。
// 仿 knowledge/source-jump.ts 模式：先写 sessionStorage pending（目标模块未挂载时兜底），
// 再广播 'pocketai:switch-module'（复用 App 既有机制）与目标事件（已挂载即时消费）。
//
// P1（V4-Iter-457）：不再把「Agent 会话」当第二种入口——所有会话跳转一律落到对话模块；
// P4 批次 1（V4-Iter-461）：旧结构 `isAgent` 读写一并摘除。sessionStorage pending 只活到刷新
// （关窗/重启即清），升级后不存在需要兼容的旧值；读到旧结构按「缺能力口径」清除并忽略。

export const OPEN_CONVERSATION_EVENT = 'pocketai:open-conversation'
export const OPEN_KB_EVENT = 'pocketai:palette-open-kb'

export interface OpenConversationDetail {
  /** 目标会话 id；省略 = 只切助手（助手项，由目标模块自动选最近会话） */
  conversationId?: string
  /** 会话归属助手 id（会话项携带；与当前助手不同时目标模块先切助手） */
  assistantId?: string
  /** 该会话是否允许调用工具（徽标口径；打开动作本身不改变会话能力） */
  toolsEnabled?: boolean
}

export interface ConsumePendingOptions {
  /** 只消费属于该助手的 pending（不匹配时保留，防默认助手抢先消费） */
  assistantId?: string
}

const PENDING_CONV_KEY = 'pocketai-pending-conv'
const PENDING_KB_KEY = 'pocketai-pending-kb'

function writePending(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用时已挂载场景仍可工作
  }
}

/** 发起会话/助手跳转：写 pending → 请求切对话模块 → 广播事件（一律走对话，不再分流到 Agent） */
export function requestOpenConversation(detail: OpenConversationDetail): void {
  const next: OpenConversationDetail = {
    conversationId: detail.conversationId,
    assistantId: detail.assistantId,
    toolsEnabled: detail.toolsEnabled === true
  }
  writePending(PENDING_CONV_KEY, next)
  window.dispatchEvent(
    new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'chat' } })
  )
  window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: next }))
}

/**
 * 消费 pending 会话跳转（读后即清，坏 JSON/字段缺失容错）。
 * - options.assistantId：给定时光要求 pending.assistantId 与之相等（或 pending 不带助手 id），
 *   不匹配保留（防目标助手未切换时，默认助手的列表 effect 抢先消费）
 * - 只认新结构 `toolsEnabled`；旧结构 `isAgent` 不再识别（按缺能力口径清除，见文件头说明）
 */
export function consumePendingOpenConversation(
  options: ConsumePendingOptions = {}
): OpenConversationDetail | null {
  const raw = sessionStorage.getItem(PENDING_CONV_KEY)
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<OpenConversationDetail> | null
    if (!d || typeof d !== 'object') {
      sessionStorage.removeItem(PENDING_CONV_KEY)
      return null
    }
    const conversationId = typeof d.conversationId === 'string' && d.conversationId.length > 0
      ? d.conversationId
      : undefined
    const assistantId = typeof d.assistantId === 'string' && d.assistantId.length > 0
      ? d.assistantId
      : undefined
    // 两 id 皆无 = 空跳转；会话项还必须带能力口径（新结构 toolsEnabled）
    const hasMode = typeof d.toolsEnabled === 'boolean'
    if ((!conversationId && !assistantId) || (conversationId && !hasMode)) {
      sessionStorage.removeItem(PENDING_CONV_KEY)
      return null
    }
    if (
      options.assistantId !== undefined &&
      assistantId !== undefined &&
      assistantId !== options.assistantId
    ) {
      return null
    }
    sessionStorage.removeItem(PENDING_CONV_KEY)
    return {
      conversationId,
      assistantId,
      toolsEnabled: d.toolsEnabled === true
    }
  } catch {
    sessionStorage.removeItem(PENDING_CONV_KEY)
    return null
  }
}

/** 发起知识库跳转：写 pending → 请求切知识库模块 → 广播事件 */
export function requestOpenKb(kbId: string): void {
  writePending(PENDING_KB_KEY, kbId)
  window.dispatchEvent(
    new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'knowledge' } })
  )
  window.dispatchEvent(new CustomEvent(OPEN_KB_EVENT, { detail: { kbId } }))
}

/** 消费 pending 知识库 id（读后即清） */
export function consumePendingKb(): string | null {
  const raw = sessionStorage.getItem(PENDING_KB_KEY)
  if (!raw) return null
  sessionStorage.removeItem(PENDING_KB_KEY)
  try {
    const id = JSON.parse(raw)
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}
