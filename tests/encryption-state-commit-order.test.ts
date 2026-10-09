// 加密状态落盘顺序的失败注入测试（SEC-33）
//
// 钉住一条不变量：**库操作成功之前，不得写入 salt / 档位 / 加密模式 / has_master_password**。
// 反例曾导致两种「数据完好但界面锁死」的状态：
// - 改密时新 salt 先覆盖了旧 salt，随后 rekey 抛错 ⇒ 库里旧密钥、配置里新盐，
//   逐档重试也用错盐，用户再也解不开（旧盐已被销毁，无从自愈）；
// - 启用加密时先把模式标成 db，随后 enableEncryption 抛错 ⇒ boot 走 unlock 分支
//   却面对明文库，只能报「数据库已损坏」。
// 做法：mock 掉全部依赖，让库操作按需抛错，断言写序与回滚。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  seq: [] as string[],
  failEnable: false,
  failRekey: false,
  cfg: { salt: null as Buffer | null, kdf: null as unknown, mode: 'none', hasPw: false }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => mocks.handlers.set(ch, fn) },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: { showErrorBox: () => {}, showOpenDialog: async () => ({ canceled: true }) },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// 主密钥管理器：纯状态桩，顺带记录调用序
vi.mock('../src/main/crypto/master-key', () => {
  let masterKey: Buffer | null = null
  let mode = 'none'
  let fixedKey: Buffer | null = null
  const mgr = {
    init: (m: string) => { mocks.seq.push(`init:${m}`); mode = m; masterKey = null; fixedKey = Buffer.alloc(32, 9); return undefined },
    setKey: (pw: string, salt?: Buffer) => { mocks.seq.push('setKey'); masterKey = Buffer.alloc(32, pw.length + (salt?.length ?? 0)); return masterKey },
    setRawKey: (k: Buffer) => { mocks.seq.push('setRawKey'); masterKey = k; mode = 'db' },
    getDbKey: () => masterKey,
    getFieldKey: () => masterKey ?? fixedKey ?? Buffer.alloc(32, 1),
    generateSalt: () => Buffer.alloc(16, 3),
    getMode: () => mode as 'none' | 'db',
    isDbEncrypted: () => mode === 'db' && !!masterKey,
    hasKey: () => true,
    clear: () => { masterKey = null },
    __setMode: (m: string) => { mode = m }
  }
  return { masterKeyManager: mgr }
})

vi.mock('../src/main/db/database', () => ({
  dbService: {
    isOpen: () => true,
    getEncryptionMode: () => mocks.cfg.mode,
    open: (key?: Buffer) => { mocks.seq.push(key ? 'open:withKey' : 'open:plain') },
    close: () => { mocks.seq.push('close') },
    enableEncryption: () => {
      mocks.seq.push('enableEncryption')
      if (mocks.failEnable) throw new Error('disk locked')
      mocks.cfg.mode = 'db'
    },
    runMigrations: () => {},
    getHandle: () => ({
      prepare: () => ({ get: () => 1, all: () => [], run: () => {} }),
      pragma: (sql: string) => {
        mocks.seq.push(`pragma:${sql.split(' ')[0]}`)
        if (sql.startsWith('rekey') && mocks.failRekey) throw new Error('rekey failed')
        return []
      },
      transaction: (fn: () => void) => fn
    })
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getEncryptionMode: () => mocks.cfg.mode,
    hasMasterPassword: () => mocks.cfg.hasPw,
    getMasterPasswordSalt: () => mocks.cfg.salt,
    setMasterPasswordSalt: (s: Buffer) => { mocks.seq.push('setSalt'); mocks.cfg.salt = s },
    clearMasterPasswordSalt: () => { mocks.seq.push('clearSalt'); mocks.cfg.salt = null },
    getKdfParams: () => mocks.cfg.kdf ?? { N: 32768, r: 8, p: 1 },
    setKdfParams: (p: unknown) => { mocks.seq.push('setKdf'); mocks.cfg.kdf = p },
    clearKdfParams: () => { mocks.seq.push('clearKdf'); mocks.cfg.kdf = null },
    setEncryptionMode: (m: string) => { mocks.seq.push(`setMode:${m}`); mocks.cfg.mode = m },
    setHasMasterPassword: (v: boolean) => { mocks.seq.push(`setHasPw:${v}`); mocks.cfg.hasPw = v },
    get: () => null,
    set: () => {},
    delete: () => {}
  },
  clearAppConfigCache: () => {}
}))

vi.mock('../src/main/crypto/credential-rotation', () => ({
  exportFieldCredentials: () => { mocks.seq.push('exportSnapshot'); return {} },
  restoreFieldCredentials: () => { mocks.seq.push('restoreSnapshot') }
}))
vi.mock('../src/main/crypto/recovery-key', () => ({
  recoveryKeyManager: {
    hasRecovery: () => false,
    enableRecovery: () => 'CODE-CODE-CODE',
    disableRecovery: () => {},
    recoverMasterKey: () => Buffer.alloc(32, 5)
  }
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
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))
vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => null,
  saveWebDAVConfig: () => {},
  deriveKeySync: () => Buffer.alloc(32),
  ENC_PREFIX: 'PKBK1',
  isEncryptedBlob: () => false,
  decryptBackup: () => Buffer.alloc(0),
  BackupDecryptError: class extends Error {}
}))

