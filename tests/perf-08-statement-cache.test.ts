// PERF-08：prepared statement 缓存验收 + 基准对比
// - 同一 handle + 同一 SQL 只 prepare 一次；不同 handle 不共用 statement
// - 缓存不保留绑定参数（每次显式传参）
// - 基准：UPDATE 热路径 3000 次，未缓存逐次 prepare vs 缓存复用
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { cachedPrepare } from '../src/main/db/statement-cache'

const SQL_GET = 'SELECT n FROM bench WHERE id=?'
const SQL_UPDATE = 'UPDATE bench SET n=n+1 WHERE id=?'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE bench (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)')
  db.exec('INSERT INTO bench (id, n) VALUES (1, 0), (2, 100)')
  return db
}

describe('PERF-08 · cachedPrepare', () => {
  it('同 handle 同 SQL 复用同一 statement；不同 handle 各自独立', () => {
    const db1 = makeDb()
    const db2 = makeDb()
    const a = cachedPrepare(db1, SQL_GET)
    expect(cachedPrepare(db1, SQL_GET)).toBe(a)
    const b = cachedPrepare(db2, SQL_GET)
    expect(b).not.toBe(a)
    expect(b.database).toBe(db2)
    db1.close()
    db2.close()
  })

  it('不复用绑定状态：连续两次 get 使用各自参数', () => {
    const db = makeDb()
    const stmt = cachedPrepare(db, SQL_GET)
    expect(stmt.get(1)).toEqual({ n: 0 })
    expect(stmt.get(2)).toEqual({ n: 100 })
    expect(stmt.get(1)).toEqual({ n: 0 })
    db.close()
  })

  it('基准：3000 次 UPDATE —— 逐次 prepare vs 缓存复用', () => {
    const db = makeDb()
    const iterations = 3000
    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) db.prepare(SQL_UPDATE).run(1)
    const uncachedMs = performance.now() - t0

    db.prepare('UPDATE bench SET n=0 WHERE id=1').run()
    const stmt = cachedPrepare(db, SQL_UPDATE)
    const selectStmt = cachedPrepare(db, SQL_GET)
    const t1 = performance.now()
    for (let i = 0; i < iterations; i++) stmt.run(1)
    const cachedMs = performance.now() - t1

    console.log(
      `[PERF-08 benchmark] ${iterations}x UPDATE: 逐次 prepare=${uncachedMs.toFixed(1)}ms, 缓存复用=${cachedMs.toFixed(1)}ms, 加速=${(uncachedMs / Math.max(cachedMs, 0.01)).toFixed(1)}x`
    )
    expect(selectStmt.get(1)).toEqual({ n: iterations })
    expect(cachedMs).toBeLessThan(uncachedMs)
    db.close()
  })
})
