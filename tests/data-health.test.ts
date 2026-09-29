// data-health 数据健康度聚合测试
//
// 覆盖 src/main/steward/data-health.ts 纯函数：
// - classifyDataEntry：根级 db 文件 / 一级子目录 / 其他归类
// - aggregateDataSizes：按桶聚合 + dataDirBytes 合计
// - groupDocStatus：五状态计数（缺省补 0、非法状态忽略）
// - topErrorDocs：错误筛选 / 创建时间倒序 / limit 截断 / kbName 注入
import { describe, it, expect, vi } from 'vitest'

// mock electron 依赖链（portable → electron；repo/backup 模块仅顶部 import）
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/app' } }))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({ kbDocRepo: { listAll: () => [] } }))
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { list: () => [] } }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: { get: () => undefined, set: () => {} } }))
vi.mock('../src/main/backup/backup-service', () => ({ loadWebDAVConfig: () => null }))

import {
  classifyDataEntry,
  aggregateDataSizes,
  groupDocStatus,
  topErrorDocs,
  type DataSizeEntry
} from '../src/main/steward/data-health'
import type { KbDocument } from '../src/shared/types'

describe('classifyDataEntry', () => {
  it('根级数据库文件（含 WAL）归类正确', () => {
    expect(classifyDataEntry('app.db')).toBe('db')
    expect(classifyDataEntry('app.db-wal')).toBe('db')
    expect(classifyDataEntry('vectors.db')).toBe('vectors')
    expect(classifyDataEntry('vectors.db-wal')).toBe('vectors')
  })
  it('一级子目录下全部归对应桶（含深层路径与反斜杠）', () => {
    expect(classifyDataEntry('attachments/a.png')).toBe('attachments')
    expect(classifyDataEntry('extensions\\mcp\\venv\\py.exe')).toBe('extensions')
    expect(classifyDataEntry('logs/boot/2026-09-29.log')).toBe('logs')
  })
  it('其余归 other（含根级散文件与未知子目录）', () => {
    expect(classifyDataEntry('config.json')).toBe('other')
    expect(classifyDataEntry('runtime/python/python.exe')).toBe('other')
  })
})

describe('aggregateDataSizes', () => {
  it('按桶聚合，dataDirBytes 为全量合计', () => {
    const entries: DataSizeEntry[] = [
      { rel: 'app.db', bytes: 1000 },
      { rel: 'app.db-wal', bytes: 200 },
      { rel: 'vectors.db', bytes: 500 },
      { rel: 'attachments/a.png', bytes: 300 },
      { rel: 'extensions/mcp/x', bytes: 400 },
      { rel: 'logs/a.log', bytes: 50 },
      { rel: 'config.json', bytes: 10 }
    ]
    const s = aggregateDataSizes(entries)
    expect(s.dbBytes).toBe(1200) // 含 WAL
    expect(s.vectorDbBytes).toBe(500)
    expect(s.attachmentsBytes).toBe(300)
    expect(s.extensionsBytes).toBe(400)
    expect(s.logsBytes).toBe(50)
    expect(s.otherBytes).toBe(10)
    expect(s.dataDirBytes).toBe(2460)
  })
  it('空目录全 0', () => {
    const s = aggregateDataSizes([])
    expect(s.dataDirBytes).toBe(0)
    expect(s.dbBytes).toBe(0)
    expect(s.otherBytes).toBe(0)
  })
})

describe('groupDocStatus', () => {
  it('五状态计数，缺省补 0', () => {
    const doc = (status: KbDocument['status']): KbDocument =>
      ({ id: status, kbId: 'k', source: '', sourceType: 'txt', title: '', chunkCount: 0, status, error: null, contentHash: null, enabled: true, createdAt: 0 })
    const out = groupDocStatus([doc('ready'), doc('ready'), doc('error')])
    expect(out).toEqual({ pending: 0, parsing: 0, indexing: 0, ready: 2, error: 1 })
  })
  it('空列表五状态全 0', () => {
    expect(groupDocStatus([])).toEqual({ pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 })
  })
})

describe('topErrorDocs', () => {
  const doc = (id: string, status: KbDocument['status'], createdAt: number, error: string | null = null): KbDocument =>
    ({ id, kbId: `kb-${id}`, source: 'src', sourceType: 'txt', title: `t-${id}`, chunkCount: 0, status, error, contentHash: null, enabled: true, createdAt })

  it('只取 error 文档，按创建时间倒序', () => {
    const docs = [doc('a', 'ready', 1), doc('b', 'error', 100), doc('c', 'error', 300), doc('d', 'pending', 200)]
    const out = topErrorDocs(docs, () => '库A')
    expect(out.map((d) => d.id)).toEqual(['c', 'b'])
    expect(out[0]!.kbName).toBe('库A')
  })
  it('limit 截断', () => {
    const docs = Array.from({ length: 15 }, (_, i) => doc(`d${i}`, 'error', i))
    expect(topErrorDocs(docs, () => 'k', 10)).toHaveLength(10)
    // 倒序 → 取的是最新的 10 条
    expect(topErrorDocs(docs, () => 'k', 10)[0]!.id).toBe('d14')
  })
  it('title 为空时回退 source，error 透传', () => {
    const d: KbDocument = { id: 'x', kbId: 'k1', source: 'fallback.md', sourceType: 'md', title: '', chunkCount: 0, status: 'error', error: '索引超时', contentHash: null, enabled: true, createdAt: 5 }
    const out = topErrorDocs([d], (kbId) => `名:${kbId}`)
    expect(out[0]!.title).toBe('fallback.md')
    expect(out[0]!.error).toBe('索引超时')
    expect(out[0]!.kbName).toBe('名:k1')
  })
})
