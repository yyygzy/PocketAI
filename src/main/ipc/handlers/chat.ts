// 聊天 IPC：流式事件通过 invoke 的 sender 回推对应窗口
import { BrowserWindow, type WebContents } from 'electron'
import { IPC } from '../../../shared/types'
import type {
  SendMessagePayload,
  RegeneratePayload,
  ResendPayload,
  ChatReadStateReport,
  ChatReadStateResult
} from '../../../shared/types'
import { chatService } from '../../chat/chat-service'
import {
  getRuntimeSnapshot,
  clearFailure,
  setRuntimeStateBroadcaster
} from '../../chat/runtime-registry'
import {
  forgetReadState,
  listUnreadEvents,
  reportReadState
} from '../../chat/unread-state'
import { safeHandle, argsSchema } from '../safe-handle'
import {
  sendMessagePayloadSchema,
  regeneratePayloadSchema,
  resendPayloadSchema,
  requestIdSchema,
  readStateReportSchema
} from '../../../shared/schemas/chat'

/** 已挂过 destroyed 监听的 sender；只挂一次，避免每次上报都加监听 */
const readStateSenders = new Set<number>()

function watchReadStateSender(sender: WebContents): void {
  if (readStateSenders.has(sender.id)) return
  readStateSenders.add(sender.id)
  sender.once('destroyed', () => {
    readStateSenders.delete(sender.id)
    forgetReadState(sender.id)
  })
}

export function registerChatHandlers(): void {
  // B-2：运行态增量广播到所有窗口（主窗口侧栏、独立对话窗口都要能看见「别的会话在跑」）
  setRuntimeStateBroadcaster((e) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.CHAT_RUNTIME_STATE_EVENT, e)
    }
  })

  // B-2 的运行态 + B-4 的未读共用一发快照：未读只是 conversations.unread 的投影，
  // 挂载/聚焦/重启后都从这里对齐，渲染端不自己推导。
  safeHandle(IPC.CHAT_GET_RUNTIME_STATES, () => [...getRuntimeSnapshot(), ...listUnreadEvents()])

  safeHandle(IPC.CHAT_CLEAR_RUNTIME_FAILURE, (_e, conversationId: string) => {
    clearFailure(conversationId)
    return { ok: true }
  }, argsSchema(requestIdSchema))

  // B-4：读态上报。清不清由主进程按「聚焦+可见+未锁屏」判定（D3），渲染端只负责说实话。
  safeHandle(IPC.CHAT_REPORT_READ_STATE, (event, report: ChatReadStateReport) => {
    watchReadStateSender(event.sender)
    const result: ChatReadStateResult = {
      ok: true,
      unread: reportReadState(event.sender.id, report)
    }
    return result
  }, argsSchema(readStateReportSchema))

  safeHandle(IPC.CHAT_SEND, (event, payload: SendMessagePayload) => {
    const sender: WebContents = event.sender
    return chatService.send(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  }, argsSchema(sendMessagePayloadSchema))

  safeHandle(IPC.CHAT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  }, argsSchema(requestIdSchema))

  safeHandle(IPC.CHAT_REGENERATE, (event, payload: RegeneratePayload) => {
    const sender: WebContents = event.sender
    return chatService.regenerate(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  }, argsSchema(regeneratePayloadSchema))

  safeHandle(IPC.CHAT_RESEND, (event, payload: ResendPayload) => {
    const sender: WebContents = event.sender
    return chatService.resend(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  }, argsSchema(resendPayloadSchema))
}
