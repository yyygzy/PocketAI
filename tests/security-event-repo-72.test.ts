// security_events 审计表（SEC-1 降级留痕）的落库与读取
//
// 用真 sqlite(:memory:) 跑真 SQL：断言迁移 DDL 能用、时间倒序、detail 往返，
// 以及「写失败不抛」——审计不可用不该把人卡在「想关加密关不掉」的状态里。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mocks = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  failInsert: false
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => mocks.db }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  log: { error: () => {} }
}))

import { securityEventRepo } from '../src/main/db/repositories/security-event.repo'

/** 与 database.ts 迁移 v72 同一份 DDL */
const DDL = `
  CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
`

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.failInsert = false
})

describe('securityEventRepo', () => {
  it('落库后可按新→旧读回，detail 原样往返', () => {
    expect(
      securityEventRepo.append({
        kind: 'encryption_disabled',
        message: '禁用加密：5 项已加密字段凭据改用源码公开常量派生的固定密钥混淆',
        detail: { kv: 2, providers: 1, mcp: 1, webdav: 1, total: 5 }
      })
    ).toBe(true)

    const [row] = securityEventRepo.listRecent()
    expect(row!.kind).toBe('encryption_disabled')
    expect(row!.message).toContain('公开常量派生的固定密钥混淆')
    expect(row!.detail).toEqual({ kv: 2, providers: 1, mcp: 1, webdav: 1, total: 5 })
    expect(row!.createdAt).toBeGreaterThan(0)
  })

  it('多条时最新的在前（同毫秒也能稳定区分）', () => {
    securityEventRepo.append({ kind: 'encryption_disabled', message: '第一条' })
    securityEventRepo.append({ kind: 'encryption_enabled', message: '第二条' })
    expect(securityEventRepo.listRecent().map((r) => r.message)).toEqual(['第二条', '第一条'])
  })

  it('detail 缺省存 NULL，读回为 null', () => {
    securityEventRepo.append({ kind: 'encryption_disabled', message: '无 detail' })
    expect(securityEventRepo.listRecent()[0]!.detail).toBeNull()
  })

  it('写入失败只记日志、返回 false，不抛', () => {
    mocks.db.exec('DROP TABLE security_events')
    expect(() =>
      securityEventRepo.append({ kind: 'encryption_disabled', message: '表没了' })
    ).not.toThrow()
    expect(securityEventRepo.append({ kind: 'encryption_disabled', message: '表没了' })).toBe(false)
  })
})
