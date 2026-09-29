// 来源跳转原文：跨模块导航（聊天/KB 问答 → 知识库模块定位分块）。
// 先写 sessionStorage pending（知识库模块未挂载时兜底），再广播模块切换事件
// （复用 App 既有 'pocketai:switch-module' 机制）与 KB_SOURCE_JUMP_EVENT
// （KnowledgeModule 已挂载时即时消费；未挂载时挂载后 consumePendingSourceJump）。
export const KB_SOURCE_JUMP_EVENT = 'kb-open-source'

export interface KbSourceJumpDetail {
  kbId: string
  docId: string
  seq: number
}

const PENDING_KEY = 'kb-pending-source'

/** 发起跳转：写 pending → 请求切到知识库模块 → 广播事件（已挂载时即时消费） */
export function requestSourceJump(detail: KbSourceJumpDetail): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(detail))
  } catch {
    // 存储不可用时已挂载场景仍可工作
  }
  window.dispatchEvent(
    new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'knowledge' } })
  )
  window.dispatchEvent(new CustomEvent(KB_SOURCE_JUMP_EVENT))
}

/** 消费 pending 跳转参数（读后即清，防重复触发） */
export function consumePendingSourceJump(): KbSourceJumpDetail | null {
  const raw = sessionStorage.getItem(PENDING_KEY)
  if (!raw) return null
  sessionStorage.removeItem(PENDING_KEY)
  try {
    const d = JSON.parse(raw) as KbSourceJumpDetail
    if (d && typeof d.kbId === 'string' && typeof d.docId === 'string' && typeof d.seq === 'number') {
      return d
    }
    return null
  } catch {
    return null
  }
}
