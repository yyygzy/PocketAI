// PERF-09：索引队列容量/去重/并发/退避/进度上报验收
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  ingestText: vi.fn(),
  ingestDocument: vi.fn(),
  markDocumentFailure: vi.fn(),
  appConfigSet: vi.fn()
}))

vi.mock('../src/main/knowledge/ingestion', () => ({
  ingestionService: { ingestText: mocks.ingestText, ingestDocument: mocks.ingestDocument },
  markDocumentFailure: mocks.markDocumentFailure
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { set: mocks.appConfigSet }
}))

import {
  IndexQueue,
  INDEX_PROGRESS_KEY,
  reportIndexProgressToAppConfig
} from '../src/main/knowledge/index-queue'
import type { IndexProgress } from '../src/main/knowledge/index-queue'

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

async function drain(q: IndexQueue): Promise<void> {
  // 退避用真实 setTimeout，drain 必须让真实时间推进（setImmediate 空转可能跑不满 2ms）
  for (let i = 0; i < 200 && !q.isIdle(); i++) {
    await new Promise<void>((r) => setTimeout(r, 5))
  }
  expect(q.isIdle()).toBe(true)
}

beforeEach(() => {
  // reset 而不是 clear：清掉上一次 mockRejectedValueOnce 遗留的一次性实现
  vi.resetAllMocks()
  mocks.ingestText.mockResolvedValue(undefined)
  mocks.ingestDocument.mockResolvedValue(undefined)
  mocks.markDocumentFailure.mockReturnValue(undefined)
  mocks.appConfigSet.mockReturnValue(undefined)
})

describe('PERF-09 · 容量与去重', () => {
  it('500 个不同文档入队不超容量上限，重复 docId 不新增排队项', async () => {
    const reporters: Array<() => void> = []
    mocks.ingestDocument.mockImplementation(
      () => new Promise<void>((resolve) => { reporters.push(resolve) })
    )
    const q = new IndexQueue({ concurrency: 1, maxQueueSize: 500 })
    for (let i = 0; i < 500; i++) q.enqueue({ kbId: 'kb', docId: `d${i}`, kind: 'file' })
    expect(q.size()).toBeLessThanOrEqual(500)
    expect(q.size()).toBe(499)

    const before = q.size()
    for (let i = 0; i < 100; i++) q.enqueue({ kbId: 'kb', docId: `d${i}`, kind: 'file' })
    expect(q.size()).toBe(before)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(1)
    // 用例不等待 500 个占位任务跑完；逐个放行即可回收
    for (const resolve of reporters) resolve()
    await flush()
  })

  it('超容量的新文档被拒绝并标记失败，不静默扩张队列', async () => {
    mocks.ingestDocument.mockImplementation(() => new Promise<void>(() => {}))
    const q = new IndexQueue({ concurrency: 1, maxQueueSize: 1 })
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd2', kind: 'file' })
    expect(q.size()).toBe(1)
    q.enqueue({ kbId: 'kb', docId: 'd3', kind: 'file' })
    expect(q.size()).toBe(1)
    expect(mocks.markDocumentFailure).toHaveBeenCalledWith(
      'd3',
      expect.objectContaining({ message: expect.stringContaining('队列已满') })
    )
  })

  it('任务完成后同 docId 可重新入队（reindex 场景）', async () => {
    const q = new IndexQueue()
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    await drain(q)
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'reindex' })
    await drain(q)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(2)
  })
})

describe('PERF-09 · 并发上限', () => {
  it('concurrency=3 时最多 3 个任务同时在跑，空槽出现才启动下一个', async () => {
    const resolvers = new Map<string, () => void>()
    mocks.ingestDocument.mockImplementation((_kbId: string, docId: string) =>
      new Promise<void>((resolve) => { resolvers.set(docId, resolve) })
    )
    const q = new IndexQueue({ concurrency: 3 })
    for (let i = 1; i <= 5; i++) q.enqueue({ kbId: 'kb', docId: `d${i}`, kind: 'file' })
    await flush()
    expect(resolvers.size).toBe(3)
    expect(q.getProgress().active).toBe(3)

    resolvers.get('d1')!()
    await flush()
    expect(resolvers.size).toBe(4)
    expect(q.getProgress().active).toBe(3)
    for (const docId of ['d2', 'd3', 'd4']) {
      resolvers.get(docId)!()
      await flush()
    }
    resolvers.get('d5')!()
    await drain(q)
  })
})

describe('PERF-09 · 指数退避重试', () => {
  it('失败两次后第三次成功：尝试 3 次，不标记最终失败', async () => {
    mocks.ingestDocument.mockRejectedValueOnce(new Error('第一次'))
    mocks.ingestDocument.mockRejectedValueOnce(new Error('第二次'))
    mocks.ingestDocument.mockResolvedValueOnce(undefined)
    const q = new IndexQueue({ maxAttempts: 3, retryBaseDelayMs: 2, retryMaxDelayMs: 10 })
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    await drain(q)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(3)
    expect(mocks.markDocumentFailure).not.toHaveBeenCalled()
    expect(q.getProgress().retries).toBe(2)
    expect(q.getProgress().succeeded).toBe(1)
  })

  it('超过最大次数后收尾：标记失败一次、通知一次', async () => {
    mocks.ingestDocument.mockRejectedValue(new Error('一直失败'))
    const q = new IndexQueue({ maxAttempts: 2, retryBaseDelayMs: 2, retryMaxDelayMs: 10 })
    const done: string[] = []
    q.onTaskDone((t) => done.push(t.docId))
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    await drain(q)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(2)
    expect(mocks.markDocumentFailure).toHaveBeenCalledTimes(1)
    expect(done).toEqual(['d1'])
    expect(q.getProgress().failed).toBe(1)
  })
})

describe('PERF-09 · 进度上报 app_config', () => {
  it('进度写入 app_config 的 INDEX_PROGRESS_KEY，值为 JSON 快照', async () => {
    const progress: IndexProgress = {
      pending: 2, active: 3, succeeded: 10, failed: 1, retries: 4, updatedAt: 123
    }
    await reportIndexProgressToAppConfig(progress)
    expect(mocks.appConfigSet).toHaveBeenCalledWith(INDEX_PROGRESS_KEY, JSON.stringify(progress))
  })

  it('队列进度变化触发 reporter（入队与终态各一次）', async () => {
    const reports: IndexProgress[] = []
    const q = new IndexQueue({ progressReporter: (p) => { reports.push(p) } })
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    await drain(q)
    expect(reports.length).toBeGreaterThanOrEqual(2)
    expect(reports.at(-1)?.succeeded).toBe(1)
    expect(reports.at(-1)?.pending).toBe(0)
  })
})
