// SEC-16-17 · 恢复码 Crockford 容错映射接线
//
// 恢复包 rv1: 不换 KDF 档位（160-bit 熵，档位不改攻击成本）；本测试只验证
// 用户输入把 1 看成 I/L、0 看成 O、V 写成 U 时仍能解开原来的恢复包，
// 且旧的正确码逐字不变、非法字符仍被拒绝。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { blobStore } = vi.hoisted(() => ({
  blobStore: { current: null as string | null }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getRecoveryBlob: () => blobStore.current,
    recoveryState: () => ({ blob: blobStore.current, carriedFrom: null }),
    setRecoveryBlob: (b: string) => { blobStore.current = b },
    clearRecoveryBlob: () => { blobStore.current = null }
  }
}))

import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  recoveryKeyManager
} from '../src/main/crypto/recovery-key'

beforeEach(() => {
  blobStore.current = null
})

/** 模拟用户看错/打错：1→I（或 L）、0→O、V→U；返回是否至少改了一处 */
function mistype(code: string): { input: string; changed: boolean } {
  let changed = false
  const input = code.replace(/[10V]/g, (ch) => {
    changed = true
    if (ch === '1') return 'I'
    if (ch === '0') return 'O'
    return 'U'
  })
  return { input, changed }
}

describe('normalizeRecoveryCode — Crockford 容错映射', () => {
  it('I/L → 1、O → 0、U → V（大小写与分隔符同时规整）', () => {
    expect(normalizeRecoveryCode('I-L-O-U')).toBe('110V')
    expect(normalizeRecoveryCode('i l o u')).toBe('110V')
    expect(normalizeRecoveryCode('A1B-0C2D')).toBe('A1B0C2D')
  })

  it('旧的正确码（Crockford 字母表内）逐字不变', () => {
    const valid = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    expect(normalizeRecoveryCode(valid)).toBe(valid)
    const code = generateRecoveryCode()
    expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ''))
    expect(normalizeRecoveryCode(code)).toMatch(/^[0-9A-Z]{32}$/)
  })

  it('非法字符原样保留，不借容错映射洗白', () => {
    expect(normalizeRecoveryCode('AB!CD')).toBe('AB!CD')
    expect(normalizeRecoveryCode('AB#CD')).toBe('AB#CD')
  })
})

describe('恢复包解开 — 错字母输入与正确输入', () => {
  it('把 1/0/V 抄成 I/O/U 后仍能解开原 masterKey', () => {
    const masterKey = Buffer.alloc(32, 0x5a)
    let mangled = ''
    // enableRecovery 每次都会生成新码；含 1/0/V 的概率很高，最多试 100 次确保覆盖错字母路径。
    for (let i = 0; i < 100; i++) {
      const code = recoveryKeyManager.enableRecovery(masterKey)
      const attempt = mistype(code)
      if (attempt.changed) {
        mangled = attempt.input
        expect(normalizeRecoveryCode(mangled)).toBe(normalizeRecoveryCode(code))
        break
      }
    }
    expect(mangled).not.toBe('')
    expect(recoveryKeyManager.recoverMasterKey(mangled).equals(masterKey)).toBe(true)
  })

  it('原始正确恢复码仍可解开（映射不影响老用户输入）', () => {
    const masterKey = Buffer.alloc(32, 0x33)
    const code = recoveryKeyManager.enableRecovery(masterKey)
    expect(recoveryKeyManager.recoverMasterKey(code).equals(masterKey)).toBe(true)
  })

  it('非法字符替代一位 → 仍判无效（不因容错放宽认证）', () => {
    const code = recoveryKeyManager.enableRecovery(Buffer.alloc(32, 0x77))
    const bad = code.slice(0, -1) + '!'
    expect(() => recoveryKeyManager.recoverMasterKey(bad)).toThrow('恢复密钥无效')
  })
})
