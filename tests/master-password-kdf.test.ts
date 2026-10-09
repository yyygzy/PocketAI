// SEC-32②：档位编排（验证逐档重试、marker 自愈、新设成对落盘）
//
// 覆盖 src/main/crypto/master-password.ts。dbService 与 appConfigRepo 都用桩：
// 「库到底吃哪一档」由测试里的 expectedKey 决定，正好模拟出
// 「config.json 的档位记录与真实库不符」这一必须不锁死用户的情形。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

// ---- 桩：appConfigRepo（只用到档位/salt 四个方法） ----
const store = vi.hoisted(() => ({
  kdf: null as { N: number; r: number; p: number } | null,
  salt: null as Buffer | null,
  setKdfCalls: [] as Array<{ N: number; r: number; p: number }>
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getKdfParams: () => store.kdf ?? { N: 32768, r: 8, p: 1 },
    setKdfParams: (p: { N: number; r: number; p: number }) => {
      store.kdf = p
      store.setKdfCalls.push(p)
    },
    getMasterPasswordSalt: () => store.salt,
    setMasterPasswordSalt: (s: Buffer) => {
      store.salt = s
    }
  }
}))

// ---- 桩：dbService（open 只接受 expectedKey，否则抛 = 模拟密钥不匹配） ----
const db = vi.hoisted(() => ({
  expectedKey: null as Buffer | null,
  openCalls: 0,
  isOpen: false
}))
vi.mock('../src/main/db/database', () => ({
  dbService: {
    close: () => {
      db.isOpen = false
    },
    open: (key?: Buffer) => {
      db.openCalls++
      if (!key || !db.expectedKey || !key.equals(db.expectedKey)) throw new Error('file is not a database')
      db.isOpen = true
    },
    isOpen: () => db.isOpen,
    getHandle: () => ({
      prepare: () => ({ get: () => (db.isOpen ? 1 : (() => { throw new Error('closed') })()) })
    })
  }
}))

import { deriveKeySync, KDF_CURRENT, KDF_LEGACY } from '../src/main/crypto/index'
import { masterKeyManager } from '../src/main/crypto/master-key'
import { issueNewMasterKey, kdfCandidates, kdfStatus, verifyAndOpenMasterKey } from '../src/main/crypto/master-password'

const PW = 'a-long-master-passphrase'

beforeEach(() => {
  store.kdf = null
  store.salt = null
  store.setKdfCalls = []
  db.expectedKey = null
  db.openCalls = 0
  db.isOpen = false
  masterKeyManager.clear()
})

describe('kdfCandidates', () => {
  it('无记录时先试历史档（绝大多数存量库），再试现行档', () => {
    expect(kdfCandidates()).toEqual([KDF_LEGACY, KDF_CURRENT])
  })

  it('记录为现行档时先试现行档', () => {
    store.kdf = KDF_CURRENT
    expect(kdfCandidates()).toEqual([KDF_CURRENT, KDF_LEGACY])
  })
})

describe('verifyAndOpenMasterKey', () => {
  it('档位记录正确 ⇒ 一次派生就开库，不做多余重试', () => {
    store.salt = randomBytes(16)
    db.expectedKey = deriveKeySync(PW, store.salt, KDF_LEGACY).key
    store.kdf = KDF_LEGACY
    const setKeySpy = vi.spyOn(masterKeyManager, 'setKey')
    expect(verifyAndOpenMasterKey(PW)).toEqual(KDF_LEGACY)
    expect(setKeySpy.mock.calls.length).toBe(1)
    setKeySpy.mockRestore()
  })

  it('记录与真实库不符 ⇒ 逐档试出来并把正确档位写回去（marker 丢失不锁死）', () => {
    store.salt = randomBytes(16)
    // 库其实是现行档派生的，但 config.json 里还写着历史档
    db.expectedKey = deriveKeySync(PW, store.salt, KDF_CURRENT).key
    store.kdf = KDF_LEGACY
    expect(verifyAndOpenMasterKey(PW)).toEqual(KDF_CURRENT)
    expect(store.kdf).toEqual(KDF_CURRENT)
    expect(store.setKdfCalls).toEqual([KDF_CURRENT])
  })

  it('密码错误 ⇒ 返回 null，两个档位都试过，库保持关闭', () => {
    store.salt = randomBytes(16)
    db.expectedKey = deriveKeySync('some-other-password', store.salt, KDF_LEGACY).key
    const setKeySpy = vi.spyOn(masterKeyManager, 'setKey')
    expect(verifyAndOpenMasterKey(PW)).toBeNull()
    expect(setKeySpy.mock.calls.length).toBe(2)
    expect(db.isOpen).toBe(false)
    setKeySpy.mockRestore()
  })

  it('库文件本身损坏（永远打不开）⇒ 不把损坏误报成档位问题以外的东西，仍返回 null', () => {
    store.salt = randomBytes(16)
    db.expectedKey = null
    expect(verifyAndOpenMasterKey(PW)).toBeNull()
  })
})

describe('issueNewMasterKey（新设/改密/恢复码重置共用）', () => {
  it('salt 与档位成对落盘，且返回的密钥确实是现行档派生的', () => {
    const key = issueNewMasterKey(PW)
    expect(store.kdf).toEqual(KDF_CURRENT)
    expect(store.salt).not.toBeNull()
    expect(store.salt!.length).toBe(16)
    expect(key.equals(deriveKeySync(PW, store.salt!, KDF_CURRENT).key)).toBe(true)
  })

  it('落盘档位可被 kdfStatus 读出（设置页显示链路）', () => {
    issueNewMasterKey(PW)
    expect(kdfStatus()).toEqual({ N: KDF_CURRENT.N, atCurrent: true })
    store.kdf = KDF_LEGACY
    expect(kdfStatus()).toEqual({ N: KDF_LEGACY.N, atCurrent: false })
  })

  it('新 salt 每次不同（同一密码两次设密得到不同密钥）', () => {
    const k1 = issueNewMasterKey(PW)
    const s1 = store.salt
    const k2 = issueNewMasterKey(PW)
    expect(s1!.equals(store.salt!)).toBe(false)
    expect(k1.equals(k2)).toBe(false)
  })
})
