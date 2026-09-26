// sqlite-vec 向量索引集成测试：真实 better-sqlite3 内存库 + 加载扩展
import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { load as loadVec } from 'sqlite-vec'

// dbService 是单例，mock 掉让它返回我们的内存库
const realDb = new Database(':memory:')
loadVec(realDb)
realDb.exec(`
  CREATE TABLE kb_chunks (id TEXT PRIMARY KEY, doc_id TEXT, kb_id TEXT, sequence INTEGER, content TEXT, embedding BLOB, created_at INTEGER);
`)

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => realDb,
    isVecEnabled: () => true
  }
}))

import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'

describe('kb-vec 向量索引（sqlite-vec）', () => {
  beforeAll(() => {
    // 插入测试分块（触发 vec 索引写入）
    kbChunkRepo.insertMany([
      { docId: 'd1', kbId: 'kb1', sequence: 0, content: '苹果是一种水果', embedding: new Float32Array([1, 0, 0]) },
      { docId: 'd1', kbId: 'kb1', sequence: 1, content: '香蕉是黄色的', embedding: new Float32Array([0, 1, 0]) },
      { docId: 'd2', kbId: 'kb1', sequence: 0, content: '汽车有四个轮子', embedding: new Float32Array([0, 0, 1]) }
    ])
  })

  it('vec 索引写入后可检索，最相似的排第一', () => {
    // 查询接近 [1,0,0]（苹果）
    const results = kbChunkRepo.knnSearch(new Float32Array([0.9, 0.1, 0]), ['kb1'], 3)
    expect(results.length).toBe(3)
    expect(results[0]?.content).toBe('苹果是一种水果')
    expect(results[0]?.score).toBeGreaterThan(results[1]!.score)
  })

  it('检索结果带 chunkId/docId/content', () => {
    const results = kbChunkRepo.knnSearch(new Float32Array([0, 1, 0]), ['kb1'], 1)
    expect(results[0]).toMatchObject({
      docId: 'd1',
      content: '香蕉是黄色的'
    })
    expect(results[0]?.chunkId).toBeTruthy()
    expect(typeof results[0]?.score).toBe('number')
  })

  it('kbIds 过滤：不在指定 KB 的结果不返回', () => {
    const results = kbChunkRepo.knnSearch(new Float32Array([0, 0, 1]), ['kb-nonexist'], 3)
    expect(results).toHaveLength(0)
  })

  it('deleteByDoc 后该文档向量从索引移除', () => {
    kbChunkRepo.deleteByDoc('d2')
    const results = kbChunkRepo.knnSearch(new Float32Array([0, 0, 1]), ['kb1'], 3)
    // 汽车那条（[0,0,1]）已被删，只剩 2 条
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.content === '汽车有四个轮子')).toBeUndefined()
  })
})
