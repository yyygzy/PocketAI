// secret-store KV 凭据加密存取测试
//
// 覆盖 src/main/crypto/secret-store.ts：
// - setSecret：受管 key 校验、空值删除、加密落盘、超长值拒绝
// - getSecret：解密读取、不存在返回空串、明文向后兼容
// - hasSecret：只看落盘有无值
// - migrateKvSecrets：历史明文 → 密文幂等升级
// - exportSecrets / restoreSecrets：密钥轮换快照导出恢复
//
// 策略：
// - mock appConfigRepo 为内存 Map（get/set/delete）
// - mock masterKeyManager.getFieldKey() 让 field-encrypt 真实加解密可用
// - mock logger
import { describe, it, expect, vi, beforeEach } from 'vitest'

const FIELD_KEY = Buffer.alloc(32, 0x41)

// appConfigRepo 内存实现：key → value string
const { store } = vi.hoisted(() => ({
  store: new Map<string, string>()
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getFieldKey: () => FIELD_KEY }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, value: string) => { store.set(key, value) },
    delete: (key: string) => { store.delete(key) }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

import {
  SECRET_KV_KEYS,
  setSecret,
  getSecret,
  hasSecret,
  migrateKvSecrets,
  exportSecrets,
  restoreSecrets
} from '../src/main/crypto/secret-store'
import { isCipherText } from '../src/main/crypto/field-encrypt'

const VALID_KEY = SECRET_KV_KEYS.TELEGRAM_TOKEN
const ANOTHER_KEY = SECRET_KV_KEYS.WEBSEARCH_API_KEY

beforeEach(() => {
  store.clear()
})

describe('setSecret — 加密写入', () => {
  it('合法 key + 非空值 → 加密落盘，getSecret 可还原', () => {
    setSecret(VALID_KEY, 'my-token-123')
    const stored = store.get(VALID_KEY)
    expect(stored).toBeDefined()
    expect(isCipherText(stored!)).toBe(true)
    expect(getSecret(VALID_KEY)).toBe('my-token-123')
  })

  it('空串 → 删除凭据（不写入）', () => {
    setSecret(VALID_KEY, 'old-token')
    expect(hasSecret(VALID_KEY)).toBe(true)
    setSecret(VALID_KEY, '')
    expect(hasSecret(VALID_KEY)).toBe(false)
    expect(store.get(VALID_KEY)).toBeUndefined()
  })

  it('纯空白 → 视同空串删除', () => {
    setSecret(VALID_KEY, '   ')
    expect(hasSecret(VALID_KEY)).toBe(false)
  })

  it('值会 trim 后再加密', () => {
    setSecret(VALID_KEY, '  token  ')
    expect(getSecret(VALID_KEY)).toBe('token')
  })

  it('未注册的 key → 抛 ZodError', () => {
    expect(() => setSecret('unregistered.key', 'value')).toThrow()
  })

  it('值超过 1024 字符 → 抛 ZodError', () => {
    const long = 'x'.repeat(1025)
    expect(() => setSecret(VALID_KEY, long)).toThrow()
  })
})

describe('getSecret — 解密读取', () => {
  it('不存在 → 空串', () => {
    expect(getSecret(VALID_KEY)).toBe('')
  })

  it('历史明文（非 v1: 开头）→ 原样返回（向后兼容）', () => {
    store.set(VALID_KEY, 'legacy-plain-token')
    expect(getSecret(VALID_KEY)).toBe('legacy-plain-token')
  })

  it('密文 → 解密返回明文', () => {
    setSecret(VALID_KEY, 'secret-value')
    expect(getSecret(VALID_KEY)).toBe('secret-value')
  })
})

describe('hasSecret — 是否已配置', () => {
  it('无值 → false', () => {
    expect(hasSecret(VALID_KEY)).toBe(false)
  })

  it('有值 → true（不管是明文还是密文）', () => {
    store.set(VALID_KEY, 'anything')
    expect(hasSecret(VALID_KEY)).toBe(true)
  })

  it('setSecret 写入后 → true', () => {
    setSecret(VALID_KEY, 'token')
    expect(hasSecret(VALID_KEY)).toBe(true)
  })
})

describe('migrateKvSecrets — 明文 → 密文幂等升级', () => {
  it('明文值升级为密文', () => {
    store.set(VALID_KEY, 'old-plain-token')
    migrateKvSecrets([VALID_KEY])
    const stored = store.get(VALID_KEY)!
    expect(isCipherText(stored)).toBe(true)
    // 解密后还原
    expect(getSecret(VALID_KEY)).toBe('old-plain-token')
  })

  it('已是密文 → 不变（幂等）', () => {
    setSecret(VALID_KEY, 'already-encrypted')
    const before = store.get(VALID_KEY)
    migrateKvSecrets([VALID_KEY])
    expect(store.get(VALID_KEY)).toBe(before)
  })

  it('空值 → 跳过', () => {
    migrateKvSecrets([VALID_KEY])
    expect(store.get(VALID_KEY)).toBeUndefined()
  })

  it('默认遍历所有受管 key', () => {
    store.set(VALID_KEY, 'plain1')
    store.set(ANOTHER_KEY, 'plain2')
    migrateKvSecrets()
    expect(isCipherText(store.get(VALID_KEY)!)).toBe(true)
    expect(isCipherText(store.get(ANOTHER_KEY)!)).toBe(true)
  })
})

describe('exportSecrets — 导出明文快照', () => {
  it('只导出有值的 key', () => {
    setSecret(VALID_KEY, 'token-1')
    // ANOTHER_KEY 不设置
    const snapshot = exportSecrets([VALID_KEY, ANOTHER_KEY])
    expect(snapshot).toEqual({ [VALID_KEY]: 'token-1' })
    expect(snapshot[ANOTHER_KEY]).toBeUndefined()
  })

  it('空值不进入快照', () => {
    store.set(VALID_KEY, '')
    const snapshot = exportSecrets([VALID_KEY])
    expect(snapshot).toEqual({})
  })

  it('默认导出所有受管 key', () => {
    setSecret(VALID_KEY, 'a')
    setSecret(ANOTHER_KEY, 'b')
    const snapshot = exportSecrets()
    expect(snapshot[VALID_KEY]).toBe('a')
    expect(snapshot[ANOTHER_KEY]).toBe('b')
  })
})

describe('restoreSecrets — 恢复快照', () => {
  it('正常恢复：加密落盘后可读回', () => {
    restoreSecrets({ [VALID_KEY]: 'restored-token' })
    expect(getSecret(VALID_KEY)).toBe('restored-token')
    expect(isCipherText(store.get(VALID_KEY)!)).toBe(true)
  })

  it('未知 key 被 zod 丢弃（不写入）', () => {
    restoreSecrets({ 'unknown.key': 'should-be-dropped' } as Record<string, string>)
    expect(store.get('unknown.key')).toBeUndefined()
  })

  it('空快照不报错', () => {
    expect(() => restoreSecrets({})).not.toThrow()
  })

  it('空值恢复 → 删除', () => {
    setSecret(VALID_KEY, 'old')
    restoreSecrets({ [VALID_KEY]: '' })
    expect(hasSecret(VALID_KEY)).toBe(false)
  })

  it('导出 → 恢复闭环：值不变', () => {
    setSecret(VALID_KEY, 'roundtrip-value')
    const snapshot = exportSecrets([VALID_KEY])
    store.clear()
    restoreSecrets(snapshot)
    expect(getSecret(VALID_KEY)).toBe('roundtrip-value')
  })
})
