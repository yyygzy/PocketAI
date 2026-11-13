// health.cleanup 真库：向量清理语义
//
// 病根是「删 chunk 不删向量行」：chunk 一没了，deleteByDoc 的 JOIN 就找不到映射，
// 于是 kb_vec_map / kb_vec_<dim> 里永久留下孤儿向量，只有设置页那颗按钮能再清掉。
// 这里用真 sqlite-vec（不是桩）钉三件事：
// 1. 管家清理先清向量再删 chunk，孤儿 chunk 的向量行与映射都不残留；
// 2. chunk 早已不存在的孤儿映射也一并清掉；
// 3. 健康文档的向量不受影响。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { load as loadVec } from 'sqlite-vec'

const H = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../src/main/portable', () => ({
  DB_PATH: 'C:\\fake\\health-cleanup.db',
  DATA_DIR: 'C:\\fake'
}))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => H.db }
}))

import { HealthService } from '../src/main/health/health'

const db = () => H.db as Database.Database

/** 同时写入 vec0 行与 kb_vec_map 映射（chunk 行可不存在，用于造孤儿映射） */
function addVector(chunkId: string): void {
  const info = db()
    .prepare('INSERT INTO kb_vec_3(embedding) VALUES (?)')
    .run(Buffer.from(new Float32Array([1, 2, 3]).buffer))
  db()
    .prepare('INSERT INTO kb_vec_map(chunk_id, vec_rowid, dim) VALUES (?, ?, 3)')
    .run(chunkId, Number(info.lastInsertRowid))
}

function count(table: string): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

beforeAll(() => {
  const conn = new Database(':memory:')
  loadVec(conn)
  H.db = conn
  conn.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE kb_documents (id TEXT PRIMARY KEY);
    CREATE TABLE kb_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL);
    CREATE TABLE kb_vec_map (chunk_id TEXT PRIMARY KEY, vec_rowid INTEGER NOT NULL, dim INTEGER NOT NULL);
    CREATE VIRTUAL TABLE kb_vec_3 USING vec0(embedding float[3]);
  `)

  // 正常数据：不能被清理误伤
  conn.prepare("INSERT INTO conversations (id) VALUES ('conv-ok')").run()
  conn.prepare("INSERT INTO messages (id, conversation_id) VALUES ('msg-ok','conv-ok')").run()
  conn.prepare("INSERT INTO kb_documents (id) VALUES ('doc-ok')").run()
  conn.prepare("INSERT INTO kb_chunks (id, doc_id) VALUES ('chunk-ok','doc-ok')").run()
  addVector('chunk-ok')

  // 孤儿消息：会话已不存在
  conn.prepare("INSERT INTO messages (id, conversation_id) VALUES ('msg-orphan','conv-gone')").run()

  // 孤儿 chunk（所属文档已不存在）及其向量
  conn.prepare("INSERT INTO kb_chunks (id, doc_id) VALUES ('chunk-orphan','doc-gone')").run()
  addVector('chunk-orphan')

  // 只有映射、chunk 早已不存在的孤儿向量
  addVector('chunk-missing')
})

afterAll(() => {
  try {
    db().close()
  } catch {
    /* 已关则忽略 */
  }
})

describe('HealthService.cleanup 向量清理语义', () => {
  it('先清向量再删 chunk：孤儿 chunk 与孤儿映射的向量都不残留，正常数据不动', () => {
    const r = new HealthService().cleanup()

    expect(r.removedOrphanMessages).toBe(1)
    expect(r.removedOrphanChunks).toBe(1)

    // 修前：chunk 删了，但 kb_vec_map 仍留 3 行、kb_vec_3 仍留 3 行（两条孤儿向量只能去设置页清）
    expect(count('kb_vec_map')).toBe(1)
    expect(count('kb_vec_3')).toBe(1)
    expect(count('kb_chunks')).toBe(1)

    const left = db().prepare('SELECT chunk_id FROM kb_vec_map').all() as Array<{ chunk_id: string }>
    expect(left).toEqual([{ chunk_id: 'chunk-ok' }])
  })
})
