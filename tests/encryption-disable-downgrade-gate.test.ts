// 禁用/启用加密时的「凭据降级」二次确认与审计（SEC-1）
//
// 钉住四件事：
// - 守卫在主进程：清点由主进程做、弹的是原生框；渲染层多传参数也换不来一次 rekey；
// - 取消 = 一个字节都不改（不 rekey、不写 config、不重裹凭据、不写审计）；
// - 确认后落一条审计，说明凭据改用「源码公开常量派生的密钥」混淆（内容可读、不含密钥值）；
// - 启用加密反向落一条「已用主密码派生密钥重写」。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  seq: [] as string[],
  dialogCalls: [] as Array<{ title?: string; message?: string; detail?: string; buttons?: string[] }>,
  /** 原生框返回的下标（0=取消，1=确认） */
  dialogResponse: 0,
  style: 'none' as 'none' | 'db',
  inventory: { kv: 2, providers: 1, mcp: 1, webdav: 1, total: 5 },
  audits: [] as Array<{ kind: string; message: string; detail?: Record<string, unknown> }>,
  cfg: { salt: null as Buffer | null, kdf: null as unknown, mode: 'none', hasPw: false }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => mocks.handlers.set(ch, fn) },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showErrorBox: () => {},
    showOpenDialog: async () => ({ canceled: true }),
    showMessageBox: async (...args: unknown[]) => {
      // 两种重载：showMessageBox(options) / showMessageBox(win, options)
      const opts = (args.length > 1 ? args[1] : args[0]) as {
        title?: string
        message?: string
        detail?: string
        buttons?: string[]
      }
      mocks.dialogCalls.push(opts)
      return { response: mocks.dialogResponse, checkboxChecked: false }
    }
  },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

vi.mock('../src/main/crypto/master-key', () => {
  let masterKey: Buffer | null = null
  let mode = 'none'
  const mgr = {
    init: (m: string) => {
      mocks.seq.push(`init:${m}`)
      mode = m
      masterKey = null
      return undefined
    },
    setKey: (pw: string, salt?: Buffer) => {
      mocks.seq.push('setKey')
      masterKey = Buffer.alloc(32, pw.length + (salt?.length ?? 0))
      return masterKey
    },
    setRawKey: (k: Buffer) => {
      mocks.seq.push('setRawKey')
      masterKey = k
      mode = 'db'
    },
    getDbKey: () => masterKey,
    getFieldKey: () => masterKey ?? Buffer.alloc(32, 1),
    generateSalt: () => Buffer.alloc(16, 3),
    getMode: () => mode as 'none' | 'db',
    isDbEncrypted: () => mode === 'db' && !!masterKey,
    hasKey: () => true,
    clear: () => {
      masterKey = null
    },
    __setMode: (m: string) => {
      mode = m
    }
  }
  return { masterKeyManager: mgr }
})

