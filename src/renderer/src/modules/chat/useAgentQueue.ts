// 运行中排队 / 插队（V4-Iter-238 迁入对话壳，P4 批次 0）：对话壳唯一实现。
//
// 纯结算规则留在 `../agent/queue-settlement`（幂等账本、归位、自动发送判据都在那里），
// 这里只做「宿主无关」的状态与 IPC 编排：宿主壳提供会话身份、当前 requestId、发送入口与
// 前置条件。
//
// P4 批次 2 删壳后，本文件与 `queue-settlement` 是唯一实现。
import { useCallback, useRef, useState } from 'react'
import type { ChatAttachment } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { hasIpcFailed, ipcFailureText, reportIpcError, type IpcFailureInput } from '../../utils/ipc'
import {
  applyInterjectEvent,
  createRunSettlementLedger,
  settleRunQueue,
  type AgentQueueItem
} from '../agent/queue-settlement'

export type { AgentQueueItem }

/** 排队条上限：再多就不是「补一句」而是「批量灌」了，那种场景应该等运行结束再发 */
export const MAX_QUEUE_ITEMS = 20

export interface AgentQueueHost {
  /** 当前会话 id（队列项按会话归属，切会话不丢） */
  getConversationId: () => string | null
  /** 当前运行的 requestId；null = 没有运行（或发送请求还在路上） */
  getRequestId: () => string | null
  /** 是否有运行在跑（ref 语义，事件回调里读得到「此刻」） */
  isRunning: () => boolean
  /** 能否开始新一轮（模型/会话仍在，且宿主允许发送） */
  canStartRun: () => boolean
  /** 发送一条文本（由宿主壳实现，自动发送下一条时调用） */
  send: (text: string, attachments: ChatAttachment[]) => void
}

export interface AgentQueueApi {
  /** 全部会话的排队项（宿主按当前会话过滤后再上屏） */
  queue: AgentQueueItem[]
  enqueueText: (text: string) => void
  interjectText: (text: string) => void
  dropQueued: (clientRef: string) => void
  sendQueuedNow: (clientRef: string) => void
  /** 引擎已经收下插队（收到同 clientRef 的 interject 步事件） */
  ackInterject: (clientRef: string) => void
  /** 一轮结束后的结算：归位未送达的插队项，并按需自动发下一条 */
  settleAfterRun: (conversationId: string, requestId: string, autoSend: boolean) => void
}

