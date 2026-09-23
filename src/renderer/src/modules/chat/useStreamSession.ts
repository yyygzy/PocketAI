import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatTarget } from '../../../../shared/types'
import type { CompareColumn } from './ComparisonColumns'
import type { FocusBranch } from './ChatView'

/**
 * 流式会话 hook：收口 ChatModule 中散落的 6 个流式 ref（requestId/finalized/
 * totalColumns/settledCount/focusNonce/streamingConv）与相关状态（liveColumns、
 * focusBranch）及事件订阅逻辑。
 *
 * 暴露的原子操作：
 * - beginStream  发起流式：初始化 ref + liveColumns，返回 requestId（忙时返回 null）
 * - failStream   IPC reject 兜底：清 ref + 清 liveColumns + 按需重载消息
 * - focusNewBranch  regenerate/resend 用：发分支聚焦信号（nonce 自增）
 * - abort        中止当前流式
 * - isStreaming  是否流式中（ref 直读，handler 内可安全调用）
 *
 * init 期数据加载（providers/assistants）仍由 ChatModule 自行处理，本 hook 只管流式。
 */
export interface UseStreamSessionOptions {
  /** finalize 后按需重载消息（仅当当前会话仍为流式会话时） */
  loadMessages: (convId: string) => void
  /** finalize 后刷新会话列表 */
  reloadConversations: () => void
  /** 读取当前会话 id（finalize 时判断是否仍需 loadMessages） */
  getCurrentConvId: () => string | null
}

export interface UseStreamSessionApi {
  /** 流式中的虚拟列（非 null 表示正在流式） */
  liveColumns: CompareColumn[] | null
  /** 分支聚焦信号：regenerate/resend 后把对应轮次切到新分支 */
  focusBranch: FocusBranch | null
  /** 是否流式中（ref 直读，事件 handler 内调用即得最新值） */
  isStreaming: () => boolean
  /** 发起流式：初始化 6 ref + liveColumns，返回 requestId；忙时返回 null */
  beginStream: (convId: string, targets: ChatTarget[]) => string | null
  /** 流式 IPC reject 兜底：清 ref + 清 liveColumns + 按需 loadMessages */
  failStream: (requestId: string, convId: string) => void
  /** 发分支聚焦信号（nonce 自增，ChatView effect 据此回填新分支） */
  focusNewBranch: (turnKey: string, batchId: string) => void
  /** 中止当前流式 */
  abort: () => void
}

export function useStreamSession(opts: UseStreamSessionOptions): UseStreamSessionApi {
  const [liveColumns, setLiveColumns] = useState<CompareColumn[] | null>(null)
  const [focusBranch, setFocusBranch] = useState<FocusBranch | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const finalizedRef = useRef(false)
  const totalColumnsRef = useRef(0)
  const settledCountRef = useRef(0)
  const focusNonceRef = useRef(0)
  const streamingConvRef = useRef<string | null>(null)

  // opts 存 ref，避免事件订阅 effect 因回调重建而反复重订阅（流式期间重订阅可能丢 chunk）
  const optsRef = useRef(opts)
  optsRef.current = opts

  // 订阅流式事件；订阅一次即可，回调内通过 optsRef 读最新的 loadMessages 等
  useEffect(() => {
    const offChunk = window.pocketai.onChatChunk((e) => {
      if (e.requestId !== requestIdRef.current) return
      setLiveColumns((prev) => {
        if (!prev) return prev
        return prev.map((c, i) =>
          i === e.targetIndex ? { ...c, content: c.content + e.delta } : c
        )
      })
    })

    const markSettled = (_requestId: string, index: number, patch: Partial<CompareColumn>) => {
      setLiveColumns((prev) =>
        prev ? prev.map((c, i) => (i === index ? { ...c, ...patch } : c)) : prev
      )
      settledCountRef.current += 1
      if (!finalizedRef.current && settledCountRef.current >= totalColumnsRef.current) {
        finalize()
      }
    }

    const offDone = window.pocketai.onChatDone((e) => {
      if (e.requestId === requestIdRef.current) markSettled(e.requestId, e.targetIndex, { status: 'done' })
    })
    const offError = window.pocketai.onChatError((e) => {
      if (e.requestId === requestIdRef.current) markSettled(e.requestId, e.targetIndex, { status: 'error', error: e.error })
    })

    // finalize 在流式结束后延迟 200ms 再清空/重载，避免立即重渲染打断最后一段输出。
    // 这个 timer 必须在 effect cleanup 时清掉，否则组件卸载后会触发 setLiveColumns 等。
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null
    function finalize() {
      if (finalizedRef.current) return
      finalizedRef.current = true
      const convId = streamingConvRef.current
      requestIdRef.current = null
      streamingConvRef.current = null
      finalizeTimer = setTimeout(() => {
        finalizeTimer = null
        setLiveColumns(null)
        optsRef.current.reloadConversations()
        if (convId && optsRef.current.getCurrentConvId() === convId) optsRef.current.loadMessages(convId)
      }, 200)
    }

    return () => {
      offChunk()
      offDone()
      offError()
      if (finalizeTimer) clearTimeout(finalizeTimer)
    }
  }, [])

  const isStreaming = useCallback(() => requestIdRef.current !== null, [])

  const beginStream = useCallback((convId: string, targets: ChatTarget[]): string | null => {
    if (requestIdRef.current) return null // 正在流式中
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    finalizedRef.current = false
    totalColumnsRef.current = targets.length
    settledCountRef.current = 0
    streamingConvRef.current = convId
    setLiveColumns(
      targets.map((t) => ({
        providerId: t.providerId,
        model: t.model,
        content: '',
        status: 'streaming' as const
      }))
    )
    return requestId
  }, [])

  const failStream = useCallback((requestId: string, convId: string) => {
    if (requestIdRef.current !== requestId) return
    requestIdRef.current = null
    streamingConvRef.current = null
    setLiveColumns(null)
    if (convId && optsRef.current.getCurrentConvId() === convId) optsRef.current.loadMessages(convId)
  }, [])

  const focusNewBranch = useCallback((turnKey: string, batchId: string) => {
    setFocusBranch({ turnKey, batchId, nonce: ++focusNonceRef.current })
  }, [])

  const abort = useCallback(() => {
    if (requestIdRef.current) window.pocketai.abortChat(requestIdRef.current)
  }, [])

  return {
    liveColumns,
    focusBranch,
    isStreaming,
    beginStream,
    failStream,
    focusNewBranch,
    abort
  }
}
