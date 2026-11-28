// PERF-08：静态 SQL 的 prepared statement 缓存。
//
// better-sqlite3 的 statement 绑定在**具体 db handle** 上：整库恢复/重新打开会换 handle，
// 跨库复用旧 statement 会打到已关闭的连接上。因此 key 是 `WeakMap<db, Map<sql, statement>>`，
// handle 被 GC 后整张缓存随之消失，无需手动清理；close() 后重建 handle 自然拿到新 statement。
// 只缓存 prepare 的结果，**不缓存绑定参数**：调用方每次都显式传参，避免上次绑定残留。
import type Database from 'better-sqlite3-multiple-ciphers'

type SqlDatabase = Database.Database
/** 显式 unknown[] 绑定参数：调用点每次都传参，不复用上一次的绑定状态 */
type SqlStatement = Database.Statement<unknown[], unknown>

const caches = new WeakMap<SqlDatabase, Map<string, SqlStatement>>()

/** 按 (db handle, SQL 文本) 取已编译 statement；首次调用时编译。动态值一律走参数绑定。 */
export function cachedPrepare(db: SqlDatabase, sql: string): SqlStatement {
  let bySql = caches.get(db)
  if (!bySql) {
    bySql = new Map<string, SqlStatement>()
    caches.set(db, bySql)
  }
  let stmt = bySql.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    bySql.set(sql, stmt)
  }
  return stmt
}

/** 仅供测试/诊断：清空指定 handle 的缓存（不关闭 statement，sqlite 侧由 db 生命周期管理）。 */
export function clearStatementCache(db?: SqlDatabase): void {
  if (db) caches.delete(db)
}
