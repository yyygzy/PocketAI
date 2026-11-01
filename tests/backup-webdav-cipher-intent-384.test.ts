// §384：WebDAV 备份口令的幂等防护改吃「调用方声明的意图」，不再靠猜形状
//
// 缺陷形状（§382 真机撞出来的那一格，scratch root `data/vr382`）：
// `isCipherText` 只看 `v1:` 前缀 ⇒ 一条恰好以 `v1:` 开头的**明文**口令被 `saveWebDAVConfig`
// 当成"已加密"原样落盘；读侧从此把它当解不开的密文（`hasUndecryptableCipher` 恒真），
// 屏上那格永远说「口令解不开，请重填」，而重填同一句还是原样落盘＝出不去的循环。
//
// 本枚两半（口径 B）：
//   形状半——`isCipherText` 收紧成「前缀＋规范 base64（%4、round-trip）＋装得下 IV+TAG」；
//   意图半——`restoreWebDAVPassword` 带回 `passwordIsStoredCipher`，`saveWebDAVConfig(raw, { passwordAlreadyCipher })`
//            只在"声明了 ∧ 确实像信封"时才原样保留。根治是声明，形状只是不被骗的那一半。
//
// 策略：真加密真解密（换字段密钥造「解不开」），只桩开库／配置仓／网络；
// ②那一组是真注册＋真 invoke 的 IPC 通道（§349 那把杠杆：可逆真实故障＋真走 handler）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const KEY_OLD = Buffer.alloc(32, 0x11)
const KEY_NEW = Buffer.alloc(32, 0x22)

const H = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  store: new Map<string, string>(),
  fieldKey: Buffer.alloc(32, 0x11),
  mode: 'db' as 'none' | 'db',
  testCreds: [] as Array<{ password: string; url: string }>
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { H.handlers.set(ch, fn) } },
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

// 字段密钥每次现读：本文件把 H.fieldKey 换掉来造「解不开」（GCM tag 自己会拒）
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getFieldKey: () => H.fieldKey,
    getDbKey: () => Buffer.alloc(32, 7),
    getMode: () => H.mode,
    isDbEncrypted: () => true,
    hasKey: () => true
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => H.store.get(k) ?? null,
    set: (k: string, v: string) => { H.store.set(k, v) },
    delete: (k: string) => { H.store.delete(k) }
  },
  clearAppConfigCache: () => {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({ pragma: () => [] }) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '', DATA_DIR: process.cwd() }))
vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => ({ enabled: false, intervalHours: 24, retentionCount: 7 }),
  setBackupSchedule: () => ({}),
  noteManualBackup: () => {}
}))
vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async (creds: { password: string; url: string }) => {
    H.testCreds.push({ password: creds.password, url: creds.url })
    return { ok: true }
  },
  uploadBuffer: async () => ({}),
  downloadFile: async () => Buffer.alloc(0),
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async () => 'absent',
  uploadRemoteBuffer: async () => ({}),
  downloadRemoteFile: async () => Buffer.alloc(0)
}))

import { IPC, type MaskedWebDAVConfig, type WebDAVConfig } from '../src/shared/types'
import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'
import {
  loadWebDAVConfig,
  readWebDAVConfig,
  restoreWebDAVPassword,
  saveWebDAVConfig
} from '../src/main/backup/backup-service'
import { encryptApiKeys, isCipherText } from '../src/main/crypto/field-encrypt'

const PW = 'real-dav-password-42'
const LOOKALIKE = 'v1:look-alike-382-password' // §382 真机里那一行落盘的就是这串明文
const BASE: WebDAVConfig = {
  url: 'https://dav.example.com/remote.php/dav/files/me',
  username: 'me',
  passwordCipher: PW,
  directory: 'pocketai'
}
const ROW = 'webdav_config'
const column = (): string => String(JSON.parse(H.store.get(ROW) ?? '{}').passwordCipher ?? '')
const rawRow = (): string => H.store.get(ROW) ?? ''

async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = H.handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return (await handler({}, ...args)) as T
}

beforeEach(() => {
  H.store.clear()
  H.fieldKey = KEY_OLD
  H.mode = 'db'
  H.testCreds = []
  registerBackupHandlers()
})

describe('① 写侧两半都要（声明 ∧ 形状），任何一半单独都不放行', () => {
  it('声明「就是库里那份密文」∧ 确实是一枚信封 ⇒ 原样保留（绝不二次加密）', () => {
    const real = encryptApiKeys([PW])
    saveWebDAVConfig({ ...BASE, passwordCipher: real }, { passwordAlreadyCipher: true })
    expect(column(), '落盘的仍是那一枚信封').toBe(real)
    expect(loadWebDAVConfig()!.passwordCipher).toBe(PW)
  })

  it('声明了却形状不对（一条恰以 v1: 开头的明文）⇒ 不被"声明"骗过去，照样当明文加密', () => {
    saveWebDAVConfig({ ...BASE, passwordCipher: LOOKALIKE }, { passwordAlreadyCipher: true })
    expect(isCipherText(column()), '这一列现在是一枚真信封').toBe(true)
    expect(loadWebDAVConfig()!.passwordCipher, '读回来仍是那串明文口令').toBe(LOOKALIKE)
    expect(readWebDAVConfig().passwordUndecryptable, '从此不叫"解不开"').toBe(false)
  })

  it('正向对照：普通明文不声明 ⇒ 加密、读回原口令、flag false', () => {
    saveWebDAVConfig(BASE)
    expect(isCipherText(column())).toBe(true)
    expect(loadWebDAVConfig()!.passwordCipher).toBe(PW)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
  })

  it('回填那一步把两种到货分开（这一颗就是 handler 转交给 save 的那句声明）', () => {
    saveWebDAVConfig(BASE)
    const masked: WebDAVConfig = { ...BASE, passwordCipher: '••••d-42' }
    expect(restoreWebDAVPassword(masked)!.passwordIsStoredCipher, '库里解得开＝带回的是明文').toBe(false)
    H.fieldKey = KEY_NEW // 换字段密钥、那一行没跟着重写＝§323 那种半状态
    const r = restoreWebDAVPassword(masked)!
    expect(r.passwordIsStoredCipher, '库里解不开＝带回的是密文原文，必须由读侧说出来').toBe(true)
    expect(r.cfg.passwordCipher.startsWith('v1:'), '交回的那一串确实是原始密文').toBe(true)
  })
})

