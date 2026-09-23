// 聊天 IPC：流式事件通过 invoke 的 sender 回推对应窗口
import { ipcMain, type WebContents } from 'electron'
import { IPC } from '../../../shared/types'
import type { SendMessagePayload, RegeneratePayload, ResendPayload } from '../../../shared/types'
import { chatService } from '../../chat/chat-service'

export function registerChatHandlers(): void {
  ipcMain.handle(IPC.CHAT_SEND, (event, payload: SendMessagePayload) => {
    const sender: WebContents = event.sender
    return chatService.send(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  })

  ipcMain.handle(IPC.CHAT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  })

  ipcMain.handle(IPC.CHAT_REGENERATE, (event, payload: RegeneratePayload) => {
    const sender: WebContents = event.sender
    return chatService.regenerate(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  })

  ipcMain.handle(IPC.CHAT_RESEND, (event, payload: ResendPayload) => {
    const sender: WebContents = event.sender
    return chatService.resend(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  })
}
