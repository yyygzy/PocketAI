// SEC-16-16 · 便携导出 MOXENC2 档位头 + MOXENC1 历史文件兼容
//
// 旧样本用**旧算法现场构造**（MOXENC1 + KDF_LEGACY N=2^15），不依赖仓库里的历史夹具；
// 新样本验证写侧 MOXENC2 + kdfId(1)=KDF_CURRENT(N=2^17)，并验证读侧按头选档、
// 未知档位/截断文件 fail-closed。PKBK2 不在本模块范围，无需改动。
import { describe, it, expect } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  decryptWithPassword,
  encryptWithPassword,
  isEncryptedBlob,
  KDF_ID_CURRENT,
  KDF_ID_LEGACY,
  LEGACY_MAGIC,
  MAGIC
} from '../src/main/crypto/portable-crypto'
import { deriveKeySync, KDF_CURRENT, KDF_LEGACY } from '../src/main/crypto/index'

const PASSWORD = 'correct horse battery staple'
const SALT_LEN = 16
const IV_LEN = 12

/** 按旧格式/旧档位现造一份真实可解的历史样本 */
function makeLegacyBlob(password: string, text: string, magic = LEGACY_MAGIC, kdfId?: number): Buffer {
  const tier = kdfId === KDF_ID_CURRENT ? KDF_CURRENT : KDF_LEGACY
  const { key, salt } = deriveKeySync(password, undefined, tier)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
  return Buffer.concat([
    Buffer.from(magic, 'ascii'),
    ...(kdfId === undefined ? [] : [Buffer.from([kdfId])]),
    salt,
    iv,
    cipher.getAuthTag(),
    ct
  ])
}

describe('MOXENC2 写侧格式', () => {
  it('新文件头 = MOXENC2 + kdfId(1)', () => {
    const blob = encryptWithPassword(PASSWORD, 'hello')
    expect(blob.subarray(0, MAGIC.length).toString('ascii')).toBe('MOXENC2')
    expect(blob[MAGIC.length]).toBe(KDF_ID_CURRENT)
  })

  it('新格式往返：UTF-8 多字节文本逐字还原', () => {
    const text = '你好，世界！🌍 こんにちは'
    expect(decryptWithPassword(PASSWORD, encryptWithPassword(PASSWORD, text))).toBe(text)
  })

  it('新格式错误密码 / 篡改 tag → 拒绝', () => {
    const blob = Buffer.from(encryptWithPassword(PASSWORD, 'secret'))
    expect(() => decryptWithPassword('wrong password', blob)).toThrow('密码错误或文件已损坏')
    const tagOffset = MAGIC.length + 1 + SALT_LEN + IV_LEN
    blob.writeUInt8(blob.readUInt8(tagOffset) ^ 0xff, tagOffset)
    expect(() => decryptWithPassword(PASSWORD, blob)).toThrow('密码错误或文件已损坏')
  })
})

describe('MOXENC1 历史文件兼容（旧算法现造样本）', () => {
  it('旧 MOXENC1 + N=2^15 样本仍能解开', () => {
    const legacy = makeLegacyBlob(PASSWORD, '十年前的导出内容')
    expect(legacy.subarray(0, LEGACY_MAGIC.length).toString('ascii')).toBe('MOXENC1')
    expect(decryptWithPassword(PASSWORD, legacy)).toBe('十年前的导出内容')
  })

  it('旧样本错误密码 → 拒绝（不能因兼容而放宽认证）', () => {
    const legacy = makeLegacyBlob(PASSWORD, 'secret')
    expect(() => decryptWithPassword('wrong password', legacy)).toThrow('密码错误或文件已损坏')
  })

  it('旧样本篡改 tag → 拒绝', () => {
    const legacy = makeLegacyBlob(PASSWORD, 'secret')
    const tagOffset = LEGACY_MAGIC.length + SALT_LEN + IV_LEN
    legacy.writeUInt8(legacy.readUInt8(tagOffset) ^ 0xff, tagOffset)
    expect(() => decryptWithPassword(PASSWORD, legacy)).toThrow('密码错误或文件已损坏')
  })
})

describe('读侧按 kdfId 选档 + 格式边界', () => {
  it('MOXENC2 + kdfId(0) 的旧档样本按 KDF_LEGACY 解开', () => {
    const legacyTierInNewHeader = makeLegacyBlob(PASSWORD, 'legacy tier in new header', MAGIC, KDF_ID_LEGACY)
    expect(decryptWithPassword(PASSWORD, legacyTierInNewHeader)).toBe('legacy tier in new header')
  })

  it('未知 kdfId → 格式无效，不使用任何默认档位兜底', () => {
    const bad = makeLegacyBlob(PASSWORD, 'bad tier', MAGIC, 9)
    expect(isEncryptedBlob(bad)).toBe(false)
    expect(() => decryptWithPassword(PASSWORD, bad)).toThrow('文件格式无效')
  })

  it('截断的新文件 → 格式无效', () => {
    const blob = encryptWithPassword(PASSWORD, 'x')
    expect(isEncryptedBlob(blob.subarray(0, MAGIC.length + 1 + SALT_LEN + IV_LEN + 15))).toBe(false)
    expect(() => decryptWithPassword(PASSWORD, blob.subarray(0, 20))).toThrow('文件格式无效')
  })

  it('isEncryptedBlob 认新旧两种魔数，拒绝其它魔数', () => {
    expect(isEncryptedBlob(makeLegacyBlob(PASSWORD, 'x'))).toBe(true)
    expect(isEncryptedBlob(encryptWithPassword(PASSWORD, 'x'))).toBe(true)
    expect(isEncryptedBlob(Buffer.from('MOXENC3' + '0'.repeat(64)))).toBe(false)
  })
})
