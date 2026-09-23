// 索引任务队列：将文档入库/重建索引任务放入后台异步顺序执行
// 避免大文档批量向量化阻塞 IPC 主线程
import { ingestionService } from './ingestion'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('index-queue')

export interface IndexTask {
  id: string
  kbId: string
  docId: string
  kind: 'file' | 'url' | 'text' | 'reindex'
  payload?: { text?: string; title?: string }
}

class IndexQueue {
  private queue: IndexTask[] = []
  private running = false
  private listeners = new Set<(task: IndexTask) => void>()

  /** 入队一个索引任务，立即返回（不等待执行） */
  enqueue(task: Omit<IndexTask, 'id'>): IndexTask {
    const t: IndexTask = { ...task, id: `${task.docId}-${Date.now()}` }
    this.queue.push(t)
    log.info(`索引任务入队: kb=${task.kbId} doc=${task.docId} kind=${task.kind}`)
    this.process()
    return t
  }

  /** 订阅任务完成通知 */
  onTaskDone(fn: (task: IndexTask) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 队列是否还有待处理/正在处理的任务 */
  isIdle(): boolean {
    return this.queue.length === 0 && !this.running
  }

  /** 当前队列长度 */
  size(): number {
    return this.queue.length
  }

  private async process(): Promise<void> {
    if (this.running) return
    this.running = true

    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      try {
        if (task.kind === 'text') {
          await ingestionService.ingestText(
            task.kbId,
            task.docId,
            task.payload?.text ?? '',
            task.payload?.title ?? ''
          )
        } else {
          // file / url / reindex 统一走 ingestDocument
          await ingestionService.ingestDocument(task.kbId, task.docId)
        }
      } catch (e) {
        // ingestion 内部已设置 error 状态，这里仅记录日志
        log.warn(`索引任务失败: doc=${task.docId} ${errMsg(e)}`)
        try { kbDocRepo.setStatus(task.docId, 'error', errMsg(e)) } catch { /* ignore */ }
      } finally {
        for (const fn of this.listeners) {
          try { fn(task) } catch { /* ignore listener errors */ }
        }
      }
    }

    this.running = false
  }
}

export const indexQueue = new IndexQueue()
