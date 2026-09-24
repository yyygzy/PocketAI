// preload/popup.ts：快捷浮窗（#/popup）的最小能力暴露
//
// 浮窗是主窗口之外的快捷问答 / 选区助手 overlay，只需 chat + providers +
// assistants + popup 相关能力。与主 preload 分离，避免浮窗渲染进程被攻陷时
// 拿到加密密钥、备份、文件系统等全部能力。
//
// 约束：浮窗与主窗口共享 index.html bundle（仅渲染 <PopupApp />），
// 因此本 preload 必须覆盖 PopupApp 及其依赖（custom-css 的 getUiPrefs）
// 实际调用的全部方法，否则运行时 undefined。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type {
  AssistantRecord,
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ConversationRecord,
  PopupPayload,
  ProviderRecord,
  SendMessagePayload,
  UiPreferences
} from '../shared/types'
import type { PocketAPI } from './index'

type PopupApiShape = Pick<
  PocketAPI,
  | 'getUiPrefs'
  | 'listProviders'
  | 'listAssistants'
  | 'getPopupPayload'
  | 'onPopupPayload'
  | 'onChatChunk'
  | 'onChatDone'
  | 'onChatError'
  | 'fetchModels'
  | 'createConversation'
  | 'sendMessage'
  | 'abortChat'
  | 'hidePopup'
>

const api: PopupApiShape = {
  // ── UI 偏好（custom-css 注入依赖） ──
  getUiPrefs: (): Promise<{ ok: boolean; data?: UiPreferences; error?: string }> =>
    ipcRenderer.invoke(IPC.UI_GET_PREFS),

  // ── Providers / Assistants ──
  listProviders: (): Promise<ProviderRecord[]> =>
    ipcRenderer.invoke(IPC.PROVIDER_LIST),
  listAssistants: (): Promise<AssistantRecord[]> =>
    ipcRenderer.invoke(IPC.ASSISTANT_LIST),
  fetchModels: (id: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.PROVIDER_FETCH_MODELS, id),

  // ── Conversation / Chat ──
  createConversation: (
    assistantId?: string | null,
    title?: string
  ): Promise<ConversationRecord> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CREATE, assistantId, title),
  sendMessage: (payload: SendMessagePayload): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_SEND, payload),
  abortChat: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CHAT_ABORT, requestId),

  onChatChunk: (handler: (e: ChatChunkEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChatChunkEvent) => handler(data)
    ipcRenderer.on(IPC.CHAT_CHUNK_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHAT_CHUNK_EVENT, listener)
  },
  onChatDone: (handler: (e: ChatDoneEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChatDoneEvent) => handler(data)
    ipcRenderer.on(IPC.CHAT_DONE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHAT_DONE_EVENT, listener)
  },
  onChatError: (handler: (e: ChatErrorEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChatErrorEvent) => handler(data)
    ipcRenderer.on(IPC.CHAT_ERROR_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHAT_ERROR_EVENT, listener)
  },

  // ── Popup 自身 ──
  hidePopup: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.POPUP_HIDE),
  getPopupPayload: (): Promise<PopupPayload | null> =>
    ipcRenderer.invoke(IPC.POPUP_GET_PAYLOAD),
  onPopupPayload: (handler: (e: PopupPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: PopupPayload) => handler(data)
    ipcRenderer.on(IPC.POPUP_PAYLOAD_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.POPUP_PAYLOAD_EVENT, listener)
  }
}

contextBridge.exposeInMainWorld('pocketai', api)

export type PopupAPI = typeof api
