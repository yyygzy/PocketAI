// §381 接线半：真注册＋真 invoke 改密那一发 IPC，看它拿到「解不开的 WebDAV 口令」时怎么做
//
// 为什么不停在源码判据：这一发的后果（旧钥密文被当明文回写＝永久解不开）只能在
// 「真加密的库＋真换了字段密钥＋真走 handler」那条链上才看得出来（§349 那把杠杆：可逆真实故障）。
// 这里 backup-service 与 field-encrypt 都是真的，只桩开库与主密码派生。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  store: new Map<string, string>(),
  writes: [] as string[],
  fieldKey: Buffer.alloc(32, 0x11),
  undecryptable: [] as string[],
  warns: [] as string[]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { H.handlers.set(ch, fn as never) } },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: { showErrorBox: () => {}, showOpenDialog: async () => ({ canceled: true }) },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// 字段密钥必须是"每次现读"的：本文件把 commitNewMasterKeyState 定义成"换钥"这一步
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getFieldKey: () => H.fieldKey,
    getDbKey: () => Buffer.alloc(32, 7),
    isDbEncrypted: () => true,
    hasKey: () => true,
    getMode: () => 'db',
    setKey: () => Buffer.alloc(32, 7),
    setRawKey: () => {},
    generateSalt: () => Buffer.alloc(16, 3),
    clear: () => {},
    init: () => {}
  }
}))
vi.mock('../src/main/crypto/master-password', () => ({
  verifyAndOpenMasterKey: () => true,
  prepareNewMasterKey: () => ({ key: Buffer.alloc(32, 0x22), salt: Buffer.alloc(16, 8), kdf: { N: 32768, r: 8, p: 1 } }),
  // 不可逆点：这之后 field key 就是新的了，而配置文件里那一行还是旧钥的密文
  commitNewMasterKeyState: () => { H.fieldKey = Buffer.alloc(32, 0x22) },
  kdfStatus: () => ({ current: false, bits: 15 })
}))
vi.mock('../src/main/crypto/credential-rotation', () => ({
  exportFieldCredentials: () => ({ kv: {}, providers: {}, mcp: {}, undecryptable: [...H.undecryptable] }),
  restoreFieldCredentials: () => {}
}))
vi.mock('../src/main/crypto/recovery-key', () => ({
  recoveryKeyManager: { hasRecovery: () => false, recoveryStatus: () => ({ has: false, carriedFrom: null }), enableRecovery: () => '', disableRecovery: () => {}, recoverMasterKey: () => null }
}))
vi.mock('../src/main/crypto/clipboard-guard', () => ({ clipboardGuard: { purge: () => {} } }))
vi.mock('../src/main/crypto/unlock-coordinator', () => ({
  unlockCoordinator: { isWaiting: () => false, submit: () => {}, waitForUnlock: async () => null }
}))
vi.mock('../src/main/crypto/auth-ratelimit', () => ({
  authRateLimiter: { check: () => ({ allowed: true, retryAfterMs: 0, attempts: 0 }), fail: () => ({ retryAfterMs: 0, attempts: 1 }), reset: () => {} },
  AUTH_BUCKET: { UNLOCK: 'unlock', RECOVER: 'recover' }
}))
vi.mock('../src/main/lock/lock', () => ({
  lockService: { lock: () => {}, unlock: () => {}, getStatus: () => ({ state: 'unlocked' }), setAutoTimeout: () => {}, markActive: () => {}, onStateChange: () => {} }
}))
vi.mock('../src/main/net/external-links', () => ({ denyNewWindows: () => {} }))
vi.mock('../src/main/logger', () => ({
  // 记下原文：只数"有没有 warn 过"会被别处一句无关的 warn 喂绿（牙齿轮 M3 就是这么暴露的）
  createLogger: () => ({
    error: () => {},
    warn: (...a: unknown[]) => { H.warns.push(a.map((x) => String(x)).join(' ')) },
    info: () => {},
    debug: () => {}
  })
}))
vi.mock('../src/main/db/database', () => ({
  dbService: {
    isOpen: () => true,
    getEncryptionMode: () => 'db',
    open: () => {},
    close: () => {},
    runMigrations: () => {},
    getHandle: () => ({ prepare: () => ({ get: () => 1, all: () => [], run: () => {} }), pragma: () => [], transaction: (fn: () => void) => fn })
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => H.store.get(k) ?? null,
    set: (k: string, v: string) => { H.store.set(k, v); H.writes.push(k) },
    delete: (k: string) => { H.store.delete(k) },
    getEncryptionMode: () => 'db',
    hasMasterPassword: () => true,
    getMasterPasswordSalt: () => Buffer.alloc(16, 3),
    setMasterPasswordSalt: () => {},
    clearMasterPasswordSalt: () => {},
    getKdfParams: () => ({ N: 32768, r: 8, p: 1 }),
    setKdfParams: () => {},
    clearKdfParams: () => {},
    setEncryptionMode: () => {},
    setHasMasterPassword: () => {}
  },
  clearAppConfigCache: () => {}
}))
// backup-service 真身需要这几样（本文件不测网络与库文件）
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '' }))
vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async () => ({ ok: true }),
  uploadBuffer: async () => {},
  downloadFile: async () => Buffer.alloc(0),
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async () => 'absent',
  uploadRemoteBuffer: async () => {},
  downloadRemoteFile: async () => Buffer.alloc(0)
}))

