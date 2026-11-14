// @vitest-environment node
// 安全审计表跨机合并口径（security_events 只能追加，不能覆盖本机记录）。
//
// 钉住的行为：runDbMergeTx 对 APPEND_ONLY_TABLES 只做 INSERT OR IGNORE，
//  · 本机已有的同 id 行保持本机版本（哪怕云端那份内容不同、strategy='cloud'）；
//  · 云端独有的记录正常补进来；
//  · 重复合并幂等，不会重复插入。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-merge-security-events'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  ATTACHMENTS_DIR: P.dir + '/attachments'
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { runDbMergeTx } from '../src/main/backup/merge-service'

function ddlOf(table: string): string {
  const row = dbService
    .getHandle()
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined
  expect(row, `本地库里没有 ${table} 表`).toBeDefined()
  return row!.sql
}

function newCloudDb(): Database.Database {
  const cloud = new Database(':memory:')
  cloud.exec(ddlOf('security_events'))
  return cloud
}

function insertEvent(db: Database.Database, id: string, message: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO security_events (id, kind, message, detail, created_at) VALUES (?, 'encryption_disabled', ?, NULL, ?)`
  ).run(id, message, createdAt)
}

function localEvent(id: string): { message: string } | undefined {
  return dbService
    .getHandle()
    .prepare('SELECT message FROM security_events WHERE id=?')
    .get(id) as { message: string } | undefined
}

function localCount(): number {
  const row = dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM security_events').get() as { n: number }
  return row.n
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

beforeEach(() => {
  dbService.getHandle().prepare('DELETE FROM security_events').run()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('runDbMergeTx — security_events 仅追加', () => {
  it('恢复后本机与外部审计记录都在，且本机同 id 行不被云端覆盖', () => {
    const local = dbService.getHandle()
    insertEvent(local, 'evt-local', '本机：禁用加密', 100)
    insertEvent(local, 'evt-shared', '本机：启用加密', 200)

    const cloud = newCloudDb()
    insertEvent(cloud, 'evt-shared', '云端旧版本：启用加密（不该生效）', 150)
    insertEvent(cloud, 'evt-remote', '另一台机器：禁用加密', 300)
    try {
      // 故意用 'cloud' 策略：普通行级表会被覆盖，审计表必须例外
      runDbMergeTx(local, cloud, 'cloud')
    } finally {
      cloud.close()
    }

    expect(localEvent('evt-local')?.message).toBe('本机：禁用加密')
    expect(localEvent('evt-remote')?.message).toBe('另一台机器：禁用加密')
    expect(localEvent('evt-shared')?.message, '本机既有审计记录不能被旧备份改写').toBe('本机：启用加密')
    expect(localCount()).toBe(3)
  })

  it('重复合并幂等：已有 id 不重复插入，摘要只在有新增时出现', () => {
    insertEvent(dbService.getHandle(), 'evt-a', '本机：禁用加密', 100)

    const cloud = newCloudDb()
    insertEvent(cloud, 'evt-a', '本机：禁用加密', 100)
    insertEvent(cloud, 'evt-b', '另一台机器：启用加密', 200)
    try {
      const first = runDbMergeTx(dbService.getHandle(), cloud, 'newer')
      expect(first).toContain('security_events: +1(仅追加)')
      expect(localCount()).toBe(2)

      const second = runDbMergeTx(dbService.getHandle(), cloud, 'newer')
      expect(second.some((p) => p.startsWith('security_events:'))).toBe(false)
      expect(localCount(), '第二次合并不应重复插入').toBe(2)
    } finally {
      cloud.close()
    }
  })

  it('云端没有该表（旧备份）时静默跳过，不影响其它表合并', () => {
    const cloud = new Database(':memory:')
    try {
      const parts = runDbMergeTx(dbService.getHandle(), cloud, 'cloud')
      expect(parts.some((p) => p.startsWith('security_events:'))).toBe(false)
    } finally {
      cloud.close()
    }
  })
})
