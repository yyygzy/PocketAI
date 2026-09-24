// field-encrypt 字段级 AES-256-GCM 加解密测试
//
// 覆盖 src/main/crypto/field-encrypt.ts：
// - isCipherText：密文前缀识别
// - encryptSecret / decryptSecret：单字符串加解密（含明文向后兼容、损坏 fail closed）
// - encryptApiKeys / decryptApiKeys：字符串数组加解密
//
// 策略：
// - mock masterKeyManager.getFieldKey() 返回固定 32 字节密钥，保证可重复断言
// - mock logger（field-encrypt 解密失败时 warn）
// - 加密用随机 IV，通过「加密→解密」闭环验证正确性，不固定密文值
import { describe, it, expect, vi } from 'vitest'

const FIELD_KEY = Buffer.alloc(32, 0x41) // 固定测试密钥

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getFieldKey: () => FIELD_KEY
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

import {
  isCipherText,
  encryptSecret,
  decryptSecret,
  encryptApiKeys,
  decryptApiKeys
} from '../src/main/crypto/field-encrypt'

describe('isCipherText — 密文前缀识别', () => {
  it('v1: 开头 → true', () => {
    expect(isCipherText('v1:abcdef')).toBe(true)
  })

  it('非 v1: 开头 → false（含明文、空串）', () => {
    expect(isCipherText('')).toBe(false)
    expect(isCipherText('plaintext')).toBe(false)
    expect(isCipherText('v2:xxx')).toBe(false)
  })
})

describe('encryptSecret / decryptSecret — 单字符串加解密', () => {
  it('空串 → 空串（不加密）', () => {
    expect(encryptSecret('')).toBe('')
  })

  it('非空串 → v1: 开头的 base64 密文', () => {
    const ct = encryptSecret('hello')
    expect(ct.startsWith('v1:')).toBe(true)
    // base64 字符集
    expect(ct.slice(3)).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('加密 → 解密闭环还原原文', () => {
    const plaintext = 'my-secret-token-12345'
    const ct = encryptSecret(plaintext)
    expect(decryptSecret(ct)).toBe(plaintext)
  })

  it('相同明文两次加密结果不同（随机 IV）', () => {
    const ct1 = encryptSecret('same')
    const ct2 = encryptSecret('same')
    expect(ct1).not.toBe(ct2)
    // 但都能解密回原文
    expect(decryptSecret(ct1)).toBe('same')
    expect(decryptSecret(ct2)).toBe('same')
  })

  it('非密文明文 → 原样返回（向后兼容）', () => {
    expect(decryptSecret('legacy-plaintext')).toBe('legacy-plaintext')
  })

  it('null / undefined → 空串', () => {
    expect(decryptSecret(null)).toBe('')
    expect(decryptSecret(undefined)).toBe('')
  })

  it('损坏的密文 → 空串（fail closed）', () => {
    // v1: 前缀但 base64 解码后长度不足（IV 12 + tag 16 = 28 字节最小）
    expect(decryptSecret('v1:aaa')).toBe('')
    // 合法 base64 但认证标签不匹配
    const fakeIv = Buffer.alloc(12)
    const fakeTag = Buffer.alloc(16)
    const fakeCt = Buffer.concat([fakeIv, Buffer.from('tampered'), fakeTag])
    expect(decryptSecret('v1:' + fakeCt.toString('base64'))).toBe('')
  })

  it('UTF-8 多字节字符（中文/emoji）加解密正确', () => {
    const text = '中文密钥🔑token'
    const ct = encryptSecret(text)
    expect(decryptSecret(ct)).toBe(text)
  })
})

describe('encryptApiKeys / decryptApiKeys — 字符串数组加解密', () => {
  it('空数组 → 空串', () => {
    expect(encryptApiKeys([])).toBe('')
  })

  it('加密 → 解密还原数组', () => {
    const keys = ['sk-abc', 'sk-def', 'sk-ghi']
    const ct = encryptApiKeys(keys)
    expect(decryptApiKeys(ct)).toEqual(keys)
  })

  it('null / 空串 → 空数组', () => {
    expect(decryptApiKeys(null)).toEqual([])
    expect(decryptApiKeys('')).toEqual([])
  })

  it('损坏密文 → 空数组', () => {
    expect(decryptApiKeys('v1:broken')).toEqual([])
  })

  it('明文 JSON 数组向后兼容', () => {
    // 历史数据可能是明文 JSON
    expect(decryptApiKeys(JSON.stringify(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('非数组 JSON → 空数组', () => {
    expect(decryptApiKeys(JSON.stringify({ not: 'array' }))).toEqual([])
    expect(decryptApiKeys('not-json')).toEqual([])
  })
})
