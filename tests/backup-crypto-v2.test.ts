// 加密备份包 v1/v2 信封解密测试（异机恢复密码支持）
//
// 手工按 encryptBackup 的组装公式构造 PKBK1/PKBK2 blob，
// 验证：同机当前密钥解密、异机密码解密、错密重试、旧包异机拒绝、DB key 派生。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createCipheriv, randomBytes, createHash } from 'node:crypto'

// backup-service 顶层 import 重依赖（dbService/portable/webdav 等会拉入 electron），
// 全部 mock；master-key 与 crypto/index 是纯内存/纯 crypto 实现，保留真实行为
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '' }))
vi.mock('../src/main/crypto/field-encrypt', () => ({
  encryptApiKeys: () => '', decryptApiKeys: () => '', isCipherText: () => false
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {}, getMasterPasswordSalt: () => null },
  clearAppConfigCache: () => {}
}))
vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async () => true,
  uploadBuffer: async () => ({}),
  downloadFile: async () => Buffer.alloc(0),
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async () => false,
  uploadRemoteBuffer: async () => ({}),
  downloadRemoteFile: async () => Buffer.alloc(0)
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))

import {
  decryptBackup,
  deriveBackupDbKey,
  isEncryptedBlob,
  ENC_PREFIX_V1,
  ENC_PREFIX_V2,
  BackupDecryptError
} from '../src/main/backup/backup-service'
import { masterKeyManager } from '../src/main/crypto/master-key'
import { deriveKeySync } from '../src/main/crypto/index'

const PLAINTEXT = Buffer.from('hello-pocketai-backup-zip-payload')

/** 按生产公式构造加密包（version=2 时携带 masterSalt） */
function makeBlob(opts: { version: 1 | 2; password: string; masterSalt: Buffer; backupSalt?: Buffer }): Buffer {
  const backupSalt = opts.backupSalt ?? randomBytes(16)
  const baseKey = deriveKeySync(opts.password, opts.masterSalt).key
  const encKey = createHash('sha256').update(baseKey).update(backupSalt).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey, iv)
  const ct = Buffer.concat([cipher.update(PLAINTEXT), cipher.final()])
  const tag = cipher.getAuthTag()
  return opts.version === 2
    ? Buffer.concat([Buffer.from(ENC_PREFIX_V2), iv, backupSalt, opts.masterSalt, tag, ct])
    : Buffer.concat([Buffer.from(ENC_PREFIX_V1), iv, backupSalt, tag, ct])
}

function backupSaltOf(blob: Buffer): Buffer {
  return blob.subarray(5 + 12, 5 + 12 + 16)
}

describe('加密备份包 v2（携带 masterSalt）', () => {
  const masterSalt = randomBytes(16)
  const password = 'back-up-pass-短语'

  beforeEach(() => {
    // 默认会话持有的是「另一台机器」的不同密钥
    masterKeyManager.setRawKey(deriveKeySync('different-current-password', randomBytes(16)).key)
  })

  it('异机：凭备份密码解密成功，明文一致', () => {
    const blob = makeBlob({ version: 2, password, masterSalt })
    const out = decryptBackup(blob, backupSaltOf(blob), { password })
    expect(out.equals(PLAINTEXT)).toBe(true)
  })

  it('异机：错误密码抛 badPassword（供 UI 重试）', () => {
    const blob = makeBlob({ version: 2, password, masterSalt })
    expect(() => decryptBackup(blob, backupSaltOf(blob), { password: 'wrong' }))
      .toThrow(BackupDecryptError)
    try {
      decryptBackup(blob, backupSaltOf(blob), { password: 'wrong' })
    } catch (e) {
      expect((e as BackupDecryptError).code).toBe('badPassword')
    }
  })

  it('deriveBackupDbKey = scrypt(password, 包内 masterSalt)', () => {
    const blob = makeBlob({ version: 2, password, masterSalt })
    expect(deriveBackupDbKey(blob, password).equals(deriveKeySync(password, masterSalt).key)).toBe(true)
  })

  it('同机：会话密钥恰好匹配时，不传密码也能解密', () => {
    masterKeyManager.setRawKey(deriveKeySync(password, masterSalt).key)
    const blob = makeBlob({ version: 2, password, masterSalt })
    expect(decryptBackup(blob, backupSaltOf(blob)).equals(PLAINTEXT)).toBe(true)
  })

  it('isEncryptedBlob 同时识别 v1/v2 前缀', () => {
    const v2 = makeBlob({ version: 2, password, masterSalt })
    const v1 = makeBlob({ version: 1, password, masterSalt })
    expect(isEncryptedBlob(v2, 'x.zip')).toBe(true)
    expect(isEncryptedBlob(v1, 'x.zip')).toBe(true)
    expect(isEncryptedBlob(Buffer.from('not a backup'), 'plain.zip')).toBe(false)
  })
})

describe('加密备份包 v1（旧格式兼容）', () => {
  it('传备份密码异机恢复时抛 legacyNoCross，而不是尝试解密', () => {
    const masterSalt = randomBytes(16)
    const blob = makeBlob({ version: 1, password: 'old-pass', masterSalt })
    try {
      decryptBackup(blob, backupSaltOf(blob), { password: 'old-pass' })
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BackupDecryptError)
      expect((e as BackupDecryptError).code).toBe('legacyNoCross')
    }
  })

  it('同机：当前会话 DB key 可解密 v1 旧包（向后兼容）', () => {
    const masterSalt = randomBytes(16)
    const password = 'same-machine-pass'
    masterKeyManager.setRawKey(deriveKeySync(password, masterSalt).key)
    const blob = makeBlob({ version: 1, password, masterSalt })
    expect(decryptBackup(blob, backupSaltOf(blob)).equals(PLAINTEXT)).toBe(true)
  })
})