import { IPC } from '../src/shared/types'
import { registerEncryptionHandlers } from '../src/main/ipc/handlers/encryption'
import { saveWebDAVConfig, loadWebDAVConfig, readWebDAVConfig } from '../src/main/backup/backup-service'

const KEY_OLD = Buffer.alloc(32, 0x11)
const PW = 'real-dav-password-42'
const CFG = { url: 'https://dav.example.com/remote.php/dav/files/me', username: 'me', passwordCipher: PW, directory: 'pocketai' }
const ROW = 'webdav_config'

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  H.handlers.get(channel)!({ sender: {} }, ...args)

beforeEach(() => {
  H.handlers.clear()
  H.store.clear()
  H.writes = []
  H.warns = []
  H.undecryptable = []
  H.fieldKey = KEY_OLD
  registerEncryptionHandlers()
})

describe('改密那一发遇上「WebDAV 口令解不开」', () => {
  it('解不开 ⇒ 不重写这一行（旧钥密文原地保留）、上报 1 项、留一条 warn', async () => {
    saveWebDAVConfig(CFG)
    H.fieldKey = Buffer.alloc(32, 0x33) // 当前密钥已经不是加密它的那把 ⇒ 解不开
    const rowBefore = H.store.get(ROW)!
    expect(readWebDAVConfig().passwordUndecryptable).toBe(true)
    H.writes = []

    const r = await call(IPC.ENCRYPTION_CHANGE_PASSWORD, 'old-password-6', 'brand-new-master-password') as Record<string, unknown>

    expect(r.ok).toBe(true)
    expect(r.undecryptableCount, '解不开的那一份要并进 §375 那一句的 N').toBe(1)
    expect(H.writes, '这一行一次都不许写（写了就是拿密文当明文）').not.toContain(ROW)
    expect(H.store.get(ROW)).toBe(rowBefore)
    expect(H.warns.join('\n'), '留痕那句要点名 WebDAV 口令（不是任何一句无关的 warn）')
      .toContain('WebDAV 备份口令用旧字段密钥解不开')
  })

  it('反向对照：解得开 ⇒ 真用新密钥重写了这一行，重写后仍解得开、上报 0 项', async () => {
    saveWebDAVConfig(CFG)
    const rowBefore = H.store.get(ROW)!
    H.writes = []

    const r = await call(IPC.ENCRYPTION_CHANGE_PASSWORD, 'old-password-6', 'brand-new-master-password') as Record<string, unknown>

    expect(r.ok).toBe(true)
    expect(r.undecryptableCount).toBe(0)
    expect(H.writes).toContain(ROW)
    expect(H.store.get(ROW)).not.toBe(rowBefore)
    // commitNewMasterKeyState 把字段密钥换成了新那把 ⇒ 能读回明文＝轮换真的接住了这一行
    expect(loadWebDAVConfig()!.passwordCipher).toBe(PW)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
  })

  it('反向对照：压根没配过 WebDAV ⇒ 也是 0 项（解不开≠没配过，两档各报各的）', async () => {
    const r = await call(IPC.ENCRYPTION_CHANGE_PASSWORD, 'old-password-6', 'brand-new-master-password') as Record<string, unknown>
    expect(r.ok).toBe(true)
    expect(r.undecryptableCount).toBe(0)
    expect(H.writes).not.toContain(ROW)
  })

  it('字段凭据 2 项解不开＋WebDAV 口令 1 项解不开 ⇒ 同一个 N=3（不是各说各的两句）', async () => {
    H.undecryptable = ['provider:deepseek', 'mcp:fs']
    saveWebDAVConfig(CFG)
    H.fieldKey = Buffer.alloc(32, 0x33)
    const r = await call(IPC.ENCRYPTION_CHANGE_PASSWORD, 'old-password-6', 'brand-new-master-password') as Record<string, unknown>
    expect(r.undecryptableCount).toBe(3)
  })

  // 顺序（「先判再换钥」）不在这里单列用例：桩里的换钥只发生在 commitNewMasterKeyState，
  // 上面「解得开 ⇒ 真重写」那一发就是它的判据——读若挪到换钥之后，同一份配置会当场变成"解不开"、
  // 那一发就红了（不必再造一份两头都对不上密钥的密文）。
})
