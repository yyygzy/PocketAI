// 命令面板跨模块导航总线（聊天会话 / Agent 会话 / 助手 / 知识库）。
// 仿 knowledge/source-jump.ts 模式：先写 sessionStorage pending（目标模块未挂载时兜底），
// 再广播 'pocketai:switch-module'（复用 App 既有机制）与目标事件（已挂载即时消费）。

export const OPEN_CONVERSATION_EVENT = 'pocketai:open-conversation'
export const OPEN_KB_EVENT = 'pocketai:palette-open-kb'

export interface OpenConversationDetail {
  /** 目标会话 id；省略 = 只切助手（助手项，由目标模块自动选最近会话） */
  conversationId?: string
  /** 会话归属助手 id（会话项携带；与当前助手不同时目标模块先切助手） */
  assistantId?: string
  /** true=Agent 会话/助手，false=Chat */
  isAgent: boolean
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

/** 发起会话/助手跳转：写 pending → 请求切模块 → 广播事件 */
export function requestOpenConversation(detail: OpenConversationDetail): void {
  writePending(PENDING_CONV_KEY, detail)
  window.dispatchEvent(
    new CustomEvent('pocketai:switch-module', { detail: { moduleId: detail.isAgent ? 'agent' : 'chat' } })
  )
  window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail }))
}

/**
 * 消费 pending 会话跳转（读后即清，坏 JSON/字段缺失容错）。
 * - expectedIsAgent：模块归属过滤，不匹配保留 pending（防 Chat 挂载清掉 Agent 的 pending）
 * - expectedAssistantId：给定时光要求 pending.assistantId 与之相等（或 pending 不带助手 id），
 *   不匹配保留（防目标助手未切换时，默认助手的列表 effect 抢先消费）
 */
export function consumePendingOpenConversation(
  expectedIsAgent?: boolean,
  expectedAssistantId?: string
): OpenConversationDetail | null {
  const raw = sessionStorage.getItem(PENDING_CONV_KEY)
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<OpenConversationDetail>
    if (d && typeof d.isAgent === 'boolean') {
      if (expectedIsAgent !== undefined && d.isAgent !== expectedIsAgent) return null
      if (
        expectedAssistantId !== undefined &&
        d.assistantId !== undefined &&
        d.assistantId !== expectedAssistantId
      ) {
        return null
      }
      if (d.conversationId === undefined && d.assistantId === undefined) {
        sessionStorage.removeItem(PENDING_CONV_KEY)
        return null
      }
      sessionStorage.removeItem(PENDING_CONV_KEY)
      return {
        isAgent: d.isAgent,
        conversationId: typeof d.conversationId === 'string' ? d.conversationId : undefined,
        assistantId: typeof d.assistantId === 'string' ? d.assistantId : undefined
      }
    }
    sessionStorage.removeItem(PENDING_CONV_KEY)
    return null
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
