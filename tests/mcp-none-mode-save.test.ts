// MCP 保存路径上的 none 模式闸门（SEC-1 方案 B2）落地验证
//
// 用真实的 mcpServerRepo + 真 sqlite（:memory:）跑通 repo.save 全流程，
// 断言的是「拦什么、放什么」两条边界：
// - 拦：新增/改写 env 或 headers 的密钥值（此时字段密钥是源码公开的固定密钥，写下去等同明文）
// - 放：掩码往返下的改名/改命令、删键、历史明文迁移、轮换恢复——这些都不产生新密钥材料
// 拦下时必须一行未写（不能出现「拒了却留下半条记录」）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mocks = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'db',
  key: Buffer.alloc(32, 7),
  db: null as unknown as Database.Database
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    on: () => {},
    quit: () => {}
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getMode: () => mocks.mode,
    getFieldKey: () => mocks.key,
    hasKey: () => true
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => mocks.db }
}))

import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'
import { maskSecretMap } from '../src/shared/secret-mask'
import { decryptSecret } from '../src/main/crypto/field-encrypt'

const DDL = `
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'stdio',
    runtime TEXT DEFAULT 'binary',
    command TEXT,
    args TEXT,
    env TEXT,
    url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    python_packages TEXT,
    headers TEXT,
    trust_read_only INTEGER DEFAULT 0
  )`

function rowCount(): number {
  return (mocks.db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number }).n
}

/** 直读落盘的原始列（绕过 repo 的解密视图） */
function rawColumn(id: string, col: 'env' | 'headers'): string | null {
  const row = mocks.db.prepare(`SELECT ${col} AS v FROM mcp_servers WHERE id=?`).get(id) as
    | { v: string | null }
    | undefined
  return row?.v ?? null
}

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.mode = 'none'
})

describe('mcpServerRepo.save 的 none 模式闸门', () => {
  it('明文模式新增 env 密钥 → 拒绝，且一行未写', () => {
    expect(() =>
      mcpServerRepo.save({
        name: 'demo',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { API_KEY: 'sk-plain-mode' }
      })
    ).toThrow(/未设置主密码/)
    expect(rowCount()).toBe(0)
  })

  it('明文模式新增 http headers 密钥 → 拒绝', () => {
    expect(() =>
      mcpServerRepo.save({
        name: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer tk-1' }
      })
    ).toThrow(/headers：Authorization/)
    expect(rowCount()).toBe(0)
  })

  it('已设主密码（db 模式）同样内容正常写入，且落盘为密文', () => {
    mocks.mode = 'db'
    const rec = mcpServerRepo.save({
      name: 'demo',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: { API_KEY: 'sk-plain-mode' }
    })
    expect(rec.env.API_KEY).toBe('sk-plain-mode')
    expect(rawColumn(rec.id, 'env')).toMatch(/^v1:/)
  })

  it('明文模式改写已存在密钥的值 → 拒绝，原值不受影响', () => {
    mocks.mode = 'db'
    const rec = mcpServerRepo.save({
      name: 'demo',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: { API_KEY: 'sk-old' }
    })
    mocks.mode = 'none'
    expect(() =>
      mcpServerRepo.save({ id: rec.id, name: 'demo', transport: 'stdio', env: { API_KEY: 'sk-new' } })
    ).toThrow(/未设置主密码/)
    expect(mcpServerRepo.get(rec.id)?.env).toEqual({ API_KEY: 'sk-old' })
  })

  it('明文模式只改名（env 走掩码往返）→ 放行，密钥原样保留', () => {
    mocks.mode = 'db'
    const rec = mcpServerRepo.save({
      name: 'demo',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: { API_KEY: 'sk-keep-me' }
    })
    mocks.mode = 'none'
    const saved = mcpServerRepo.save({
      id: rec.id,
      name: 'demo-renamed',
      transport: 'stdio',
      command: 'npx',
      args: ['--new'],
      env: maskSecretMap({ API_KEY: 'sk-keep-me' })
    })
    expect(saved.name).toBe('demo-renamed')
    expect(saved.args).toEqual(['--new'])
    expect(saved.env).toEqual({ API_KEY: 'sk-keep-me' })
  })

  it('明文模式删除某个键 → 放行（没有新密钥材料）', () => {
    mocks.mode = 'db'
    const rec = mcpServerRepo.save({
      name: 'demo',
      transport: 'stdio',
      command: 'npx',
      env: { KEEP: 'v-keep', DROP: 'v-drop' }
    })
    mocks.mode = 'none'
    const saved = mcpServerRepo.save({
      id: rec.id,
      name: 'demo',
      transport: 'stdio',
      env: maskSecretMap({ KEEP: 'v-keep' })
    })
    expect(saved.env).toEqual({ KEEP: 'v-keep' })
  })

  it('明文模式把同一个值挪到新键名下 → 放行（值早已落盘，不是新密钥）', () => {
    mocks.mode = 'db'
    const rec = mcpServerRepo.save({
      name: 'demo',
      transport: 'stdio',
      command: 'npx',
      env: { OLD_NAME: 'sk-same' }
    })
    mocks.mode = 'none'
    const saved = mcpServerRepo.save({
      id: rec.id,
      name: 'demo',
      transport: 'stdio',
      env: { NEW_NAME: 'sk-same' }
    })
    expect(saved.env).toEqual({ NEW_NAME: 'sk-same' })
  })

  it('空值不触发闸门（新增一个空 env 键仍可保存）', () => {
    expect(
      mcpServerRepo.save({ name: 'demo', transport: 'stdio', command: 'npx', env: { PLACEHOLDER: '' } }).env
    ).toEqual({ PLACEHOLDER: '' })
  })

  it('拒绝文案不含密钥值', () => {
    let message = ''
    try {
      mcpServerRepo.save({ name: 'demo', transport: 'stdio', env: { API_KEY: 'sk-leak-check' } })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('API_KEY')
    expect(message).not.toContain('sk-leak-check')
  })
})

describe('不受闸门影响的既有通路', () => {
  it('明文模式仍能迁移历史明文 env（migratePlaintextSecrets 不经 save）', () => {
    mocks.db
      .prepare(
        `INSERT INTO mcp_servers (id,name,transport,command,args,env,url,enabled,created_at)
         VALUES ('legacy','legacy','stdio','npx','[]','{"API_KEY":"sk-historical"}',NULL,1,0)`
      )
      .run()
    mcpServerRepo.migratePlaintextSecrets()
    const stored = rawColumn('legacy', 'env') ?? ''
    expect(stored.startsWith('v1:')).toBe(true)
    expect(JSON.parse(decryptSecret(stored))).toEqual({ API_KEY: 'sk-historical' })
  })

  it('明文模式仍能恢复轮换快照（restoreAllSecrets 不经 save）', () => {
    const rec = mcpServerRepo.save({ name: 'demo', transport: 'stdio', command: 'npx', env: {} })
    expect(() =>
      mcpServerRepo.restoreAllSecrets({ [rec.id]: { env: { API_KEY: 'sk-rotated-back' }, headers: {} } })
    ).not.toThrow()
    expect(mcpServerRepo.get(rec.id)?.env).toEqual({ API_KEY: 'sk-rotated-back' })
  })
})
