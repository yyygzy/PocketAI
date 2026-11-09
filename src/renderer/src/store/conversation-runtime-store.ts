// 渲染端运行态镜像（B-2）。
//
// 事实来源在主进程 runtime-registry：这里只做「快照 + 增量」的本地副本，供侧栏与对话页读数。
// 刻意不从 `conversations.status` 推导（D7：那一列只写不读）——旧数据里残留的 streaming
// 会被启动对账改成 interrupted，但界面只认这里的事件。
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChatRuntimeStateEvent } from '../../../shared/types'
import { hasIpcFailed, logIpcError, reportIpcError } from '../utils/ipc'

interface RuntimeMirrorState {
  byConversation: Record<string, ChatRuntimeStateEvent>
  /** 增量：state='idle' 表示移除（运行结束/角标被清除） */
  apply: (event: ChatRuntimeStateEvent) => void
  /** 快照：整体替换，顺带清掉主进程已不存在的条目 */
  replace: (list: ChatRuntimeStateEvent[]) => void
  reset: () => void
}

export const useConversationRuntimeStore = create<RuntimeMirrorState>((set) => ({
  byConversation: {},
  apply: (event) =>
    set((s) => {
      const next = { ...s.byConversation }
      if (event.state === 'idle') delete next[event.conversationId]
      else next[event.conversationId] = event
      return { byConversation: next }
    }),
  replace: (list) =>
    set(() => {
      const next: Record<string, ChatRuntimeStateEvent> = {}
      for (const e of list) if (e.state !== 'idle') next[e.conversationId] = e
      return { byConversation: next }
    }),
  reset: () => set({ byConversation: {} })
}))

/** 单个会话的运行态（无登记时 undefined） */
export function useConversationRuntime(conversationId: string | null | undefined): ChatRuntimeStateEvent | undefined {
  return useConversationRuntimeStore((s) => (conversationId ? s.byConversation[conversationId] : undefined))
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