export function useAgentQueue(host: AgentQueueHost): AgentQueueApi {
  const { t } = useI18n()
  const toast = useToast()
  const [queue, setQueue] = useState<AgentQueueItem[]>([])
  // 事件回调只有首帧闭包：queueRef 做同步镜像，宿主身份与发送入口也走 ref，避免读到过期值
  const queueRef = useRef<AgentQueueItem[]>([])
  const ledgerRef = useRef(createRunSettlementLedger())
  const hostRef = useRef(host)
  hostRef.current = host

  const writeQueue = useCallback((next: AgentQueueItem[]): void => {
    queueRef.current = next
    setQueue(next)
  }, [])

  /**
   * 放进**当前会话**的排队条，返回 clientRef；空串表示没放进去（文本为空／没有会话／条满）。
   * 条满要说出来：按下入队的人以为那句话已经在路上，静默丢掉等于骗人。
   */
  const pushQueueItem = useCallback(
    (text: string, interjecting: boolean): string => {
      const content = text.trim()
      const convId = hostRef.current.getConversationId()
      if (!content || !convId) return ''
      const forThisConv = queueRef.current.filter((q) => q.conversationId === convId)
      if (forThisConv.length >= MAX_QUEUE_ITEMS) {
        toast.error(t('agent.queue.tooMany', { max: MAX_QUEUE_ITEMS }))
        return ''
      }
      const clientRef = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      writeQueue([...queueRef.current, { clientRef, conversationId: convId, text: content, interjecting }])
      return clientRef
    },
    [t, toast, writeQueue]
  )

  /**
   * 把一条排队项交给正在运行的主干 run（引擎只在下个步边界收下）。
   * 这里「成功」只等于「引擎接了这条请求」，**不等于**它已进这一轮：真正的凭据是随后那条
   * 带同一个 clientRef 的 `interject` 事件。所以成功分支什么都不做——
   * 划掉排队项由 `ackInterject` 负责，运行结束时还挂着的一律按「没送到」归回队列。
   */
  const requestInterject = useCallback(
    (clientRef: string, text: string): void => {
      const backToQueue = (msg?: IpcFailureInput): void => {
        writeQueue(queueRef.current.map((q) => (q.clientRef === clientRef ? { ...q, interjecting: false } : q)))
        if (msg) toast.error(ipcFailureText(msg, t) || t('agent.unknownError'))
      }
      const requestId = hostRef.current.getRequestId()
      // 还没有 requestId（发送请求本身尚在路上）：归回队列等自动发送，不报错误
      if (!requestId) {
        backToQueue()
        return
      }
      void window.pocketai
        .interjectAgent({ requestId, clientRef, text })
        .then((r) => {
          if (hasIpcFailed(r)) backToQueue(r)
        })
        .catch((e) => {
          reportIpcError('agent.interjectAgent')(e)
          backToQueue()
        })
    },
    [t, toast, writeQueue]
  )

  /** 「入队」：等这一轮跑完自动发出（中止/出错时不自动发，见 settleAfterRun） */
  const enqueueText = useCallback(
    (text: string): void => {
      pushQueueItem(text, false)
    },
    [pushQueueItem]
  )

  /** 「立即插队」：先进条（看得见），再交给引擎；接不住就留在条上当普通排队项 */
  const interjectText = useCallback(
    (text: string): void => {
      const content = text.trim()
      const clientRef = pushQueueItem(content, true)
      if (!clientRef) return
      requestInterject(clientRef, content)
    },
    [pushQueueItem, requestInterject]
  )

  /** 撤掉一条还没发出去的排队消息（只动内存，DB 里从来没有它） */
  const dropQueued = useCallback(
    (clientRef: string): void => {
      writeQueue(queueRef.current.filter((q) => q.clientRef !== clientRef))
    },
    [writeQueue]
  )

  /** 排队条上的「发送」：运行中就插队，空闲时当成一条正常消息发出去 */
  const sendQueuedNow = useCallback(
    (clientRef: string): void => {
      const item = queueRef.current.find((q) => q.clientRef === clientRef)
      if (!item || item.interjecting) return
      if (hostRef.current.isRunning()) {
        writeQueue(
          queueRef.current.map((q) => ({
            ...q,
            interjecting: q.clientRef === clientRef ? true : q.interjecting
          }))
        )
        requestInterject(clientRef, item.text)
        return
      }
      if (!hostRef.current.canStartRun()) return
      writeQueue(queueRef.current.filter((q) => q.clientRef !== clientRef))
      hostRef.current.send(item.text, [])
    },
    [requestInterject, writeQueue]
  )

  /**
   * 插队对账：引擎已把这句话收进这一轮。
   * 按 clientRef 过滤即幂等：重复事件结果不变（见 `queue-settlement.applyInterjectEvent`）。
   */
  const ackInterject = useCallback(
    (clientRef: string): void => {
      writeQueue(applyInterjectEvent(queueRef.current, clientRef))
    },
    [writeQueue]
  )

  /**
   * 一轮结束后的收尾（V4-Iter-238 / P2 定稿）：
   *  ① 还挂着「已交给引擎」的项归回排队——没收到 `interject` 事件就是没落库，不归回会永远消失；
   *  ② 只有**正常跑完**且宿主判定「可以发下一条」时才自动发出下一条。中止/出错不自动发：
   *     按停止就是要停下来看结果，紧跟一条自动发送等于没停；后台会话的排队项要等用户切回来再发。
   *
   * 结算由**持有队列的这个 hook**驱动，不依赖 `useStreamSession` 的 `onStreamsSettled`
   * （观测 hook 不订阅也照样 drain）；跨订阅重复到达由账本按 `(requestId, clientRef)` 去重。
   */
  const settleAfterRun = useCallback(
    (conversationId: string, requestId: string, autoSend: boolean): void => {
      const result = settleRunQueue(
        queueRef.current,
        {
          conversationId,
          requestId,
          autoSend,
          canAutoSend: hostRef.current.canStartRun()
        },
        ledgerRef.current
      )
      writeQueue(result.queue)
      if (result.next) hostRef.current.send(result.next.text, [])
    },
    [writeQueue]
  )

  return {
    queue,
    enqueueText,
    interjectText,
    dropQueued,
    sendQueuedNow,
    ackInterject,
    settleAfterRun
  }
}
