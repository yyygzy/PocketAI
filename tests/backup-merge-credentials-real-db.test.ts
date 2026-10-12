// 真库合并：跨机搬运时**凭据列保留本机值**（B9 / SEC-30）
//
// 为什么这条必须真库：合并写的是"删本地整表 + 按云库行重插"，凭据列要不要沿用本机
// 那份，取决于按 id 快照的时机与列过滤——桩掉 DB 就只能验 SQL 字符串，验不到"哪一行的
// 哪一列最后是什么"。而这条规则一旦写错，症状是用户合并完 Key 凭空失效（SEC-30 的原始事故）。
//
// 云库不是手搓的：先从**跑完真迁移的本地库**里取 providers/mcp_servers 的 DDL 再建表，
// 免得本地加了列而用例还在用三年前的结构假绿。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-merge-creds'
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
import { overwriteConfigTables, overwriteTable } from '../src/main/backup/merge-service'

/** 本机（目标机）密文与云端（源机密文）——用可辨识的假串，测试只关心"谁留下了" */
const LOCAL_KEY = 'local-cipher-AAAA'
const CLOUD_KEY = 'cloud-cipher-BBBB'
const LOCAL_ENV = '{"API_KEY":"local-ccc"}'
const CLOUD_ENV = '{"API_KEY":"cloud-ddd"}'

let cloudDb: Database.Database

function ddlOf(table: string): string {
  const row = dbService
    .getHandle()
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined
  expect(row, `本地库里没有 ${table} 表`).toBeDefined()
  return row!.sql
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  const local = dbService.getHandle()
  local
    .prepare(
      `INSERT INTO providers (id, type, name, base_url, api_key_encrypted, created_at)
       VALUES ('p1','openai-compatible','本机改过名','https://a',?,1)`
    )
    .run(LOCAL_KEY)
  local
    .prepare(
      `INSERT INTO mcp_servers (id, name, transport, command, env, created_at)
       VALUES ('m1','本机 MCP','stdio','node',?,1)`
    )
    .run(LOCAL_ENV)

  cloudDb = new Database(':memory:')
  cloudDb.exec(ddlOf('providers'))
  cloudDb.exec(ddlOf('mcp_servers'))
  cloudDb
    .prepare(
      `INSERT INTO providers (id, type, name, base_url, api_key_encrypted, created_at)
       VALUES ('p1','openai-compatible','备份里的名字','https://b',?,0)`
    )
    .run(CLOUD_KEY)
  cloudDb
    .prepare(
      `INSERT INTO providers (id, type, name, base_url, api_key_encrypted, created_at)
       VALUES ('p2','ollama','只在云端有','http://127.0.0.1:11434',?,2)`
    )
    .run(CLOUD_KEY)
  cloudDb
    .prepare(
      `INSERT INTO mcp_servers (id, name, transport, command, env, created_at)
       VALUES ('m1','备份里的 MCP','stdio','python',?,1)`
    )
    .run(CLOUD_ENV)
})

afterAll(() => {
  try {
    cloudDb.close()
  } catch {
    /* 已关则忽略 */
  }
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

function providerRow(id: string): { name: string; api_key_encrypted: string | null } {
  return dbService
    .getHandle()
    .prepare('SELECT name, api_key_encrypted FROM providers WHERE id = ?')
    .get(id) as { name: string; api_key_encrypted: string | null }
}

describe('跨机合并的凭据列保留（B9）', () => {
  it('本机已有的行：非凭据列被云端覆盖，凭据列仍是本机那份', () => {
    const parts = overwriteConfigTables(dbService.getHandle(), cloudDb)
    const p1 = providerRow('p1')
    // 名字/URL 取云端（这就是"云端覆盖配置表"的语义）
    expect(p1.name).toBe('备份里的名字')
    // Key 必须是本机那份——否则合并完这台机器直接连不上
    expect(p1.api_key_encrypted).toBe(LOCAL_KEY)
    // mcp_servers 的 env 同一条规则
    const m1 = dbService.getHandle().prepare('SELECT name, env FROM mcp_servers WHERE id=?').get('m1') as {
      name: string
      env: string | null
    }
    expect(m1.name).toBe('备份里的 MCP')
    expect(m1.env).toBe(LOCAL_ENV)
    // 汇总文案要如实告诉用户"凭据列没搬"
    expect(parts.find((s) => s.startsWith('providers:'))).toContain('凭据列保留本机')
    expect(parts.find((s) => s.startsWith('mcp_servers:'))).toContain('凭据列保留本机')
  })

  it('只在云端存在的行：没有本机值可留，落云端密文（合并不负责变出可用 Key）', () => {
    const p2 = providerRow('p2')
    expect(p2.name).toBe('只在云端有')
    expect(p2.api_key_encrypted).toBe(CLOUD_KEY)
  })

  it('反向对照：不给 preserveColumns 时，同一行的 Key 确实会被云端覆盖 ⇒ 上一条不是恒真', () => {
    overwriteTable(dbService.getHandle(), cloudDb, 'providers')
    expect(providerRow('p1').api_key_encrypted).toBe(CLOUD_KEY)
  })

  it('skills/assistants 这类无凭据列的表走同一条通路且不带"凭据"字样', () => {
    // 云库里没建这两张表 ⇒ overwriteTable 直接返回 0，不报错也不进 summary
    const parts = overwriteConfigTables(dbService.getHandle(), cloudDb)
    expect(parts.some((s) => s.startsWith('skills:'))).toBe(false)
    expect(parts.some((s) => s.startsWith('assistants:'))).toBe(false)
  })
})
