// backup-service 备份工具纯函数测试
//
// 覆盖 src/main/backup/backup-service.ts 的纯函数：
// - isSafeZipEntryName：zip slip 防护（拒绝 ../、绝对路径、盘符）
// - blobRelName：备份 blob 命名规则（db/att 前缀 + sha + .enc/.bin）
// - sha256Hex：sha256 十六进制摘要
// - isEncryptedBlob：魔数 PKBK1 或 .enc 后缀判断
// - toCreds：WebDAV 配置 → 凭据映射
//
// 策略：被测纯函数无运行时依赖，但 backup-service.ts 顶层 import 重依赖
// （archiver/unzipper/dbService/masterKeyManager 等），全部 mock 掉避免初始化崩溃。
import { describe, it, expect, vi } from 'vitest'

vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getDbKey: () => null, hasKey: () => false }
}))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '' }))
vi.mock('../src/main/crypto/field-encrypt', () => ({
  encryptApiKeys: () => '', decryptApiKeys: () => '', isCipherText: () => false
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} }
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
  isSafeZipEntryName,
  blobRelName,
  sha256Hex,
  isEncryptedBlob,
  toCreds,
  ENC_PREFIX
} from '../src/main/backup/backup-service'

describe('isSafeZipEntryName — zip slip 防护', () => {
  it('正常相对路径 → true', () => {
    expect(isSafeZipEntryName('app.db')).toBe(true)
    expect(isSafeZipEntryName('attachments/doc.pdf')).toBe(true)
    expect(isSafeZipEntryName('dir/sub/file.txt')).toBe(true)
  })

  it('.. 穿越 → false', () => {
    expect(isSafeZipEntryName('../app.db')).toBe(false)
    expect(isSafeZipEntryName('dir/../../etc/passwd')).toBe(false)
    expect(isSafeZipEntryName('a/../b')).toBe(false)
  })

  it('绝对路径（/ 开头）→ false', () => {
    expect(isSafeZipEntryName('/etc/passwd')).toBe(false)
    expect(isSafeZipEntryName('/app.db')).toBe(false)
  })

  it('Windows 盘符 → false', () => {
    expect(isSafeZipEntryName('C:\\Windows\\system32')).toBe(false)
    expect(isSafeZipEntryName('D:/data')).toBe(false)
  })

  it('空串 → false', () => {
    expect(isSafeZipEntryName('')).toBe(false)
  })

  it('反斜杠转正后校验', () => {
    // ..\.. 转正为 ../../ → 穿越
    expect(isSafeZipEntryName('..\\..\\secret')).toBe(false)
    // 正常反斜杠路径转正后合法
    expect(isSafeZipEntryName('attachments\\doc.pdf')).toBe(true)
  })
})

describe('blobRelName — 备份 blob 命名', () => {
  it('db 前缀 + 未加密 → .bin', () => {
    expect(blobRelName('db', 'abc123', false)).toBe('blobs/db-abc123.bin')
  })

  it('db 前缀 + 已加密 → .enc', () => {
    expect(blobRelName('db', 'abc123', true)).toBe('blobs/db-abc123.enc')
  })

  it('att 前缀 + 未加密 → .bin', () => {
    expect(blobRelName('att', 'def456', false)).toBe('blobs/att-def456.bin')
  })

  it('att 前缀 + 已加密 → .enc', () => {
    expect(blobRelName('att', 'def456', true)).toBe('blobs/att-def456.enc')
  })
})

describe('sha256Hex — sha256 十六进制摘要', () => {
  it('空 Buffer → e3b0c44...', () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('"hello" → 2cf24dba...', () => {
    expect(sha256Hex(Buffer.from('hello'))).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('不同输入 → 不同摘要', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')))
  })

  it('输出长度 64（256 bit = 64 hex）', () => {
    expect(sha256Hex(Buffer.from('test'))).toHaveLength(64)
  })
})

describe('isEncryptedBlob — 加密 blob 判断', () => {
  it('魔数匹配 → true', () => {
    const buf = Buffer.from(ENC_PREFIX + 'rest-of-content')
    expect(isEncryptedBlob(buf, 'anything')).toBe(true)
  })

  it('文件名 .enc 后缀 → true', () => {
    expect(isEncryptedBlob(Buffer.from('plain'), 'backup.enc')).toBe(true)
  })

  it('魔数不匹配且非 .enc → false', () => {
    expect(isEncryptedBlob(Buffer.from('plain text'), 'backup.zip')).toBe(false)
  })

  it('魔数匹配且 .enc 后缀 → true', () => {
    const buf = Buffer.from(ENC_PREFIX + 'data')
    expect(isEncryptedBlob(buf, 'backup.enc')).toBe(true)
  })
})

describe('toCreds — WebDAV 配置 → 凭据映射', () => {
  it('字段原样映射', () => {
    const cfg = {
      url: 'https://dav.example.com',
      username: 'user',
      passwordCipher: 'encrypted-pass',
      directory: '/backup'
    }
    expect(toCreds(cfg)).toEqual({
      url: 'https://dav.example.com',
      username: 'user',
      password: 'encrypted-pass',
      directory: '/backup'
    })
  })
})
