// 聊天 IPC：流式事件通过 invoke 的 sender 回推对应窗口
import { BrowserWindow, type WebContents } from 'electron'
import { IPC } from '../../../shared/types'
import type { SendMessagePayload, RegeneratePayload, ResendPayload } from '../../../shared/types'
import { chatService } from '../../chat/chat-service'
import {
  getRuntimeSnapshot,
  clearFailure,
  setRuntimeStateBroadcaster
} from '../../chat/runtime-registry'
import { safeHandle, argsSchema } from '../safe-handle'
import {
  sendMessagePayloadSchema,
  regeneratePayloadSchema,
  resendPayloadSchema,
  requestIdSchema
} from '../../../shared/schemas/chat'

export function registerChatHandlers(): void {
  // B-2：运行态增量广播到所有窗口（主窗口侧栏、独立对话窗口都要能看见「别的会话在跑」）
  setRuntimeStateBroadcaster((e) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.CHAT_RUNTIME_STATE_EVENT, e)
    }
  })

  safeHandle(IPC.CHAT_GET_RUNTIME_STATES, () => getRuntimeSnapshot())

  safeHandle(IPC.CHAT_CLEAR_RUNTIME_FAILURE, (_e, conversationId: string) => {
    clearFailure(conversationId)
    return { ok: true }
  }, argsSchema(requestIdSchema))

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
