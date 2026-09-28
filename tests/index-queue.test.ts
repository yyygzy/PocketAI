// index-queue 知识库索引任务队列测试
//
// 覆盖后台顺序执行队列的状态与分支：
// - enqueue 立即返回生成 id 的任务；process 单飞（running 期间不重复启动）
// - text 任务走 ingestText（payload 缺省补空串），file/url/reindex 统一走 ingestDocument
// - FIFO 顺序执行：上一任务完成前不启动下一任务
// - 失败不阻断：setStatus(docId,'error') 落库 + 后续任务继续；setStatus 二次抛错被吞
// - onTaskDone 成功/失败都通知、可退订、listener 抛错不影响其他监听者
//
// 策略：vi.hoisted 集中 mocks + vi.mock ingestion/kb-doc.repo/logger；
// 通过导出的 IndexQueue 类创建全新实例隔离测试，单例仅验证导出可用。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  ingestText: vi.fn(),
  ingestDocument: vi.fn(),
  setStatus: vi.fn()
}))

vi.mock('../src/main/knowledge/ingestion', () => ({
  ingestionService: { ingestText: mocks.ingestText, ingestDocument: mocks.ingestDocument }
}))

vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: { setStatus: mocks.setStatus }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { IndexQueue, indexQueue } from '../src/main/knowledge/index-queue'
import type { IndexTask } from '../src/main/knowledge/index-queue'

/** 反复让出事件循环直到队列排空（ingestion mock 均为立即 resolve） */
async function drain(q: IndexQueue): Promise<void> {
  for (let i = 0; i < 50 && !q.isIdle(); i++) {
    await new Promise<void>((r) => setImmediate(r))
  }
  expect(q.isIdle()).toBe(true)
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ingestText.mockResolvedValue(undefined)
  mocks.ingestDocument.mockResolvedValue(undefined)
  mocks.setStatus.mockReturnValue(undefined)
})

describe('IndexQueue — 入队与队列状态', () => {
  it('enqueue 立即返回任务，id 由 docId 与时间戳组成', () => {
    const q = new IndexQueue()
    const t = q.enqueue({ kbId: 'kb-1', docId: 'doc-1', kind: 'file' })
    expect(t.kbId).toBe('kb-1')
    expect(t.docId).toBe('doc-1')
    expect(t.kind).toBe('file')
    expect(t.id).toMatch(/^doc-1-\d+$/)
  })

  it('首个任务被同步取走执行中：isIdle 为 false、size 反映剩余排队数', async () => {
    const q = new IndexQueue()
    let resolveFirst!: () => void
    mocks.ingestDocument.mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r }))
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd2', kind: 'file' })
    expect(q.isIdle()).toBe(false)
    expect(q.size()).toBe(1)
    resolveFirst()
    await drain(q)
  })

  it('全部任务完成后回到空闲态、size 归零', async () => {
    const q = new IndexQueue()
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd2', kind: 'url' })
    await drain(q)
    expect(q.size()).toBe(0)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(2)
  })

  it('空闲时 isIdle 为 true', () => {
    expect(new IndexQueue().isIdle()).toBe(true)
  })
})

