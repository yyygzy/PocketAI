// SEC-32② 的连带后果：主密码升档后，异机备份恢复必须仍然可用
//
// 备份信封 PKBK2 没有档位字段，而 baseKey 必须等于源机当时的 DB key。
// 主密码从 2^15 升到 2^17 后，若仍只按历史档派生，异机会报「备份密码错误」
// —— 数据备份得出来却恢复不回去。这里用测试侧自造的信封钉住逐档重试。
import { describe, it, expect, vi } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getDbKey: () => null, getFieldKey: () => null, hasKey: () => false }
}))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '' }))
vi.mock('../src/main/crypto/field-encrypt', () => ({
  encryptApiKeys: () => '', decryptApiKeys: () => '', isCipherText: () => false
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} },
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

import { decryptBackup, deriveBackupDbKey, BackupDecryptError, ENC_PREFIX_V2, ENC_PREFIX_V1 } from '../src/main/backup/backup-service'
import { deriveKeySync, KDF_LEGACY, KDF_CURRENT, type KdfParams } from '../src/main/crypto/index'

const PW = 'a-long-master-passphrase'
// N=2^17 单次派生实测约 0.7-1.5s，全量并行跑时会顶到 vitest 默认 5s 超时
const HEAVY_TIMEOUT = 30_000

/** 按 encryptBackup 的字节布局自造 v2 信封（档位可控，模拟源机当时用的档） */
function makeEnvelope(tier: KdfParams, password: string, plain: Buffer): { blob: Buffer; backupSalt: Buffer; masterSalt: Buffer } {
  const masterSalt = randomBytes(16)
  const backupSalt = randomBytes(16)
  const baseKey = deriveKeySync(password, masterSalt, tier).key
  const encKey = createHash('sha256').update(baseKey).update(backupSalt).digest()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', encKey, iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  const tag = c.getAuthTag()
  const blob = Buffer.concat([Buffer.from(ENC_PREFIX_V2), iv, backupSalt, masterSalt, tag, ct])
  return { blob, backupSalt, masterSalt }
}

describe('异机备份恢复与主密码档位', () => {
  it('历史档（2^15）源机产出的备份：照旧可解（存量备份不受害）', () => {
    const plain = Buffer.from('manifest-json-v15')
    const { blob, backupSalt } = makeEnvelope(KDF_LEGACY, PW, plain)
    expect(decryptBackup(blob, backupSalt, { password: PW }).equals(plain)).toBe(true)
  })

  it('升档后（2^17）源机产出的备份：异机仍能解（本次发现的回归）', () => {
    const plain = Buffer.from('manifest-json-v17')
    const { blob, backupSalt } = makeEnvelope(KDF_CURRENT, PW, plain)
    expect(decryptBackup(blob, backupSalt, { password: PW }).equals(plain)).toBe(true)
  }, HEAVY_TIMEOUT)

  it('deriveBackupDbKey 对 2^17 备份返回源机那把 DB key（恢复后要 setRawKey 打开还原库）', () => {
    const { blob, masterSalt } = makeEnvelope(KDF_CURRENT, PW, Buffer.from('x'))
    // 只调用一次：这本身就是 2^17 派生，全量跑时容易顶到默认 5s 超时
    const got = deriveBackupDbKey(blob, PW)
    expect(got.equals(deriveKeySync(PW, masterSalt, KDF_CURRENT).key)).toBe(true)
    expect(got.equals(deriveKeySync(PW, masterSalt, KDF_LEGACY).key)).toBe(false)
  }, HEAVY_TIMEOUT)

  it('密码错 ⇒ badPassword；**档位记忆不得绕过密码校验**', () => {
    // 先用正确密码跑一次，把该 masterSalt 的档位记进缓存
    const { blob, backupSalt } = makeEnvelope(KDF_CURRENT, PW, Buffer.from('secret'))
    expect(decryptBackup(blob, backupSalt, { password: PW }).toString()).toBe('secret')
    // 同一 masterSalt、同一 blob 再来一次（走缓存命中路径）：换密码必须仍然失败
    expect(() => decryptBackup(blob, backupSalt, { password: 'totally-different' })).toThrow(/备份密码错误/)
    // 缓存过档位也不能让「另一个用错密码造的包」被误接受
    expect(() => decryptBackup(blob, backupSalt, { password: '' })).toThrow(BackupDecryptError)
  }, HEAVY_TIMEOUT)

  it('v1 备份包不带 masterSalt ⇒ 依旧明确拒绝异机（不静默当成密码错）', () => {
    const baseKey = deriveKeySync(PW, randomBytes(16), KDF_LEGACY).key
    const backupSalt = randomBytes(16)
    const encKey = createHash('sha256').update(baseKey).update(backupSalt).digest()
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', encKey, iv)
    const ct = Buffer.concat([c.update(Buffer.from('v1')), c.final()])
    const blob = Buffer.concat([Buffer.from(ENC_PREFIX_V1), iv, backupSalt, c.getAuthTag(), ct])
    try {
      decryptBackup(blob, backupSalt, { password: PW })
      expect.unreachable('应当抛 legacyNoCross')
    } catch (e) {
      expect(e).toBeInstanceOf(BackupDecryptError)
      expect((e as BackupDecryptError).code).toBe('legacyNoCross')
    }
  })
})
