// 渲染端运行态/未读镜像（B-2 / B-4）。
//
// 事实来源在主进程：运行态在 runtime-registry，未读在 `conversations.unread`。这里只做
// 「快照 + 增量」的本地副本，供侧栏与对话页读数。刻意不从 `conversations.status` 推导
// （D7：那一列只写不读），也不在渲染端自己算「最后一条是不是助手」——未读只有主进程一个口径。
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChatConversationStateEvent, ChatRuntimeStateEvent } from '../../../shared/types'
import { hasIpcFailed, logIpcError, reportIpcError } from '../utils/ipc'

interface RuntimeMirrorState {
  byConversation: Record<string, ChatRuntimeStateEvent>
  /** B-4：未读镜像（只在 true 时存键；清除即删键） */
  unreadByConversation: Record<string, boolean>
  /** 增量：运行态 `state='idle'` 表示移除；`kind='unread'` 走未读面 */
  apply: (event: ChatConversationStateEvent) => void
  /** 快照：整体替换两份镜像，顺带清掉主进程已不存在的条目 */
  replace: (list: ChatConversationStateEvent[]) => void
  reset: () => void
}

export const useConversationRuntimeStore = create<RuntimeMirrorState>((set) => ({
  byConversation: {},
  unreadByConversation: {},
  apply: (event) =>
    set((s) => {
      if (event.kind === 'unread') {
        const next = { ...s.unreadByConversation }
        if (event.unread) next[event.conversationId] = true
        else delete next[event.conversationId]
        return { unreadByConversation: next }
      }
      const next = { ...s.byConversation }
      if (event.state === 'idle') delete next[event.conversationId]
      else next[event.conversationId] = event
      return { byConversation: next }
    }),
  replace: (list) =>
    set(() => {
      const next: Record<string, ChatRuntimeStateEvent> = {}
      const unread: Record<string, boolean> = {}
      for (const e of list) {
        if (e.kind === 'unread') {
          if (e.unread) unread[e.conversationId] = true
          continue
        }
        if (e.state !== 'idle') next[e.conversationId] = e
      }
      return { byConversation: next, unreadByConversation: unread }
    }),
  reset: () => set({ byConversation: {}, unreadByConversation: {} })
}))

/** 单个会话的运行态（无登记时 undefined） */
export function useConversationRuntime(conversationId: string | null | undefined): ChatRuntimeStateEvent | undefined {
  return useConversationRuntimeStore((s) => (conversationId ? s.byConversation[conversationId] : undefined))
}

/** B-4：单个会话是否有未读的助手消息 */
export function useConversationUnread(conversationId: string | null | undefined): boolean {
  return useConversationRuntimeStore((s) => (conversationId ? !!s.unreadByConversation[conversationId] : false))
}

/**
 * 挂载时取快照、订阅增量，窗口重新聚焦时再对齐一次（后台窗口的期间可能错过事件）。
 * 调用方只放一处（ChatModule）：多份订阅会让同一个事件 apply 多次（幂等但没必要）。
 */
export function useConversationRuntimeSync(): void {
  useEffect(() => {
    const refresh = (): void => {
      window.pocketai
        .getChatRuntimeStates()
        .then((list) => {
          if (hasIpcFailed(list)) {
            logIpcError('chat.runtime.snapshot', list.error)
            return
          }
          if (!Array.isArray(list)) return
          useConversationRuntimeStore.getState().replace(list)
        })
        .catch(reportIpcError('chat.runtime.snapshot'))
    }
    const off = window.pocketai.onChatRuntimeState((e) => {
      useConversationRuntimeStore.getState().apply(e)
    })
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [])
}