describe('IndexQueue — 任务分发', () => {
  it('text 任务走 ingestText，payload 缺省补空串', async () => {
    const q = new IndexQueue()
    q.enqueue({ kbId: 'kb', docId: 'doc-t', kind: 'text' })
    await drain(q)
    expect(mocks.ingestText).toHaveBeenCalledWith('kb', 'doc-t', '', '')
    expect(mocks.ingestDocument).not.toHaveBeenCalled()
  })

  it('text 任务携带 payload.text/title 时原样传入', async () => {
    const q = new IndexQueue()
    q.enqueue({ kbId: 'kb', docId: 'doc-t', kind: 'text', payload: { text: '正文', title: '标题' } })
    await drain(q)
    expect(mocks.ingestText).toHaveBeenCalledWith('kb', 'doc-t', '正文', '标题')
  })

  it('file/url/reindex 三种任务统一走 ingestDocument', async () => {
    const q = new IndexQueue()
    q.enqueue({ kbId: 'kb', docId: 'd-file', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd-url', kind: 'url' })
    q.enqueue({ kbId: 'kb', docId: 'd-re', kind: 'reindex' })
    await drain(q)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(3)
    expect(mocks.ingestDocument).toHaveBeenNthCalledWith(1, 'kb', 'd-file')
    expect(mocks.ingestDocument).toHaveBeenNthCalledWith(2, 'kb', 'd-url')
    expect(mocks.ingestDocument).toHaveBeenNthCalledWith(3, 'kb', 'd-re')
    expect(mocks.ingestText).not.toHaveBeenCalled()
  })

  it('FIFO 顺序执行：上一任务完成前不启动下一任务', async () => {
    const q = new IndexQueue()
    const order: string[] = []
    let resolveFirst!: () => void
    mocks.ingestDocument.mockImplementation((_kbId: string, docId: string) => {
      order.push(docId)
      if (docId === 'd1') return new Promise<void>((r) => { resolveFirst = r })
      return Promise.resolve()
    })
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd2', kind: 'file' })
    await flush()
    // d1 未完成前 d2 不得开始
    expect(order).toEqual(['d1'])
    resolveFirst()
    await drain(q)
    expect(order).toEqual(['d1', 'd2'])
  })
})

describe('IndexQueue — 失败不阻断', () => {
  it('任务失败 → setStatus(docId,"error",消息) 落库，后续任务继续执行', async () => {
    const q = new IndexQueue()
    mocks.ingestDocument.mockImplementation((_kbId: string, docId: string) =>
      docId === 'd-bad' ? Promise.reject(new Error('向量化超时')) : Promise.resolve()
    )
    q.enqueue({ kbId: 'kb', docId: 'd-bad', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd-good', kind: 'file' })
    await drain(q)
    expect(mocks.setStatus).toHaveBeenCalledWith('d-bad', 'error', '向量化超时')
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(2)
  })

  it('字符串异常也能透传给 setStatus（errMsg 收口）', async () => {
    const q = new IndexQueue()
    mocks.ingestText.mockRejectedValueOnce('解析失败')
    q.enqueue({ kbId: 'kb', docId: 'doc-t', kind: 'text' })
    await drain(q)
    expect(mocks.setStatus).toHaveBeenCalledWith('doc-t', 'error', '解析失败')
  })

  it('setStatus 自身抛错被吞掉，不影响队列继续', async () => {
    const q = new IndexQueue()
    mocks.setStatus.mockImplementation(() => { throw new Error('db closed') })
    mocks.ingestDocument.mockImplementation((_kbId: string, docId: string) =>
      docId === 'd-bad' ? Promise.reject(new Error('boom')) : Promise.resolve()
    )
    q.enqueue({ kbId: 'kb', docId: 'd-bad', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd-good', kind: 'file' })
    await drain(q)
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(2)
  })
})

describe('IndexQueue — onTaskDone 监听', () => {
  it('成功与失败的任务都通知监听者', async () => {
    const q = new IndexQueue()
    const done: IndexTask[] = []
    q.onTaskDone((t) => done.push(t))
    mocks.ingestDocument.mockImplementation((_kbId: string, docId: string) =>
      docId === 'd-bad' ? Promise.reject(new Error('boom')) : Promise.resolve()
    )
    q.enqueue({ kbId: 'kb', docId: 'd-ok', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd-bad', kind: 'file' })
    await drain(q)
    expect(done.map((t) => t.docId)).toEqual(['d-ok', 'd-bad'])
  })

  it('退订后不再收到通知', async () => {
    const q = new IndexQueue()
    const done: string[] = []
    const unsub = q.onTaskDone((t) => done.push(t.docId))
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    await drain(q)
    unsub()
    q.enqueue({ kbId: 'kb', docId: 'd2', kind: 'file' })
    await drain(q)
    expect(done).toEqual(['d1'])
  })

  it('listener 抛错被吞掉，不影响其他监听者与队列流程', async () => {
    const q = new IndexQueue()
    const good: string[] = []
    q.onTaskDone(() => { throw new Error('listener broken') })
    q.onTaskDone((t) => good.push(t.docId))
    q.enqueue({ kbId: 'kb', docId: 'd1', kind: 'file' })
    q.enqueue({ kbId: 'kb', docId: 'd2', kind: 'file' })
    await drain(q)
    expect(good).toEqual(['d1', 'd2'])
  })
})

describe('IndexQueue — 单例导出', () => {
  it('indexQueue 是 IndexQueue 实例', () => {
    expect(indexQueue).toBeInstanceOf(IndexQueue)
  })
})
