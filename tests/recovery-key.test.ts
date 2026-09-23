// 恢复密钥（Recovery Code）测试
//
// 覆盖 src/main/crypto/recovery-key.ts 的 3 个已导出设施：
//   - normalizeRecoveryCode：纯函数，去分隔符 + 大写
//   - generateRecoveryCode：纯函数（randomBytes），Crockford Base32 → 8 组 4 字符
//   - recoveryKeyManager：hasRecovery/enableRecovery/disableRecovery/recoverMasterKey
//
// 策略：normalizeRecoveryCode/generateRecoveryCode 直接断言；recoveryKeyManager
// 走 enable→recover 往返测加解密一致性。mock appConfigRepo 用 vi.hoisted 内存
// blobStore；deriveKeySync 走真实 scrypt（验证 wrap/unwrap 用同一派生路径）。
//
// 安全关键：忘密码恢复路径，恢复码错误时必须拒绝（AES-GCM auth tag 校验）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  normalizeRecoveryCode,
  generateRecoveryCode,
  recoveryKeyManager
} from '../src/main/crypto/recovery-key'

// mock appConfigRepo：用内存 blobStore 模拟 config.json 的恢复包读写
const { blobStore } = vi.hoisted(() => ({
  blobStore: { current: null as string | null }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getRecoveryBlob: () => blobStore.current,
    setRecoveryBlob: (b: string) => {
      blobStore.current = b
    },
    clearRecoveryBlob: () => {
      blobStore.current = null
    }
  }
}))

beforeEach(() => {
  blobStore.current = null
})

describe('normalizeRecoveryCode — 规整用户输入', () => {
  it('去横线/空格 + 大写（normalize 不做字符替换，原样保留）', () => {
    // 输入字母 a-q（不含 i），原样大写，去横线/空格
    expect(normalizeRecoveryCode('abcd-efgh-jklm-nopq')).toBe('ABCDEFGHJKLMNOPQ')
    expect(normalizeRecoveryCode('  ab cd  ef  ')).toBe('ABCDEF')
  })

  it('混合多种分隔符（横线、空白、连续分隔）', () => {
    expect(normalizeRecoveryCode('  1234--  5678  -9012')).toBe('123456789012')
    expect(normalizeRecoveryCode('aBcDeFgH')).toBe('ABCDEFGH')
  })
})

describe('generateRecoveryCode — 生成恢复码', () => {
  it('格式：4 字符一组 × 8 组，用横线连接（共 32 字符 + 7 横线）', () => {
    const code = generateRecoveryCode()
    // 8 组每组 4 字符，7 个分隔横线
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/)
    // 去横线后正好 32 字符（160bit 熵 / 5bit = 32）
    expect(normalizeRecoveryCode(code)).toHaveLength(32)
  })

  it('两次生成不同（随机熵）', () => {
    const a = generateRecoveryCode()
    const b = generateRecoveryCode()
    expect(a).not.toBe(b)
  })
})

describe('recoveryKeyManager — 恢复包生命周期', () => {
  it('hasRecovery 初始为 false（未设置恢复包）', () => {
    expect(recoveryKeyManager.hasRecovery()).toBe(false)
  })

  it('enableRecovery(32 字节 masterKey) → 返回符合格式的恢复码 + hasRecovery 变 true', () => {
    const masterKey = Buffer.alloc(32, 0xab)
    const code = recoveryKeyManager.enableRecovery(masterKey)
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/)
    expect(recoveryKeyManager.hasRecovery()).toBe(true)
  })

  it('enableRecovery(非 32 字节 masterKey) → 抛错（长度校验）', () => {
    expect(() => recoveryKeyManager.enableRecovery(Buffer.alloc(31, 0xab))).toThrow(
      '恢复密钥只能在已设置主密码'
    )
    expect(() => recoveryKeyManager.enableRecovery(Buffer.alloc(0))).toThrow(
      '恢复密钥只能在已设置主密码'
    )
  })

  it('enableRecovery(空/null masterKey) → 抛错', () => {
    expect(() => recoveryKeyManager.enableRecovery(null as unknown as Buffer)).toThrow(
      '恢复密钥只能在已设置主密码'
    )
  })

  it('recoverMasterKey(正确恢复码) → 返回原 masterKey（往返一致性）', () => {
    const masterKey = Buffer.alloc(32, 0x7f)
    const code = recoveryKeyManager.enableRecovery(masterKey)
    const recovered = recoveryKeyManager.recoverMasterKey(code)
    expect(recovered.equals(masterKey)).toBe(true)
  })

  it('recoverMasterKey(篡改的恢复码) → 抛"恢复密钥无效"（AES-GCM auth tag 校验失败）', () => {
    const masterKey = Buffer.alloc(32, 0x55)
    const code = recoveryKeyManager.enableRecovery(masterKey)
    // 把码的最后一个字符替换为不同字符（Crockford 字母表内）
    const last = code[code.length - 1]!
    const swap = last === '0' ? '1' : '0'
    const tampered = code.slice(0, -1) + swap
    expect(() => recoveryKeyManager.recoverMasterKey(tampered)).toThrow('恢复密钥无效')
  })

  it('recoverMasterKey(格式不对，非 32 字符) → 抛"格式不正确"', () => {
    recoveryKeyManager.enableRecovery(Buffer.alloc(32, 0x33))
    expect(() => recoveryKeyManager.recoverMasterKey('too-short')).toThrow('格式不正确')
    expect(() => recoveryKeyManager.recoverMasterKey('AB')).toThrow('格式不正确')
  })

  it('recoverMasterKey 未设置恢复密钥 → 抛"未设置恢复密钥"', () => {
    expect(() => recoveryKeyManager.recoverMasterKey('ABCD-EFGH-JKMN-PQRS-TUVW-XY01-2345-6789')).toThrow(
      '未设置恢复密钥'
    )
  })

  it('disableRecovery → hasRecovery 变 false，再 recover 抛"未设置恢复密钥"', () => {
    recoveryKeyManager.enableRecovery(Buffer.alloc(32, 0x44))
    expect(recoveryKeyManager.hasRecovery()).toBe(true)
    recoveryKeyManager.disableRecovery()
    expect(recoveryKeyManager.hasRecovery()).toBe(false)
    expect(() => recoveryKeyManager.recoverMasterKey('ABCD-EFGH-JKMN-PQRS-TUVW-XY01-2345-6789')).toThrow(
      '未设置恢复密钥'
    )
  })

  it('enableRecovery 重新生成 → 旧恢复码失效（新 masterKey 包覆盖旧包）', () => {
    const key1 = Buffer.alloc(32, 0x11)
    const key2 = Buffer.alloc(32, 0x22)
    const code1 = recoveryKeyManager.enableRecovery(key1)
    const code2 = recoveryKeyManager.enableRecovery(key2)
    // code2 不等于 code1（重新生成）
    expect(code2).not.toBe(code1)
    // 旧 code1 已失效（包被覆盖，AES-GCM 解密失败）
    expect(() => recoveryKeyManager.recoverMasterKey(code1)).toThrow('恢复密钥无效')
    // 新 code2 正常恢复
    expect(recoveryKeyManager.recoverMasterKey(code2).equals(key2)).toBe(true)
  })
})
