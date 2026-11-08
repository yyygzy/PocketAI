import type { ConversationRecord } from '../../../../shared/types'

/**
 * 子代理会话的只读判定（P2，V4-Iter-459）。
 *
 * 从 `useAgentChat` 里搬出来的「归处」：P4 删除 `useAgentChat` 之后，`ChatModule` 仍要能判
 * 「这条会话由子代理跑出 → 输入区只读」。因此判据只依赖会话记录上的 `parentConversationId`，
 * 不依赖任何 Agent 壳的 hook；读失败（`failed`）与读到子会话一样按只读处理——不能让一次读失败
 * 演成「可以往里发消息」。
 */
export type SubSessionIdentity =
  | { state: 'loading' }
  | { state: 'ok'; record: ConversationRecord | null }
  | { state: 'failed'; reason: string }

/** 记录层面的判据（ChatModule 手里只有列表行/单条读回时直接用这个） */
export function isReadonlyConversation(
  record: Pick<ConversationRecord, 'parentConversationId'> | null | undefined
): boolean {
  return !!record?.parentConversationId
}

export function isSubSessionReadonly(identity: SubSessionIdentity): boolean {
  if (identity.state === 'failed') return true
  return identity.state === 'ok' ? isReadonlyConversation(identity.record) : false
}

export function subSessionOf(identity: SubSessionIdentity): ConversationRecord | null {
  return identity.state === 'ok' && identity.record && isReadonlyConversation(identity.record)
    ? identity.record
    : null
}

export function identityUnreadOf(identity: SubSessionIdentity): string | null {
  return identity.state === 'failed' ? identity.reason : null
}