describe('② 真通道：SAVE_CONFIG 把读侧那句声明转交给写侧', () => {
  it('首配提交明文 ⇒ 落盘是信封、出 IPC 只有掩码、flag false', async () => {
    expect(await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, BASE)).toEqual({ ok: true })
    expect(isCipherText(column())).toBe(true)
    const out = await call<MaskedWebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(out.passwordCipher).toBe('••••' + PW.slice(-4))
    expect(out.passwordUndecryptable).toBe(false)
  })

  it('库里那份解不开＋提交掩码（只改目录）⇒ 口令那一列字节未变、屏上仍如实说「解不开」', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, BASE)
    const before = column()
    H.fieldKey = KEY_NEW
    const masked = await call<MaskedWebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    const r = await call<{ ok: boolean }>(
      IPC.BACKUP_WEBDAV_SAVE_CONFIG,
      { ...BASE, passwordCipher: masked.passwordCipher, directory: 'new-dir' }
    )
    expect(r.ok).toBe(true)
    expect(column(), '没有被当明文再包一层＝旧钥密文原地保留').toBe(before)
    expect(JSON.parse(rawRow()).directory, '目录那一项照常改成了').toBe('new-dir')
    const again = await call<MaskedWebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(again.passwordUndecryptable, '这一档不许被演成"能用"').toBe(true)
  })

  it('库里那份解不开＋用户重填新口令 ⇒ 换成新钥信封、flag 转 false（重填就是那一格的出口）', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, BASE)
    H.fieldKey = KEY_NEW
    expect((await call<MaskedWebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)).passwordUndecryptable).toBe(true)
    const typed: WebDAVConfig = { ...BASE, passwordCipher: 'fresh-password-77' }
    expect(await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, typed)).toEqual({ ok: true })
    H.fieldKey = KEY_NEW // 新钥下再读一次
    expect(loadWebDAVConfig()!.passwordCipher).toBe('fresh-password-77')
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
  })

  it('TEST 那一路：提交掩码＋库里解不开 ⇒ 送去鉴权的是库里那一串（不是占位符），且不改写配置', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, BASE)
    const beforeRow = rawRow()
    const beforeCol = column()
    H.fieldKey = KEY_NEW
    const masked = await call<MaskedWebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    await call(IPC.BACKUP_WEBDAV_TEST, { ...BASE, passwordCipher: masked.passwordCipher })
    expect(H.testCreds).toHaveLength(1)
    expect(H.testCreds[0]!.password, '回填交出的就是原始密文＝这一发鉴权必败，但绝不把 •••• 当口令').toBe(beforeCol)
    expect(beforeCol.startsWith('v1:'), '先证明那一列确实是密文').toBe(true)
    expect(rawRow(), '测试不写盘').toBe(beforeRow)
  })
})

describe('③ 老数据救回（§382 真机那一格，CI 侧同形）', () => {
  it('库里那一行是明文 `v1:look-alike…` ⇒ 读侧不再叫它"解不开"、鉴权用原口令', () => {
    H.store.set(ROW, JSON.stringify({ ...BASE, passwordCipher: LOOKALIKE }))
    expect(readWebDAVConfig().passwordUndecryptable, '改前这一发恒真＝屏上出不去的循环').toBe(false)
    expect(loadWebDAVConfig()!.passwordCipher).toBe(LOOKALIKE)
  })

  it('同一份走一次"只改目录"的保存 ⇒ 那一列被补成真信封，读回来还是原口令（自愈合，且不双层化）', async () => {
    H.store.set(ROW, JSON.stringify({ ...BASE, passwordCipher: LOOKALIKE }))
    const masked = await call<MaskedWebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(masked.passwordUndecryptable).toBe(false)
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, { ...BASE, passwordCipher: masked.passwordCipher, directory: 'healed' })
    expect(isCipherText(column()), '这一列现在真的是一枚信封').toBe(true)
    expect(loadWebDAVConfig()!.passwordCipher, '解出来还是那串口令，不是套了两层的密文').toBe(LOOKALIKE)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
    H.testCreds = []
    await call(IPC.BACKUP_WEBDAV_TEST, { ...BASE, passwordCipher: masked.passwordCipher })
    expect(H.testCreds[0]!.password).toBe(LOOKALIKE)
  })
})
