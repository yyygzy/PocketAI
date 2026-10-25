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
  /** §310：接下来 N 次「无密钥开库」抛错（改密校验那趟是带密钥开的，不受这颗开关影响） */
  failPlainOpenTimes: 0,
  /** §310：rekey 成功后第一次 close 抛错（模拟"越过不可逆点才撞上文件锁"那个窗口） */
  failCloseAfterRekey: false,
  closeThrowLeft: 0,
  /** §310：`isOpen()` 改成有状态的——补齐分支靠它判"这次到底开开没" */
  opened: true,
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
    isOpen: () => mocks.opened,
    getEncryptionMode: () => mocks.cfg.mode,
    open: (key?: Buffer) => {
      mocks.seq.push(key ? 'open:withKey' : 'open:plain')
      // §310：无密钥开库按需抛错（校验密码那一趟是带密钥开的，不受这颗开关影响）
      if (!key && mocks.failPlainOpenTimes > 0) {
        mocks.failPlainOpenTimes -= 1
        throw new Error('file locked')
      }
      mocks.opened = true
    },
    close: () => {
      mocks.seq.push('close')
      if (mocks.closeThrowLeft > 0) {
        mocks.closeThrowLeft -= 1
        throw new Error('close failed')
      }
      mocks.opened = false
    },
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
        if (sql.startsWith('rekey')) {
          // §310：把抛错点钉在"库已改为明文"之后第一步（close）——这正是分档里最难的一档
          if (mocks.failCloseAfterRekey) mocks.closeThrowLeft = 1
          if (mocks.failRekey) throw new Error('rekey failed')
        }
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
    disableRecovery: () => { mocks.seq.push('disableRecovery') },
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
  mocks.failPlainOpenTimes = 0
  mocks.failCloseAfterRekey = false
  mocks.closeThrowLeft = 0
  mocks.opened = true
  mocks.cfg.salt = Buffer.alloc(16, 1)
  mocks.cfg.kdf = { N: 32768, r: 8, p: 1 }
  mocks.cfg.mode = 'none'
  mocks.cfg.hasPw = false
  // 桩里的 mode/masterKey 是模块级状态：commit 现在会 setRawKey(mode='db') ⇒ 每条用例前必须复位
  masterKeyManager.clear()
  ;(masterKeyManager as unknown as { __setMode: (m: 'none' | 'db') => void }).__setMode('none')
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
    expect(r.error).toContain('未完成')
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
    expect(r.error).toContain('未写入配置')
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

