// 合并恢复异机密码路由测试：scanMergeConflicts 的解密三态映射
//
// 云库在临时文件落盘/打开之前就必须先解密外层包，因此用构造的 PKBK1/PKBK2
// 信封 + mock WebDAV 下载，验证扫描结果在「打开云库」之前即返回正确 code：
// needBackupPassword / badPassword / legacyNoCross；明文包则不报解密 code。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createCipheriv, createHash } from 'node:crypto'

let nextDownload: Buffer = Buffer.alloc(0)

vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: { Open: { buffer: async () => { throw new Error('bad zip') } } } }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '' }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {}, getMasterPasswordSalt: () => null },
  clearAppConfigCache: () => {}
}))
vi.mock('../src/main/crypto/field-encrypt', () => ({
  encryptApiKeys: () => '', decryptApiKeys: () => '', isCipherText: () => false
}))
vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: async () => nextDownload,
  downloadRemoteFile: async () => nextDownload
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))

// 当前会话持有「本机」密钥（与备份包不同），使无密码路径走到 GCM 失败
const currentKey = Buffer.alloc(32, 9)
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getDbKey: () => currentKey, setRawKey: () => {}, setKey: () => {} }
}))

import { scanMergeConflicts } from '../src/main/backup/merge-service'
import { deriveKeySync } from '../src/main/crypto/index'
import { ENC_PREFIX_V1, ENC_PREFIX_V2 } from '../src/main/backup/backup-service'
import type { WebDAVConfig } from '../src/shared/types'

const cfg: WebDAVConfig = { url: 'https://dav.example.com/backup', username: 'u', passwordCipher: 'p', directory: '/b' }

/** 构造合法 PKBK2 信封（内容任意，GCM 可解） */
function makeEnvelope(version: 1 | 2, password: string, masterSalt: Buffer): Buffer {
  const backupSalt = randomBytes(16)
  const baseKey = deriveKeySync(password, masterSalt).key
  const encKey = createHash('sha256').update(baseKey).update(backupSalt).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from('payload')), cipher.final()])
  const tag = cipher.getAuthTag()
  return version === 2
    ? Buffer.concat([Buffer.from(ENC_PREFIX_V2), iv, backupSalt, masterSalt, tag, ct])
    : Buffer.concat([Buffer.from(ENC_PREFIX_V1), iv, backupSalt, tag, ct])
}

describe('scanMergeConflicts 异机密码路由', () => {
  beforeEach(() => {
    nextDownload = Buffer.alloc(0)
  })

  it('PKBK2 增量包 + 无密码：返回 needBackupPassword', async () => {
    nextDownload = makeEnvelope(2, 'back-up-pwd', randomBytes(16))
    const r = await scanMergeConflicts(cfg, 'pocketai-inc-2026-09-26.json.enc.zip')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('needBackupPassword')
  })

  it('PKBK2 增量包 + 错误密码：返回 badPassword（可重试）', async () => {
    nextDownload = makeEnvelope(2, 'back-up-pwd', randomBytes(16))
    const r = await scanMergeConflicts(cfg, 'pocketai-inc-2026-09-26.json.enc.zip', { backupPassword: 'wrong' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('badPassword')
  })

  it('PKBK1 旧增量包 + 备份密码：返回 legacyNoCross', async () => {
    nextDownload = makeEnvelope(1, 'old-pwd', randomBytes(16))
    const r = await scanMergeConflicts(cfg, 'pocketai-inc-2026-01-01.json.enc.zip', { backupPassword: 'old-pwd' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('legacyNoCross')
  })

  it('PKBK2 全量包 + 无密码：zip 解密阶段返回 needBackupPassword', async () => {
    nextDownload = makeEnvelope(2, 'back-up-pwd', randomBytes(16))
    const r = await scanMergeConflicts(cfg, 'pocketai-full-2026-09-26.enc.zip')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('needBackupPassword')
  })

  it('明文包（非加密、损坏 zip）：普通错误，不带密码 code', async () => {
    nextDownload = Buffer.from('PK\x03\x04-broken')
    const r = await scanMergeConflicts(cfg, 'pocketai-full-2026-09-26.zip')
    expect(r.ok).toBe(false)
    expect(r.code).toBeUndefined()
  })
})
