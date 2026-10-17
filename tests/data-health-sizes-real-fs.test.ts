// 数据健康的"体积"两棵探针（V4-Iter-177）——真临时目录、真递归，不碰真库
//
// 这一批要证的是**接缝**，不只是纯函数：
//  · `collectUserDataEntries()` 必须**一次都不 stat** 那两棵 Chromium 档案树（合计才算得清、也不卡主进程）；
//  · 档案树那格**同进程只数一遍**，只有 `refresh` 才重算（这是"面板打开不再冻 0.6 秒"的全部机制）；
//  · 判据取相对路径**首段** ⇒ 嵌套里正好叫 `userdata` 的业务目录不能被误当档案树（反向对照）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const root = base + sep + 'pocketai-sizes177'
  process.env.POCKETAI_APP_ROOT = root
  return { root, data: root + sep + 'data' }
})
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => P.root, getPath: () => P.root } }))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({ kbDocRepo: { listAll: () => [] } }))
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { list: () => [] } }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: { get: () => undefined, set: () => {} } }))
vi.mock('../src/main/db/repositories/agent-trace.repo', () => ({
  agentTraceRepo: { countForHealth: () => ({ rows: 128, maxRowsInOneConversation: 65 }) }
}))
vi.mock('../src/main/backup/backup-service', () => ({ loadWebDAVConfig: () => null }))
vi.mock('../src/main/knowledge/kb-health', () => ({
  getKbIntegrityReport: () => ({ orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] }),
  getVectorIndexStats: () => ({ count: 0, dims: [] })
}))

import {
  aggregateDataSizes,
  collectUserDataEntries,
  getBrowserCacheStats,
  getDataHealthReport
} from '../src/main/steward/data-health'

const w = (rel: string, bytes: number): void => {
  const full = path.join(P.data, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, Buffer.alloc(bytes))
}

beforeAll(() => {
  fs.rmSync(P.root, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  // 用户数据：合计应该只算这些
  w('app.db', 5)
  w('app.db-wal', 5)
  w('attachments/a.png', 10)
  w('logs/x.log', 20)
  w('config.json', 7)
  // 业务目录里恰好有个子目录叫 userdata —— 不该被当档案树
  w('attachments/userdata/notcache', 1)
  // 浏览器档案树（Electron 的 userData / sessionData）
  w('userdata/Cache/one', 100)
  w('userdata/Code Cache/two', 200)
  w('session/Session/three', 1000)
})

afterAll(() => {
  fs.rmSync(P.root, { recursive: true, force: true })
})

describe('collectUserDataEntries · 跳过浏览器档案树', () => {
  it('① 明细里没有 userdata/ 与 session/，但含嵌套的 attachments/userdata/', () => {
    const rels = collectUserDataEntries().map((e) => e.rel.replaceAll('\\', '/')).sort()
    expect(rels).toEqual([
      'app.db',
      'app.db-wal',
      'attachments/a.png',
      'attachments/userdata/notcache',
      'config.json',
      'logs/x.log'
    ])
  })

  it('② 聚合后合计 48 字节（5+5+10+1+20+7），且 cache 两个字段是 0（明细里根本没有档案树）', () => {
    const s = aggregateDataSizes(collectUserDataEntries())
    expect(s.userDataBytes).toBe(48)
    expect(s.dbBytes).toBe(10)
    expect(s.attachmentsBytes).toBe(11)
    expect(s.logsBytes).toBe(20)
    expect(s.otherBytes).toBe(7)
    expect(s.browserCacheBytes).toBe(0)
    expect(s.browserCacheFiles).toBe(0)
  })
})

describe('getBrowserCacheStats · 按进程缓存，刷新才重算', () => {
  it('③ 第一次现走：档案树 1,300 字节 / 3 个文件', () => {
    expect(getBrowserCacheStats(false)).toEqual({ bytes: 1300, files: 3 })
  })

  it('④ 又写了一个文件，不刷新 ⇒ 仍是旧数（这就是"面板重复打开不再递归"的机制）', () => {
    w('userdata/Cache/four', 7)
    expect(getBrowserCacheStats(false)).toEqual({ bytes: 1300, files: 3 })
  })

  it('⑤ 报告带 refresh ⇒ 那一格现算（1,307 字节 / 4 个文件），合计仍是 48', () => {
    const r = getDataHealthReport({ refresh: true })
    expect(r.sizes.browserCacheBytes).toBe(1307)
    expect(r.sizes.browserCacheFiles).toBe(4)
    expect(r.sizes.userDataBytes).toBe(48)
    expect(r.sizes.userDataBytes + r.sizes.browserCacheBytes).toBe(1355)
    expect(r.traces).toEqual({ rows: 128, maxRowsInOneConversation: 65 })
  })

  it('⑥ 报告不带 refresh ⇒ 用同一份缓存（又写一个文件也不动，证明它不是每次现数）', () => {
    w('session/Cache/five', 11)
    const r = getDataHealthReport({})
    expect(r.sizes.browserCacheBytes).toBe(1307)
    expect(r.sizes.browserCacheFiles).toBe(4)
  })

  it('⑦ 直接按刷新 ⇒ 把第五个文件也数进去（1,318 / 5）', () => {
    expect(getBrowserCacheStats(true)).toEqual({ bytes: 1318, files: 5 })
  })
})