// §310：禁用加密此前把"改库＋改配置"整段裸着（既没 catch 也没分档），抛错就留下
// 「库关着＋config 说要密码」的半状态——本会话 IPC 全挂，下次启动走 unlock 分支开不了明文库。
// `rekey = ''` 是不可逆点，所以两种半状态要分开钉：越过之前能真回滚，越过之后只能把禁用做完。
describe('ENCRYPTION_DISABLE：以 rekey 为不可逆点分两档收尾', () => {
  beforeEach(() => {
    mocks.cfg.mode = 'db'
    mocks.cfg.hasPw = true
    const mgr = masterKeyManager as unknown as { __setMode: (m: string) => void; setRawKey: (k: Buffer) => void }
    mgr.__setMode('db')
    mgr.setRawKey(Buffer.alloc(32, 4))
    mocks.seq = []
  })

  it('正向对照：一次做完 ⇒ 库按无密重开、config 四条落齐、凭据与恢复码尾巴照跑', async () => {
    const r = (await call(IPC.ENCRYPTION_DISABLE, OLD_PW)) as { ok: boolean }
    expect(r.ok).toBe(true)
    const seq = mocks.seq
    const rekeyAt = seq.indexOf('pragma:rekey')
    expect(rekeyAt).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf('init:none')).toBeGreaterThan(rekeyAt)
    expect(seq.lastIndexOf('open:plain')).toBeGreaterThan(rekeyAt)
    expect(seq.indexOf('setMode:none')).toBeGreaterThan(rekeyAt)
    // 凭据必须按固定密钥重裹（跳过这一步＝下次启动全解不开，界面上像 Key 全没了）
    expect(seq).toContain('restoreSnapshot')
    expect(seq).toContain('disableRecovery')
    expect(mocks.cfg.mode).toBe('none')
    expect(mocks.cfg.hasPw).toBe(false)
    expect(mocks.cfg.salt).toBeNull()
    expect(mocks.cfg.kdf).toBeNull()
  })

  it('抛在不可逆点之前（rekey 自己失败）⇒ 真回滚：旧密钥回到会话、配置一个字节不写', async () => {
    mocks.failRekey = true
    const r = (await call(IPC.ENCRYPTION_DISABLE, OLD_PW)) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('库与配置都未改动')
    const seq = mocks.seq
    expect(seq).toContain('setRawKey') // 回滚持钥
    expect(seq[seq.length - 1]).toBe('open:withKey') // 用旧密钥把会话重新打开
    expect(seq).not.toContain('init:none')
    expect(seq).not.toContain('setMode:none')
    expect(seq).not.toContain('setHasPw:false')
    expect(seq).not.toContain('clearSalt')
    expect(seq).not.toContain('restoreSnapshot')
    expect(mocks.cfg.mode).toBe('db')
    expect(mocks.cfg.hasPw).toBe(true)
    expect(mocks.cfg.salt).not.toBeNull()
  })

  it('越过不可逆点后才抛（无密开库失败一次）⇒ 不退旧密钥，重试开库并把禁用做完', async () => {
    mocks.failPlainOpenTimes = 1
    const r = (await call(IPC.ENCRYPTION_DISABLE, OLD_PW)) as { ok: boolean; error?: string }
    expect(r.ok, r.error).toBe(true)
    const seq = mocks.seq
    const rekeyAt = seq.indexOf('pragma:rekey')
    expect(rekeyAt).toBeGreaterThanOrEqual(0)
    // 库已是明文：拿旧主密钥重开必然再失败 ⇒ 这一档绝不许出现 setRawKey（错修"一律当真回滚处理"就红在这）
    expect(seq).not.toContain('setRawKey')
    expect(seq.filter((s) => s === 'open:plain').length).toBeGreaterThanOrEqual(2) // 抛一次 + 补齐一次
    expect(seq.indexOf('setMode:none')).toBeGreaterThan(rekeyAt)
    expect(seq).toContain('setHasPw:false')
    expect(seq).toContain('restoreSnapshot') // 凭据按固定密钥重裹过，下次启动才解得开
    expect(seq).toContain('disableRecovery')
    expect(mocks.cfg.mode).toBe('none')
    expect(mocks.cfg.hasPw).toBe(false)
  })

  it('抛在"库已明文、还没切无密模式"那一步（close 失败）⇒ 补齐分支自己切模式，会话不许留着旧主密钥', async () => {
    mocks.failCloseAfterRekey = true
    const r = (await call(IPC.ENCRYPTION_DISABLE, OLD_PW)) as { ok: boolean; error?: string }
    expect(r.ok, r.error).toBe(true)
    const seq = mocks.seq
    const rekeyAt = seq.indexOf('pragma:rekey')
    expect(rekeyAt).toBeGreaterThanOrEqual(0)
    expect(seq).not.toContain('setRawKey')
    // 这一档的 `init:none` 是补齐分支自己发的（try 里那句还没跑到）——删掉它，会话就留着旧主密钥、
    // 而库已是明文：字段密钥与"是否加密"两处读数一起说谎（V4-Iter-195 的同族）
    expect(seq.filter((s) => s === 'init:none').length).toBeGreaterThanOrEqual(1)
    expect(seq.indexOf('setMode:none')).toBeGreaterThan(rekeyAt)
    expect(masterKeyManager.getMode()).toBe('none')
    expect(masterKeyManager.isDbEncrypted()).toBe(false)
    expect(mocks.cfg.mode).toBe('none')
    expect(mocks.cfg.hasPw).toBe(false)
  })

  it('补齐也做不完（开库一直失败）⇒ 明说"没有一次做完"，不许留下半个不加密标记', async () => {
    mocks.failPlainOpenTimes = 99
    const r = (await call(IPC.ENCRYPTION_DISABLE, OLD_PW)) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有一次做完')
    const seq = mocks.seq
    // 库没开 ⇒ config 写不了、凭据也不许重裹（否则密文换了钥而标记还是旧的＝第二种半状态）
    expect(seq).not.toContain('setMode:none')
    expect(seq).not.toContain('setHasPw:false')
    expect(seq).not.toContain('restoreSnapshot')
    expect(seq).not.toContain('disableRecovery')
    expect(mocks.cfg.mode).toBe('db')
    expect(mocks.cfg.hasPw).toBe(true)
  })
})
