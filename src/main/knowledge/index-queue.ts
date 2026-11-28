// 索引任务队列：将文档入库/重建索引任务放入后台执行
// 避免大文档批量向量化阻塞 IPC 主线程
//
// PERF-09：容量上限 + 同 docId 去重 + 有界并发 + 失败指数退避 + app_config 进度上报。
// 说明：new IndexQueue() 的默认语义（严格 FIFO、失败立即收尾）保持兼容既有单测；
// 生产单例显式传 concurrency=3 / maxAttempts=3 走完整的限流与退避策略。
import { ingestionService, markDocumentFailure } from './ingestion'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { runInSlotKind } from '../providers/local-slot'

const log = createLogger('index-queue')

/** app_config 里的进度键（UI 可据此展示"排队/执行中/成功/失败"） */
export const INDEX_PROGRESS_KEY = 'kb.index_queue.progress'

export interface IndexTask {
  id: string
  kbId: string
  docId: string
  kind: 'file' | 'url' | 'text' | 'reindex'
  payload?: { text?: string; title?: string }
}

export interface IndexProgress {
  /** 尚未开始的任务数 */
  pending: number
  /** 正在执行的任务数 */
  active: number
  /** 本实例累计成功数 */
  succeeded: number
  /** 本实例累计最终失败数（重试耗尽） */
  failed: number
  /** 本实例累计重试次数 */
  retries: number
  updatedAt: number
}

export interface IndexQueueOptions {
  /** 同时执行的任务上限，1–4；默认 1（保持旧的严格 FIFO 语义） */
  concurrency?: number
  /** 每任务最大尝试次数（含首次），默认 1（不重试） */
  maxAttempts?: number
  /** 第一次重试的退避毫秒数，之后指数增长 */
  retryBaseDelayMs?: number
  /** 退避上限，默认 10s */
  retryMaxDelayMs?: number
  /** 等待队列容量上限，默认 500 */
  maxQueueSize?: number
  /** 进度上报器；默认无操作。生产单例写 app_config。 */
  progressReporter?: (progress: IndexProgress) => void | Promise<void>
}

/** 生产用进度上报：动态导入避免测试环境把 electron/app_config 整条链拉进来 */
export async function reportIndexProgressToAppConfig(progress: IndexProgress): Promise<void> {
  const { appConfigRepo } = await import('../db/repositories/app-config.repo')
  appConfigRepo.set(INDEX_PROGRESS_KEY, JSON.stringify(progress))
}

interface QueueEntry {
  task: IndexTask
  attempts: number
  timer?: ReturnType<typeof setTimeout>
}

export class IndexQueue {
  private queue: QueueEntry[] = []
  private active = new Set<string>()
  /** docId 从入队到终态全程占位：排队中/执行中/退避中的同文档都只算一个任务 */
  private reservedTasks = new Map<string, IndexTask>()
  private retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private listeners = new Set<(task: IndexTask) => void>()
  private succeeded = 0
  private failed = 0
  private retries = 0
  private lastReportAt = 0

  private readonly concurrency: number
  private readonly maxAttempts: number
  private readonly retryBaseDelayMs: number
  private readonly retryMaxDelayMs: number
  private readonly maxQueueSize: number
  private readonly progressReporter: IndexQueueOptions['progressReporter']

