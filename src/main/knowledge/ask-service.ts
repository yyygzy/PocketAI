// KB 问答模式服务：知识库详情页内「选库即聊」——检索 → 编号引用上下文 → 流式生成。
// 轻量实现：对话不落库（内存态在前端），chunk/done/error 走独立 IPC 事件通道，
// 与 ChatService 的 conversation 链路完全解耦。
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ragService } from './rag'
import { providerManager } from '../providers/manager'
import type { AdapterChatMessage } from '../providers/types'
import type { KbAskChunkEvent, KbAskDoneEvent, KbAskErrorEvent, KbAskMessage, MessageSource, RetrievedChunk } from '../../shared/types'
import { IPC } from '../../shared/types'

/** 追问历史最多携带条数（超出截断最早的） */
export const KB_ASK_MAX_HISTORY = 10

/**
 * 拼装问答消息序列（纯函数）：
 * [system(知识上下文)] + 最近 KB_ASK_MAX_HISTORY 条历史 + user(当前问题)
 */
export function buildAskMessages(
  question: string,
  kbContext: string,
  history: KbAskMessage[]
): AdapterChatMessage[] {
  const msgs: AdapterChatMessage[] = []
  if (kbContext) {
    msgs.push({ role: 'system', content: kbContext })
  }
  const trimmed = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => m.content.trim().length > 0)
    .slice(-KB_ASK_MAX_HISTORY)
  for (const m of trimmed) {
    msgs.push({ role: m.role, content: m.content })
  }
  msgs.push({ role: 'user', content: question })
  return msgs
}

/** RetrievedChunk → MessageSource（与聊天引用溯源同构） */
export function chunksToSources(chunks: RetrievedChunk[]): MessageSource[] {
  return chunks.map((c) => ({
    chunkId: c.chunkId,
    docId: c.docId,
    docTitle: c.docTitle,
    content: c.content
  }))
}

type EmitFn = (channel: string, payload: unknown) => void

class KbAskService {
  private controllers = new Map<string, AbortController>()

  /**
   * 发起一轮问答：先同步完成检索（invoke 返回 requestId + sources），
   * 生成过程异步执行，delta 经 KB_ASK_CHUNK_EVENT 推送，结束经 done/error 事件。
   */
  ask(
    sender: BrowserWindow['webContents'],
    args: {
      kbIds: string[]
      providerId: string
      model: string
      question: string
      history: KbAskMessage[]
    }
  ): { requestId: string; sources: MessageSource[] } {
    const requestId = randomUUID()
    const { kbIds, providerId, model, question, history } = args

    // 检索失败直接走 error 事件（与生成失败同一通道），不 reject invoke
    void (async () => {
      const emit: EmitFn = (channel, payload) => {
        if (!sender.isDestroyed()) sender.send(channel, payload)
      }
      const controller = new AbortController()
      this.controllers.set(requestId, controller)

      let accumulated = ''
      const isAbort = (err: unknown): boolean =>
        err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))

      try {
        const { chunks } = await ragService.retrieve(kbIds, question)
        const sources = chunksToSources(chunks)
        const kbContext = ragService.buildContext(chunks)
        const messages = buildAskMessages(question, kbContext, history)

        const adapter = providerManager.getAdapter(providerId)
        if (!adapter) throw new Error(`未找到 Provider：${providerId}`)
        const result = await adapter.streamChat(
          messages,
          { model, signal: controller.signal },
          {
            onDelta: (delta: string) => {
              accumulated += delta
              const e: KbAskChunkEvent = { requestId, delta }
              emit(IPC.KB_ASK_CHUNK_EVENT, e)
            }
          }
        )
        const e: KbAskDoneEvent = {
          requestId,
          fullContent: result.content,
          sources
        }
        emit(IPC.KB_ASK_DONE_EVENT, e)
      } catch (err) {
        if (isAbort(err)) {
          // 用户主动停止：保留已生成的部分内容，按 done 收尾
          const e: KbAskDoneEvent = { requestId, fullContent: accumulated, sources: [] }
          emit(IPC.KB_ASK_DONE_EVENT, e)
        } else {
          const e: KbAskErrorEvent = {
            requestId,
            error: err instanceof Error ? err.message : String(err)
          }
          emit(IPC.KB_ASK_ERROR_EVENT, e)
        }
      } finally {
        this.controllers.delete(requestId)
      }
    })()

    return { requestId, sources: [] }
  }

  abort(requestId: string): void {
    this.controllers.get(requestId)?.abort()
    this.controllers.delete(requestId)
  }
}

export const kbAskService = new KbAskService()