import { IPC } from '../src/shared/types'
import { registerEncryptionHandlers } from '../src/main/ipc/handlers/encryption'
import { masterKeyManager } from '../src/main/crypto/master-key'

const eventStub = { sender: {} }
const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(eventStub, ...args)

const OLD_PW = 'old-password-6'
const NEW_PW = 'brand-new-master-password'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.seq = []
  mocks.failEnable = false
  mocks.failRekey = false
  mocks.cfg.salt = Buffer.alloc(16, 1)
  mocks.cfg.kdf = { N: 32768, r: 8, p: 1 }
  mocks.cfg.mode = 'none'
  mocks.cfg.hasPw = false
  registerEncryptionHandlers()
})

describe('ENCRYPTION_ENABLE：明文库启用加密', () => {
  it('成功路径下 salt/档位/模式都排在 enableEncryption 之后', async () => {
    const r = (await call(IPC.ENCRYPTION_ENABLE, NEW_PW)) as { ok: boolean }
    expect(r.ok).toBe(true)
    const seq = mocks.seq
    const at = (s: string) => seq.indexOf(s)
    expect(at('enableEncryption')).toBeGreaterThanOrEqual(0)
    expect(at('setSalt')).toBeGreaterThan(at('enableEncryption'))
    expect(at('setKdf')).toBeGreaterThan(at('enableEncryption'))
    expect(at('setMode:db')).toBeGreaterThan(at('enableEncryption'))
    expect(at('setHasPw:true')).toBeGreaterThan(at('enableEncryption'))
  })

  it('enableEncryption 抛错 ⇒ 一个状态位都不写，并回滚成无密码模式', async () => {
    mocks.failEnable = true
    const r = (await call(IPC.ENCRYPTION_ENABLE, NEW_PW)) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未能加密')
    expect(mocks.seq).not.toContain('setSalt')
    expect(mocks.seq).not.toContain('setKdf')
    expect(mocks.seq).not.toContain('setMode:db')
    expect(mocks.seq).not.toContain('setHasPw:true')
    // 回滚：切回 fixed key 模式并重新以明文打开（否则会话里留着解不开的 master key）
    expect(mocks.seq).toContain('init:none')
    expect(mocks.seq).toContain('open:plain')
    expect(mocks.cfg.mode).toBe('none')
    expect(mocks.cfg.hasPw).toBe(false)
  })

  it('密码短于 10 位在 schema 层就被拒（不进业务逻辑）', async () => {
    const r = (await call(IPC.ENCRYPTION_ENABLE, 'short9')) as { ok?: boolean; error?: string }
    expect(mocks.seq.filter((s) => s === 'setKey' || s === 'enableEncryption')).toEqual([])
    expect(r?.ok === false || r?.error !== undefined).toBe(true)
  })
})

describe('ENCRYPTION_CHANGE_PASSWORD：改密 rekey 失败不得销毁旧 salt', () => {
  beforeEach(() => {
    mocks.cfg.mode = 'db'
    mocks.cfg.hasPw = true
    const mgr = masterKeyManager as unknown as { __setMode: (m: string) => void; setRawKey: (k: Buffer) => void }
    mgr.__setMode('db')
    // 会话里先持有「旧密钥」，与真实改密场景一致（库已用旧密码打开着）
    mgr.setRawKey(Buffer.alloc(32, 4))
    mocks.seq = []
  })

  it('rekey 抛错 ⇒ salt/档位未前进、旧盐仍在、旧密钥回滚到会话', async () => {
    const saltBefore = mocks.cfg.salt
    mocks.failRekey = true
    const r = (await call(IPC.ENCRYPTION_CHANGE_PASSWORD, OLD_PW, NEW_PW)) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('旧密码仍然有效')
    expect(mocks.seq).not.toContain('setSalt')
    expect(mocks.seq).not.toContain('setKdf')
    expect(mocks.cfg.salt).toBe(saltBefore) // 旧盐没被覆盖 ⇒ 仍可继续用旧密码解锁
    expect(mocks.seq).toContain('setRawKey') // 回滚持钥
    expect(mocks.seq).not.toContain('restoreSnapshot') // 凭据没被新钥重加密过，不能误恢复
  })

  it('成功路径下 salt/档位写在 rekey 之后', async () => {
    const r = (await call(IPC.ENCRYPTION_CHANGE_PASSWORD, OLD_PW, NEW_PW)) as { ok: boolean }
    expect(r.ok).toBe(true)
    const seq = mocks.seq
    const rekeyAt = seq.findIndex((s) => s === 'pragma:rekey')
    expect(rekeyAt).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf('setSalt')).toBeGreaterThan(rekeyAt)
    expect(seq.indexOf('setKdf')).toBeGreaterThan(rekeyAt)
  })
})
