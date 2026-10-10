// WebDAV 口令出 IPC 掩码（SEC-35）
//
// 与 SEC-7/SEC-11 同口径：凭据明文不跨进程。此前 BACKUP_WEBDAV_LOAD_CONFIG 直接把
// 解密后的口令交给渲染层（渲染端注入一次即可拿走保护整份备份包的密钥）。
// 本文件不复制被测逻辑：只 mock 最底层的配置存储与字段加解密，
// 让 handlers/backup.ts + backup-service 的掩码/回填/闸门**真实代码**跑完整个来回，
// 断言的是「存进去还能不能解出原口令」这类终态，而不是函数被调了几次。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC, type WebDAVConfig } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  mode: 'none' as 'none' | 'db',
  cfgStore: new Map<string, string>(),
  testCreds: [] as Array<{ password: string; url: string }>
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => mocks.handlers.set(ch, fn) },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => {}
  },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getMode: () => mocks.mode, getFieldKey: () => Buffer.alloc(32, 1) }
}))

// 配置存储：app_config 的一张内存表（key → value）
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => mocks.cfgStore.get(k) ?? null,
    set: (k: string, v: string) => {
      mocks.cfgStore.set(k, v)
    },
    delete: (k: string) => {
      mocks.cfgStore.delete(k)
    }
  },
  clearAppConfigCache: () => {}
}))

// 字段加解密：可逆的假实现（v1:base64），够用来验证「存进去的是密文、解出来的是原口令」
vi.mock('../src/main/crypto/field-encrypt', () => ({
  isCipherText: (s: string) => s.startsWith('v1:'),
  encryptApiKeys: (arr: string[]) => (arr.length === 0 ? '' : 'v1:' + Buffer.from(JSON.stringify(arr)).toString('base64')),
  decryptApiKeys: (s: string) => {
    if (!s || !s.startsWith('v1:')) return []
    try {
      return JSON.parse(Buffer.from(s.slice(3), 'base64').toString('utf8')) as string[]
    } catch {
      return []
    }
  },
  encryptSecret: (s: string) => 'v1:' + Buffer.from(s).toString('base64'),
  decryptSecret: (s: string) => (s.startsWith('v1:') ? Buffer.from(s.slice(3), 'base64').toString('utf8') : s)
}))

vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async (creds: { password: string; url: string }) => {
    mocks.testCreds.push({ password: creds.password, url: creds.url })
    return { ok: true }
  },
  uploadBuffer: async () => ({}),
  downloadFile: async () => Buffer.alloc(0),
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async () => false,
  uploadRemoteBuffer: async () => ({}),
  downloadRemoteFile: async () => Buffer.alloc(0)
}))

// 以下三个只为让 backup-service 在 node 环境能加载（本用例不触发其逻辑）
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '', DATA_DIR: process.cwd() }))
vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => ({ enabled: false, intervalHours: 24, retentionCount: 7 }),
  setBackupSchedule: () => ({}),
  noteManualBackup: () => {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))

import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'

const PWD = 'webdav-pwd-9f3c'
const URL = 'https://dav.example.com/dav'

async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return (await handler({}, ...args)) as T
}

function cfg(password: string, directory = 'bk'): WebDAVConfig {
  return { url: URL, username: 'u', passwordCipher: password, directory }
}

/** 配置存储里那串原始 JSON（未经解密，直接看落盘形态） */
function storedRaw(): Record<string, unknown> {
  return JSON.parse(mocks.cfgStore.get('webdav_config') ?? '{}') as Record<string, unknown>
}

/** 直接解开盘的假密文，拿到「下次鉴权会用到的真实口令」 */
function storedPassword(): string {
  const raw = String(storedRaw().passwordCipher ?? '')
  if (!raw.startsWith('v1:')) return raw
  return (JSON.parse(Buffer.from(raw.slice(3), 'base64').toString('utf8')) as string[])[0] ?? ''
}

beforeEach(() => {
  mocks.mode = 'none'
  mocks.cfgStore = new Map()
  mocks.testCreds = []
  registerBackupHandlers()
})

describe('LOAD_CONFIG 出 IPC 只给掩码', () => {
  it('已存口令时返回 ••••+末 4 位，不含明文', async () => {
    mocks.mode = 'db'
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(PWD))
    const out = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(out.passwordCipher).toBe('••••' + PWD.slice(-4))
    expect(out.passwordCipher).not.toContain(PWD)
    expect(out.url).toBe(URL)
  })

  it('落盘的是密文，解密后仍是原口令（掩码只发生在出口）', async () => {
    mocks.mode = 'db'
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(PWD))
    expect(String(storedRaw().passwordCipher).startsWith('v1:')).toBe(true)
    expect(storedPassword()).toBe(PWD)
    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    // 掩码视图回传一次（用户只改目录），落盘值不得被写成占位符
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, { ...cfg(loaded.passwordCipher), directory: 'new-dir' })
    expect(storedPassword()).toBe(PWD)
    const again = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(again.directory).toBe('new-dir')
    // 同一口令：掩码尾串不变，且真实值可解（由 restore 用 load 的明文保证）
    expect(again.passwordCipher).toBe('••••' + PWD.slice(-4))
  })

  it('未配置时返回 null（不产出伪掩码）', async () => {
    expect(await call(IPC.BACKUP_WEBDAV_LOAD_CONFIG)).toBeNull()
  })
})

describe('SAVE/TEST 的掩码回填', () => {
  it('掩码 + 本机已有口令 → 视为未改动，照常保存', async () => {
    mocks.mode = 'db'
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(PWD))
    expect(storedPassword()).toBe(PWD)
    const masked = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    const r = await call<{ ok: boolean; error?: string }>(
      IPC.BACKUP_WEBDAV_SAVE_CONFIG,
      cfg(masked.passwordCipher, 'other-dir')
    )
    expect(r.ok).toBe(true)
    expect(storedPassword()).toBe(PWD)
  })

  it('none 模式下掩码回填不得被 B2 误判成改口令（只改目录要能存）', async () => {
    mocks.mode = 'db'
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(PWD))
    const masked = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    mocks.mode = 'none'
    const r = await call<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(masked.passwordCipher, 'dir2'))
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('none 模式 + 新口令仍然被拒（B2 口径不因掩码而放松）', async () => {
    const r = await call<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(PWD))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('主密码')
    expect(mocks.cfgStore.has('webdav_config')).toBe(false)
  })

  it('是掩码但本机没有已存口令 → 拒绝，绝不把占位符存成口令', async () => {
    mocks.mode = 'db'
    const r = await call<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg('••••9f3c'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('掩码')
    expect(mocks.cfgStore.has('webdav_config')).toBe(false)
  })

  it('TEST 提交掩码 → 送去鉴权的是真实口令', async () => {
    mocks.mode = 'db'
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(PWD))
    const masked = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    await call(IPC.BACKUP_WEBDAV_TEST, cfg(masked.passwordCipher))
    expect(mocks.testCreds).toHaveLength(1)
    expect(mocks.testCreds[0]!.password).toBe(PWD)
  })

  it('TEST 提交真实新口令 → 原样使用（首配即可测）', async () => {
    mocks.mode = 'none'
    await call(IPC.BACKUP_WEBDAV_TEST, cfg('typed-by-user'))
    expect(mocks.testCreds[0]!.password).toBe('typed-by-user')
  })

  it('空口令配置的掩码仍是空串（不制造伪占位），保存也不触发闸门', async () => {
    mocks.mode = 'none'
    const r = await call<{ ok: boolean }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(''))
    expect(r.ok).toBe(true)
    const out = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(out.passwordCipher).toBe('')
  })
})
