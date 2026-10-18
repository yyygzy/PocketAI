// V4-Iter-187：boot 解锁「两趟并一趟」的接线与语义
//
// 现状（改前）：ipc/handlers/encryption.ts 的 boot 分支先在 handler 内 verifyAndOpenMasterKey 预验证
// （为的是 SEC-10——旧行为"密码错就弹原生框 + app.quit"，限流桶永远计不到数），验完 close() 再 submit({password})；
// boot 在 index.ts 收到载荷后**又验一趟**。本机实测两行 [perf] 714ms + 703ms，sqlite-vec 也因此加载两次。
//
// 改后：预验证成功 ⇒ submit 带 preverified 令牌；boot 只在「令牌在场 且 内存里确有密钥」时跳过第二趟。
// 这里盯三件事：① 第二趟真的少了（用调用次数证，不靠读日志）；② 失败/异常态**不许**发令牌；
// ③ 限流与重试的语义一字未动（失败仍计数、仍不 submit）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  seq: [] as string[],
  verifyCalls: 0,
  verifyOk: true,
  dbOpen: false,
  coordinatorWaiting: true,
  submitted: [] as unknown[],
  hasKey: true,
  rate: { allowed: true, retryAfterMs: 0, attempts: 0 }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => mocks.handlers.set(ch, fn) },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: { showErrorBox: () => {} },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    isOpen: () => mocks.dbOpen,
    getEncryptionMode: () => 'db',
    open: () => { mocks.seq.push('open') },
    close: () => { mocks.seq.push('close') },
    runMigrations: () => {},
    getHandle: () => ({ prepare: () => ({ get: () => 1, all: () => [], run: () => {} }), pragma: () => [] })
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getKdfParams: () => ({ N: 131072, r: 8, p: 1 }),
    setKdfParams: () => {},
    getMasterPasswordSalt: () => Buffer.alloc(16, 1),
    get: () => null,
    set: () => {},
    delete: () => {}
  },
  clearAppConfigCache: () => {}
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    init: () => {},
    setKey: () => Buffer.alloc(32, 7),
    setRawKey: () => {},
    getDbKey: () => Buffer.alloc(32, 7),
    getFieldKey: () => Buffer.alloc(32, 7),
    generateSalt: () => Buffer.alloc(16, 3),
    getMode: () => 'db',
    isDbEncrypted: () => true,
    hasKey: () => mocks.hasKey,
    clear: () => { mocks.hasKey = false }
  }
}))

// 被测的那一趟"预验证"就在这个函数里——用调用次数当证据
vi.mock('../src/main/crypto/master-password', () => ({
  verifyAndOpenMasterKey: () => {
    mocks.verifyCalls++
    mocks.seq.push('verify')
    return mocks.verifyOk ? { N: 131072, r: 8, p: 1 } : null
  },
  prepareNewMasterKey: () => ({ key: Buffer.alloc(32), salt: Buffer.alloc(16), params: { N: 131072, r: 8, p: 1 } }),
  commitNewMasterKeyState: () => {},
  kdfStatus: () => ({ N: 131072, atCurrent: true })
}))

// 只换掉那个单例（要捕获 submit 的载荷），**保留模块里的纯函数 bootNeedsReverify**——
// 整模块 mock 会把待测函数一起抹成 undefined（推广十.1 那个坑，这次我自己踩了一遍）
vi.mock('../src/main/crypto/unlock-coordinator', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/crypto/unlock-coordinator')>()
  return {
    ...real,
    unlockCoordinator: {
      isWaiting: () => mocks.coordinatorWaiting,
      submit: (r: unknown) => { mocks.submitted.push(r) },
      waitForUnlock: async () => null
    }
  }
})

vi.mock('../src/main/crypto/auth-ratelimit', () => ({
  authRateLimiter: {
    check: () => mocks.rate,
    fail: () => { mocks.seq.push('rateFail'); return { retryAfterMs: 0, attempts: 1 } },
    reset: () => { mocks.seq.push('rateReset') }
  },
  AUTH_BUCKET: { UNLOCK: 'unlock', RECOVER: 'recover' }
}))

vi.mock('../src/main/crypto/credential-rotation', () => ({ exportFieldCredentials: () => ({}), restoreFieldCredentials: () => {} }))
vi.mock('../src/main/crypto/recovery-key', () => ({
  recoveryKeyManager: { hasRecovery: () => false, enableRecovery: () => 'X', disableRecovery: () => {}, recoverMasterKey: () => Buffer.alloc(32) }
}))
vi.mock('../src/main/crypto/clipboard-guard', () => ({ clipboardGuard: { purge: () => {} } }))
vi.mock('../src/main/lock/lock', () => ({
  lockService: { lock: () => {}, unlock: () => { mocks.seq.push('lockUnlock') }, getStatus: () => ({ state: 'unlocked' }), setAutoTimeout: () => {}, markActive: () => {}, onStateChange: () => {} }
}))
vi.mock('../src/main/net/external-links', () => ({ denyNewWindows: () => {} }))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }) }))
vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => null,
  saveWebDAVConfig: () => {},
  deriveKeySync: () => Buffer.alloc(32),
  ENC_PREFIX: 'PKBK1',
  isEncryptedBlob: () => false,
  decryptBackup: () => Buffer.alloc(0),
  BackupDecryptError: class extends Error {}
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../src/shared/types'
import { registerEncryptionHandlers } from '../src/main/ipc/handlers/encryption'
import { bootNeedsReverify } from '../src/main/crypto/unlock-coordinator'

