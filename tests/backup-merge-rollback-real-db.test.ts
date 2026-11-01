// @vitest-environment node
// 云端合并库内写入的整体回滚测试（缺陷：executeMerge 第 1 步行级合并与第 2 步配置表覆盖
// 各自独立事务，第 2 步中途失败时第 1 步已提交 ⇒ 「报失败但已合并一半」的跨表不一致）。
//
// 钉住的行为：runDbMergeTx 把两步包进一个外层事务（内部单表事务自动降级为 savepoint），
// 第 2 步抛错 ⇒ 第 1 步已合并的行一并回滚。
//
// 失败注入手法：云端 assistants 表故意缺 NOT NULL 的 name 列 ⇒ overwriteTable 的
// INSERT 撞约束抛错；断言前面已合并的 conversations 行随之消失。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-merge-rollback'
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
  cloud.exec(ddlOf('conversations'))
  return cloud
}

function seedCloudConversation(cloud: Database.Database): void {
  cloud
    .prepare(
      "INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('c-merge','云会话','done',1,1)"
    )
    .run()
}

function localHasConversation(id: string): boolean {
  return !!dbService.getHandle().prepare('SELECT id FROM conversations WHERE id=?').get(id)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('runDbMergeTx — 库内合并整体事务', () => {
  it('第 2 步配置覆盖抛错 ⇒ 第 1 步行级合并一并回滚，本地无半合并残留', () => {
    const cloud = newCloudDb()
    seedCloudConversation(cloud)
    // assistants 缺 NOT NULL 的 name 列 ⇒ overwriteTable 的 INSERT 必然撞约束
    cloud.exec('CREATE TABLE assistants (id TEXT PRIMARY KEY, description TEXT)')
    cloud.prepare("INSERT INTO assistants (id, description) VALUES ('a1','x')").run()
    try {
      expect(() => runDbMergeTx(dbService.getHandle(), cloud, 'cloud')).toThrow()
      expect(localHasConversation('c-merge'), '第 1 步合并的会话必须随外层事务回滚').toBe(false)
    } finally {
      cloud.close()
    }
  })

  it('两步都正常 ⇒ 提交成功，摘要含行级合并与配置覆盖', () => {
    const cloud = newCloudDb()
    seedCloudConversation(cloud)
    cloud.exec("CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)")
    cloud.prepare("INSERT INTO assistants (id, name, created_at) VALUES ('a-ok','云助手',1)").run()
    try {
      const parts = runDbMergeTx(dbService.getHandle(), cloud, 'cloud')
      expect(localHasConversation('c-merge')).toBe(true)
      expect(parts.some((p) => p.startsWith('conversations:'))).toBe(true)
      expect(parts.some((p) => p.startsWith('assistants:'))).toBe(true)
    } finally {
      cloud.close()
      dbService.getHandle().prepare("DELETE FROM conversations WHERE id='c-merge'").run()
      dbService.getHandle().prepare("DELETE FROM assistants WHERE id='a-ok'").run()
    }
  })
})