  constructor(options: IndexQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 1)))
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1))
    this.retryBaseDelayMs = Math.max(1, Math.floor(options.retryBaseDelayMs ?? 250))
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      Math.floor(options.retryMaxDelayMs ?? 10_000)
    )
    this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize ?? 500))
    this.progressReporter = options.progressReporter
  }

  /** 入队一个索引任务，立即返回（不等待执行）。同 docId 重复入队返回原任务，不新增排队项。 */
  enqueue(task: Omit<IndexTask, 'id'>): IndexTask {
    const existing = this.reservedTasks.get(task.docId)
    if (existing) {
      log.info(`索引任务重复入队，合并: kb=${task.kbId} doc=${task.docId}`)
      return existing
    }
    if (this.queue.length >= this.maxQueueSize) {
      // 队列满时不静默扩张内存：显式标失败，让文档状态与"未排上"对齐
      const e = new Error(`索引队列已满（上限 ${this.maxQueueSize}）`)
      log.warn(`索引任务被拒绝: doc=${task.docId} ${e.message}`)
      try { markDocumentFailure(task.docId, e) } catch { /* ignore */ }
      return { ...task, id: `${task.docId}-${Date.now()}` }
    }

    const t: IndexTask = { ...task, id: `${task.docId}-${Date.now()}` }
    this.reservedTasks.set(t.docId, t)
    this.queue.push({ task: t, attempts: 0 })
    log.info(`索引任务入队: kb=${task.kbId} doc=${task.docId} kind=${task.kind}`)
    this.pump()
    this.reportProgress(true)
    return t
  }

  /** 订阅任务完成通知 */
  onTaskDone(fn: (task: IndexTask) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 队列是否还有待处理/正在处理/等待重试的任务 */
  isIdle(): boolean {
    return (
      this.queue.length === 0 &&
      this.active.size === 0 &&
      this.retryTimers.size === 0
    )
  }

  /** 当前等待队列长度（正在执行的任务不计入） */
  size(): number {
    return this.queue.length
  }

  /** 当前进度快照（与写入 app_config 的内容一致） */
  getProgress(): IndexProgress {
    return {
      pending: this.queue.length,
      active: this.active.size,
      succeeded: this.succeeded,
      failed: this.failed,
      retries: this.retries,
      updatedAt: Date.now()
    }
  }

  /** 把执行槽填满；新任务入队/任务结束/重试结束后都调一次 */
  private pump(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!
      this.active.add(entry.task.id)
      void this.runEntry(entry)
    }
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    const task = entry.task
    entry.attempts++
    try {
      // 后台作用域一路透传到 provider 出口（V4-Iter-141）：索引的批量向量化/OCR 都算后台任务，
      // 由 local-slot 在前台在场时排队让路。不在这里问 isIdle——让路是槽位的职责。
      await runInSlotKind('background', async () => {
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
      })
      this.finish(entry, null)
    } catch (e) {
      if (entry.attempts < this.maxAttempts) {
        this.retries++
        const delay = Math.min(
          this.retryMaxDelayMs,
          this.retryBaseDelayMs * 2 ** (entry.attempts - 1)
        )
        log.warn(`索引任务第 ${entry.attempts} 次失败，${delay}ms 后重试: doc=${task.docId} ${errMsg(e)}`)
        // 退避期间不占执行槽，但 docId 仍被 reservedTasks 占住（同文档不会重复入队）
        this.active.delete(task.id)
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer)
          entry.timer = undefined
          this.active.add(task.id)
          void this.runEntry(entry)
        }, delay)
        entry.timer = timer
        this.retryTimers.add(timer)
        this.pump()
        this.reportProgress()
      } else {
        this.finish(entry, e)
      }
    }
  }

  private finish(entry: QueueEntry, error: unknown): void {
    const task = entry.task
    this.active.delete(task.id)
    this.reservedTasks.delete(task.docId)
    if (error) {
      this.failed++
      // ingestion 内部已按真实旧块数收尾；这里兜事务开始前的失败（KB 配置缺失等），
      // 同一收尾口保证「旧索引仍在」不会被写成笼统的 error
      log.warn(`索引任务失败: doc=${task.docId} ${errMsg(error)}`)
      try { markDocumentFailure(task.docId, error) } catch { /* ignore */ }
    } else {
      this.succeeded++
    }
    for (const fn of this.listeners) {
      try { fn(task) } catch { /* ignore listener errors */ }
    }
    this.pump()
    this.reportProgress(true)
  }

  /** 进度上报不阻断队列；高频入队按 250ms 节流，终态强制上报 */
  private reportProgress(force = false): void {
    if (!this.progressReporter) return
    const now = Date.now()
    if (!force && now - this.lastReportAt < 250) return
    this.lastReportAt = now
    try {
      void Promise.resolve(this.progressReporter(this.getProgress())).catch(() => {
        /* 进度写入失败不影响索引 */
      })
    } catch { /* ignore reporter errors */ }
  }
}

/** 生产单例：有界并发 3、最多 3 次尝试、容量 500、进度落 app_config */
export const indexQueue = new IndexQueue({
  concurrency: 3,
  maxAttempts: 3,
  maxQueueSize: 500,
  progressReporter: reportIndexProgressToAppConfig
})