const eventStub = { sender: {} }
const PW = 'boot-password-long-enough'

// safeHandle 把返回值包成 Promise（失败也是**返回值**不是 rejection），所以必须 await
async function callUnlock(): Promise<Record<string, any>> {
  const fn = mocks.handlers.get(IPC.ENCRYPTION_UNLOCK)
  if (!fn) throw new Error('ENCRYPTION_UNLOCK 没注册')
  return (await fn(eventStub, PW)) as Record<string, any>
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.seq = []
  mocks.verifyCalls = 0
  mocks.verifyOk = true
  mocks.dbOpen = false
  mocks.coordinatorWaiting = true
  mocks.submitted = []
  mocks.hasKey = true
  mocks.rate = { allowed: true, retryAfterMs: 0, attempts: 0 }
  registerEncryptionHandlers()
})

describe('① bootNeedsReverify 的判据（令牌 + 实际持钥，两个条件缺一不可）', async () => {
  it('预验证过且内存里确有密钥 ⇒ 不再重验（省掉的就是这一趟 ~0.7s）', async () => {
    expect(bootNeedsReverify({ password: PW, preverified: true }, true)).toBe(false)
  })

  it('令牌在场但密钥已被 clear ⇒ 回退成"自己再验一趟"（令牌不许与实际状态脱钩）', async () => {
    expect(bootNeedsReverify({ password: PW, preverified: true }, false)).toBe(true)
  })

  it('没有令牌（异常态走的就是这种载荷）⇒ 必须重验', async () => {
    expect(bootNeedsReverify({ password: PW }, true)).toBe(true)
  })
})

describe('② handler 的 boot 分支：只验一趟，且令牌只在真验过之后发', async () => {
  it('密码正确：verifyAndOpenMasterKey 被调 **1 次**、submit 带 preverified、close 后交棒、限流 reset 而不计数', async () => {
    const r = await callUnlock()
    expect(r.ok).toBe(true)
    expect(mocks.verifyCalls, '预验证应当且只应当跑一趟').toBe(1)
    expect(mocks.submitted).toEqual([{ password: PW, preverified: true }])
    expect(mocks.seq).toEqual(['verify', 'close', 'rateReset'])
  })

  it('密码错误：仍然只验一趟，但**不许** submit（boot 还在等），且限流计一次失败', async () => {
    mocks.verifyOk = false
    const r = await callUnlock()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('密码错误')
    expect(mocks.verifyCalls).toBe(1)
    expect(mocks.submitted, '失败时绝不能把口令交给 boot').toEqual([])
    expect(mocks.seq).toContain('rateFail')
    expect(mocks.seq).not.toContain('rateReset')
  })

  it('异常态（库已能明文打开）：不预验证，载荷**不带**令牌 ⇒ boot 仍自己验一趟', async () => {
    mocks.dbOpen = true
    const r = await callUnlock()
    expect(r.ok).toBe(true)
    expect(mocks.verifyCalls, '这条分支上 handler 不该动库').toBe(0)
    expect(mocks.submitted).toEqual([{ password: PW }])
    expect(mocks.submitted[0]).not.toHaveProperty('preverified')
  })

  it('限流闸挡住时：连预验证都不发生，也不 submit', async () => {
    mocks.rate = { allowed: false, retryAfterMs: 30_000, attempts: 5 }
    const r = await callUnlock()
    expect(r.locked).toBe(true)
    expect(r.error).toBe('尝试过于频繁，请稍后再试')
    expect(mocks.verifyCalls).toBe(0)
    expect(mocks.submitted).toEqual([])
  })

  it('运行时解锁（boot 不在等）：走另一条支路，仍然验一趟、不 submit', async () => {
    mocks.coordinatorWaiting = false
    const r = await callUnlock()
    expect(r.ok).toBe(true)
    expect(mocks.verifyCalls).toBe(1)
    expect(mocks.submitted).toEqual([])
    expect(mocks.seq).toContain('lockUnlock')
  })
})

describe('③ 接线：两处改动都必须在真正的调用点上（scan）', async () => {
  const MAIN = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const HANDLER = readFileSync(join(process.cwd(), 'src/main/ipc/handlers/encryption.ts'), 'utf8')

  it('index.ts 的 boot 分支用 bootNeedsReverify 包住那次派生（不是把兜底整段删掉）', async () => {
    expect(MAIN).toContain('bootNeedsReverify(result, masterKeyManager.hasKey())')
    // 兜底仍在：boot 里那次 verifyAndOpenMasterKey 调用不能消失
    expect(MAIN).toContain('verifyAndOpenMasterKey(result.password)')
  })

  it('encryption.ts 只在预验证成功后发令牌（三元发法，异常态走不带令牌那支）', async () => {
    expect(HANDLER).toContain('unlockCoordinator.submit(preverified ? { password, preverified: true } : { password })')
  })
})
