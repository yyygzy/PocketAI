// 本地备份恢复路由测试：加密判定（扩展名 + 信封魔数）与密码三态
//
// restoreBackupBlob 的后半段（解压/替换 DB）依赖真实 SQLite，此处只验证
// 「读文件 → 加密识别 → 解密路由」：明文包必走到 ZIP 目录校验，
// 加密包在解密阶段以 needBackupPassword / badPassword 终止。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

vi.mock('archiver', () => ({ default: () => ({}) }))
// Open.buffer 恒 reject：明文路径会被 .catch(()=>null) 兜底为「无法读取 ZIP 目录」，
// 正好验证「明文包未尝试解密」这一路由
vi.mock('unzipper', () => ({ default: { Open: { buffer: async () => { throw new Error('bad zip') } } } }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}), close: () => {}, open: () => {}, runMigrations: () => {} } }))
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

// 模拟已解锁的 db 模式：持有固定 DB key，使错误密码走到 GCM 失败而非 unavailable
const fixedKey = Buffer.alloc(32, 7)
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getDbKey: () => fixedKey,
    hasKey: () => true,
    setRawKey: () => {},
    setKey: () => {}
  }
}))

import { restoreFromLocalFile } from '../src/main/backup/backup-service'
import { ENC_PREFIX_V2 } from '../src/main/backup/backup-service'

const tmpFiles: string[] = []
function writeTmp(name: string, data: Buffer): string {
  const p = join(tmpdir(), `pocketai-local-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`)
  writeFileSync(p, data)
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try { if (existsSync(p)) rmSync(p) } catch { /* ignore */ }
  }
})

describe('restoreFromLocalFile 加密判定与路由', () => {
  it('明文 .zip（含明文 zip 字节）不尝试解密，走到 ZIP 目录校验', async () => {
    const p = writeTmp('plain.zip', Buffer.from('PK\x03\x04-not-really-a-zip'))
    const r = await restoreFromLocalFile(p)
    expect(r.ok).toBe(false)
    expect(r.code).toBeUndefined()
    expect(r.error).toContain('ZIP')
  })

  it('结构完整的 PKBK2 信封 + .enc.zip：当前会话密钥 GCM 失败 → needBackupPassword', async () => {
    // 合法信封布局但 ct/tag 随机：无密码路径用当前 DB key 解密必失败
    const blob = Buffer.concat([
      Buffer.from(ENC_PREFIX_V2), randomBytes(12), randomBytes(16), randomBytes(16), randomBytes(16), randomBytes(40)
    ])
    const p = writeTmp('secret.enc.zip', blob)
    const r = await restoreFromLocalFile(p)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('needBackupPassword')
  })

  it('损坏字节 + .enc.zip 扩展名（无信封头）：报格式无效而非弹密码框', async () => {
    const p = writeTmp('garbage.enc.zip', randomBytes(80))
    const r = await restoreFromLocalFile(p)
    expect(r.ok).toBe(false)
    expect(r.code).toBeUndefined()
    expect(r.error).toContain('格式')
  })

  it('伪造 PKBK2 信封 + 错误备份密码 → badPassword（可重试）', async () => {
    // PKBK2(5)+iv12+backupSalt16+masterSalt16+tag16+ct，GCM 必然校验失败
    const blob = Buffer.concat([
      Buffer.from(ENC_PREFIX_V2), randomBytes(12), randomBytes(16), randomBytes(16), randomBytes(16), randomBytes(40)
    ])
    const p = writeTmp('fake.enc.zip', blob)
    const r = await restoreFromLocalFile(p, { backupPassword: 'wrong-pass' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('badPassword')
  })

  it('非加密内容却以 .enc.zip 结尾：强制走解密路径（防改后缀绕过）', async () => {
    const p = writeTmp('disguised.enc.zip', Buffer.from('PK\x03\x04-plaintext-content'))
    const r = await restoreFromLocalFile(p)
    expect(r.ok).toBe(false)
    // 明文内容当加密包解：信封头不是 PKBK → parseBackupEnvelope 抛「格式无效」unavailable 错误
    expect(r.code).toBeUndefined()
  })
})
