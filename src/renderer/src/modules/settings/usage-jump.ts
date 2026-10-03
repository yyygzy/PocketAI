// 用量排行点击跳转：跨模块导航（设置/用量面板 → 聊天模块定位会话/助手）。
// 先写 sessionStorage pending（聊天模块未挂载时兜底），再请求切模块 + 广播事件
// （ChatModule 已挂载时即时消费；未挂载时挂载后 consumePendingUsageJump）。
export const USAGE_JUMP_EVENT = 'usage-open-target'

export type UsageJumpDetail =
  | { type: 'conversation'; convId: string; messageId?: string }
  | { type: 'assistant'; assistantId: string }

const PENDING_KEY = 'usage-pending-jump'

/** 发起跳转：写 pending → 请求切到聊天模块 → 广播事件 */
export function requestUsageJump(detail: UsageJumpDetail): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(detail))
  } catch {
    // 存储不可用时已挂载场景仍可工作
  }
  window.dispatchEvent(
    new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'chat' } })
  )
  window.dispatchEvent(new CustomEvent(USAGE_JUMP_EVENT))
}

/** 消费 pending 跳转参数（读后即清，防重复触发） */
export function consumePendingUsageJump(): UsageJumpDetail | null {
  const raw = sessionStorage.getItem(PENDING_KEY)
  if (!raw) return null
  sessionStorage.removeItem(PENDING_KEY)
  try {
    const d = JSON.parse(raw) as unknown
    if (
      d &&
      typeof d === 'object' &&
      'type' in d &&
      (d.type === 'conversation' || d.type === 'assistant')
    ) {
      const detail = d as UsageJumpDetail
      if (detail.type === 'conversation' && typeof detail.convId === 'string') return detail
      if (detail.type === 'assistant' && typeof detail.assistantId === 'string') return detail
    }
    return null
  } catch {
    return null
  }
}
