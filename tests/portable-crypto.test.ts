// portable-crypto 密码派生 AES-256-GCM 加解密测试
//
// 覆盖 src/main/crypto/portable-crypto.ts：
// - encryptWithPassword：密码 + 明文 → MOXENC1+salt+iv+tag+ct 格式 Buffer
// - decryptWithPassword：密码 + blob → 明文（密码错误/篡改/格式无效均失败）
// - isEncryptedBlob：魔数 + 最小长度校验
// - MAGIC 常量 = 'MOXENC1'
//
// 策略：纯密码学函数，无依赖，直接走真实 scrypt(N=32768) + AES-256-GCM。
// 加解密闭环验证、篡改检测、不同密码互解失败。
import { describe, it, expect } from 'vitest'
import {
  encryptWithPassword,
  decryptWithPassword,
  isEncryptedBlob,
  MAGIC
} from '../src/main/crypto/portable-crypto'

const PASSWORD = 'correct horse battery staple'

describe('MAGIC 常量', () => {
  it('等于 MOXENC1', () => {
    expect(MAGIC).toBe('MOXENC1')
  })
})

describe('encryptWithPassword — 密码加密', () => {
  it('空密码 → 抛错', () => {
    expect(() => encryptWithPassword('', 'hello')).toThrow('密码不能为空')
  })

  it('空内容 → 抛错', () => {
    expect(() => encryptWithPassword(PASSWORD, '')).toThrow('内容不能为空')
  })

  it('正常加密 → 返回以 MAGIC 开头的 Buffer', () => {
    const blob = encryptWithPassword(PASSWORD, 'hello')
    expect(Buffer.isBuffer(blob)).toBe(true)
    expect(blob.slice(0, MAGIC.length).toString('ascii')).toBe(MAGIC)
  })

  it('输出长度 ≥ MAGIC + salt(16) + iv(12) + tag(16)', () => {
    const blob = encryptWithPassword(PASSWORD, 'x')
    expect(blob.length).toBeGreaterThanOrEqual(MAGIC.length + 16 + 12 + 16)
  })

  it('相同密码相同明文 → 密文不同（随机 salt + iv）', () => {
    const a = encryptWithPassword(PASSWORD, 'hello')
    const b = encryptWithPassword(PASSWORD, 'hello')
    expect(a.equals(b)).toBe(false)
  })

  it('不同明文 → 密文不同', () => {
    const a = encryptWithPassword(PASSWORD, 'hello')
    const b = encryptWithPassword(PASSWORD, 'world')
    expect(a.equals(b)).toBe(false)
  })
})

describe('decryptWithPassword — 密码解密', () => {
  it('空密码 → 抛错', () => {
    const blob = encryptWithPassword(PASSWORD, 'hello')
    expect(() => decryptWithPassword('', blob)).toThrow('密码不能为空')
  })

  it('格式无效（非加密 blob）→ 抛错', () => {
    expect(() => decryptWithPassword(PASSWORD, Buffer.from('not-encrypted'))).toThrow(
      '文件格式无效'
    )
  })

  it('加密后解密 → 还原明文', () => {
    const blob = encryptWithPassword(PASSWORD, 'hello world')
    expect(decryptWithPassword(PASSWORD, blob)).toBe('hello world')
  })

  it('UTF-8 多字节内容 → 加解密闭环', () => {
    const text = '你好，世界！🌍 こんにちは 🎉'
    const blob = encryptWithPassword(PASSWORD, text)
    expect(decryptWithPassword(PASSWORD, blob)).toBe(text)
  })

  it('错误密码 → 抛错（认证标签不匹配）', () => {
    const blob = encryptWithPassword(PASSWORD, 'secret')
    expect(() => decryptWithPassword('wrong password', blob)).toThrow('密码错误或文件已损坏')
  })

  it('篡改密文尾部 → 抛错', () => {
    const blob = Buffer.from(encryptWithPassword(PASSWORD, 'secret'))
    const tail = blob.length - 1
    blob.writeUInt8(blob.readUInt8(tail) ^ 0xff, tail)
    expect(() => decryptWithPassword(PASSWORD, blob)).toThrow('密码错误或文件已损坏')
  })

  it('篡改认证 tag → 抛错', () => {
    // 格式: MAGIC(7) + salt(16) + iv(12) + tag(16) + ct
    const blob = Buffer.from(encryptWithPassword(PASSWORD, 'secret'))
    const tagOffset = MAGIC.length + 16 + 12
    blob.writeUInt8(blob.readUInt8(tagOffset) ^ 0xff, tagOffset)
    expect(() => decryptWithPassword(PASSWORD, blob)).toThrow('密码错误或文件已损坏')
  })

  it('篡改魔数 → 格式无效', () => {
    const blob = Buffer.from(encryptWithPassword(PASSWORD, 'secret'))
    blob[0] = 'X'.charCodeAt(0)
    expect(() => decryptWithPassword(PASSWORD, blob)).toThrow('文件格式无效')
  })

  it('长文本 → 加解密闭环', () => {
    const long = 'a'.repeat(100000)
    const blob = encryptWithPassword(PASSWORD, long)
    expect(decryptWithPassword(PASSWORD, blob)).toBe(long)
  })
})

describe('isEncryptedBlob — 加密 blob 格式校验', () => {
  it('合法加密 blob → true', () => {
    const blob = encryptWithPassword(PASSWORD, 'x')
    expect(isEncryptedBlob(blob)).toBe(true)
  })

  it('空 Buffer → false', () => {
    expect(isEncryptedBlob(Buffer.alloc(0))).toBe(false)
  })

  it('长度不足 → false', () => {
    const short = Buffer.alloc(MAGIC.length + 16 + 12 + 15) // 差 1 字节 tag
    short.write(MAGIC, 0, 'ascii')
    expect(isEncryptedBlob(short)).toBe(false)
  })

  it('长度刚好等于最小值 → true', () => {
    const min = Buffer.alloc(MAGIC.length + 16 + 12 + 16)
    min.write(MAGIC, 0, 'ascii')
    expect(isEncryptedBlob(min)).toBe(true)
  })

  it('魔数不匹配 → false', () => {
    const blob = Buffer.alloc(MAGIC.length + 16 + 12 + 16)
    blob.write('XXXXXXX', 0, 'ascii')
    expect(isEncryptedBlob(blob)).toBe(false)
  })

  it('普通文本 Buffer → false', () => {
    expect(isEncryptedBlob(Buffer.from('hello world'))).toBe(false)
  })
})