vi.mock('../src/main/db/database', () => ({
  dbService: {
    isOpen: () => true,
    getEncryptionMode: () => mocks.cfg.mode,
    open: (key?: Buffer) => {
      mocks.seq.push(key ? 'open:withKey' : 'open:plain')
    },
    close: () => {
      mocks.seq.push('close')
    },
    enableEncryption: () => {
      mocks.seq.push('enableEncryption')
      mocks.cfg.mode = 'db'
    },
    runMigrations: () => {},
    getHandle: () => ({
      prepare: () => ({ get: () => 1, all: () => [], run: () => {} }),
      pragma: (sql: string) => {
        mocks.seq.push(`pragma:${sql.split(' ')[0]}`)
        if (sql.startsWith('rekey')) mocks.seq.push('rekey')
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
    setMasterPasswordSalt: (s: Buffer) => {
      mocks.seq.push('setSalt')
      mocks.cfg.salt = s
    },
    clearMasterPasswordSalt: () => {
      mocks.seq.push('clearSalt')
      mocks.cfg.salt = null
    },
    getKdfParams: () => mocks.cfg.kdf ?? { N: 32768, r: 8, p: 1 },
    setKdfParams: (p: unknown) => {
      mocks.seq.push('setKdf')
      mocks.cfg.kdf = p
    },
    clearKdfParams: () => {
      mocks.seq.push('clearKdf')
      mocks.cfg.kdf = null
    },
    setEncryptionMode: (m: string) => {
      mocks.seq.push(`setMode:${m}`)
      mocks.cfg.mode = m
    },
    setHasMasterPassword: (v: boolean) => {
      mocks.seq.push(`setHasPw:${v}`)
      mocks.cfg.hasPw = v
    },
    get: () => null,
    set: () => {},
    delete: () => {}
  },
  clearAppConfigCache: () => {}
}))

vi.mock('../src/main/crypto/credential-rotation', () => ({
  exportFieldCredentials: () => {
    mocks.seq.push('exportSnapshot')
    return {}
  },
  restoreFieldCredentials: () => {
    mocks.seq.push('restoreSnapshot')
  }
}))

// 清点结果由用例控制：这里只关心「主进程拿它做了什么」
vi.mock('../src/main/crypto/credential-inventory', () => ({
  countStoredCredentials: () => ({ ...mocks.inventory })
}))

vi.mock('../src/main/db/repositories/security-event.repo', () => ({
  securityEventRepo: {
    append: (input: { kind: string; message: string; detail?: Record<string, unknown> }) => {
      mocks.audits.push(input)
      return true
    },
    listRecent: () => []
  }
}))

vi.mock('../src/main/crypto/recovery-key', () => ({
  recoveryKeyManager: {
    hasRecovery: () => false,
    recoveryStatus: () => ({ has: false, carriedFrom: null }),
    enableRecovery: () => 'CODE-CODE-CODE',
    disableRecovery: () => {
      mocks.seq.push('disableRecovery')
    },
    recoverMasterKey: () => Buffer.alloc(32, 5)
  }
}))
vi.mock('../src/main/crypto/clipboard-guard', () => ({ clipboardGuard: { purge: () => {} } }))
vi.mock('../src/main/crypto/unlock-coordinator', () => ({
  unlockCoordinator: { isWaiting: () => false, submit: () => {}, waitForUnlock: async () => null }
}))
vi.mock('../src/main/crypto/auth-ratelimit', () => ({
  authRateLimiter: {
    check: () => ({ allowed: true, retryAfterMs: 0, attempts: 0 }),
    fail: () => ({ retryAfterMs: 0, attempts: 1 }),
    reset: () => {}
  },
  AUTH_BUCKET: { UNLOCK: 'unlock', RECOVER: 'recover' }
}))
vi.mock('../src/main/lock/lock', () => ({
  lockService: {
    lock: () => {},
    unlock: () => {},
    getStatus: () => ({ state: 'unlocked' }),
    setAutoTimeout: () => {},
    markActive: () => {},
    onStateChange: () => {}
  }
}))
vi.mock('../src/main/net/external-links', () => ({ denyNewWindows: () => {} }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))
vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => null,
  saveWebDAVConfig: () => {},
  captureWebDAVForRekey: () => ({ cfg: null, undecryptable: false }),
  restoreWebDAVAfterRekey: () => false,
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

const PW = 'master-password-1'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.seq = []
  mocks.dialogCalls = []
  mocks.dialogResponse = 0
  mocks.inventory = { kv: 2, providers: 1, mcp: 1, webdav: 1, total: 5 }
  mocks.audits = []
  mocks.cfg.salt = Buffer.alloc(16, 1)
  mocks.cfg.kdf = { N: 32768, r: 8, p: 1 }
  mocks.cfg.mode = 'db'
  mocks.cfg.hasPw = true
  const mgr = masterKeyManager as unknown as { __setMode: (m: string) => void; setRawKey: (k: Buffer) => void }
  mgr.__setMode('db')
  mgr.setRawKey(Buffer.alloc(32, 4))
  registerEncryptionHandlers()
})

describe('ENCRYPTION_DISABLE 的凭据降级确认', () => {
  it('取消：一个字节都不改，也不写审计', async () => {
    mocks.dialogResponse = 0
    const r = (await call(IPC.ENCRYPTION_DISABLE, PW)) as { ok: boolean; canceled?: boolean }
    expect(r.ok).toBe(false)
    expect(r.canceled).toBe(true)
    expect(mocks.seq).not.toContain('pragma:rekey')
    expect(mocks.seq).not.toContain('init:none')
    expect(mocks.seq).not.toContain('setMode:none')
    expect(mocks.seq).not.toContain('setHasPw:false')
    expect(mocks.seq).not.toContain('clearSalt')
    expect(mocks.seq).not.toContain('restoreSnapshot')
    expect(mocks.audits).toEqual([])
    expect(mocks.cfg.mode).toBe('db')
    expect(mocks.cfg.hasPw).toBe(true)
  })

  it('渲染层多传「已确认」也不作数：守卫只看原生框', async () => {
    mocks.dialogResponse = 0
    const r = (await call(IPC.ENCRYPTION_DISABLE, PW, { confirmed: true, skipConfirm: true })) as {
      ok?: boolean
      canceled?: boolean
      error?: string
    }
    // 要么参数校验直接拒绝、要么走原生框被取消——两条路都不许 rekey
    expect(r.ok).toBeFalsy()
    expect(mocks.seq).not.toContain('pragma:rekey')
    expect(mocks.seq).not.toContain('init:none')
  })

  it('确认：照旧完成禁用，并落一条「公开常量派生密钥混淆」的审计', async () => {
    mocks.dialogResponse = 1
    const r = (await call(IPC.ENCRYPTION_DISABLE, PW)) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(mocks.seq).toContain('pragma:rekey')
    expect(mocks.seq).toContain('restoreSnapshot')
    expect(mocks.audits).toHaveLength(1)
    const audit = mocks.audits[0]!
    expect(audit.kind).toBe('encryption_disabled')
    expect(audit.message).toContain('5 项')
    expect(audit.message).toContain('公开常量')
    expect(audit.message).toContain('混淆')
    expect(audit.detail).toMatchObject({ kv: 2, providers: 1, mcp: 1, webdav: 1, total: 5 })
  })

  it('原生框把后果说清楚（明文 + 固定密钥 + 可还原）', async () => {
    mocks.dialogResponse = 1
    await call(IPC.ENCRYPTION_DISABLE, PW)
    expect(mocks.dialogCalls).toHaveLength(1)
    const d = mocks.dialogCalls[0]!
    expect(d.message).toContain('5 项')
    expect(d.detail).toContain('固定密钥')
    expect(d.detail).toContain('明文')
    expect(d.buttons?.[0]).toBe('取消')
  })

  it('没有凭据：不打扰用户，直接禁用，审计说明「无凭据被降级」', async () => {
    mocks.inventory = { kv: 0, providers: 0, mcp: 0, webdav: 0, total: 0 }
    const r = (await call(IPC.ENCRYPTION_DISABLE, PW)) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(mocks.dialogCalls).toHaveLength(0)
    expect(mocks.audits).toHaveLength(1)
    expect(mocks.audits[0]!.message).toContain('无凭据被降级')
  })

  it('密码错误：不弹框（还没到降级那一步）', async () => {
    // 桩里的 setKey 恒成功，但 verifyAndOpenMasterKey 会按 salt/档位重开库；
    // 这里改用空密码触发 schema 拒绝，确认不进业务逻辑
    const r = (await call(IPC.ENCRYPTION_DISABLE, '')) as { ok?: boolean; error?: string }
    expect(r?.ok === false || r?.error !== undefined).toBe(true)
    expect(mocks.dialogCalls).toHaveLength(0)
  })
})

describe('ENCRYPTION_ENABLE 的反向审计', () => {
  it('成功启用后落一条「已用主密码派生密钥重写」', async () => {
    mocks.cfg.mode = 'none'
    mocks.cfg.hasPw = false
    mocks.cfg.salt = null
    mocks.cfg.kdf = null
    const mgr = masterKeyManager as unknown as { __setMode: (m: string) => void }
    mgr.__setMode('none')
    const r = (await call(IPC.ENCRYPTION_ENABLE, PW)) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(mocks.audits).toHaveLength(1)
    expect(mocks.audits[0]!.kind).toBe('encryption_enabled')
    expect(mocks.audits[0]!.message).toContain('5 项')
    expect(mocks.audits[0]!.message).toContain('主密码派生密钥重写')
    expect(mocks.audits[0]!.detail).toMatchObject({ total: 5 })
  })
})
