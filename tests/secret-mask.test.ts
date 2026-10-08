// 密钥掩码与保存回填（src/shared/secret-mask.ts）
//
// 契约：出 IPC 只见掩码，保存时掩码占位按「未修改」回填原值。
// 覆盖：占位判定边界、数组按下标回填、映射按 key 回填、删除与新增语义、
// 以及导出侧的值形态识别 looksLikeSecret（键名不可信时的兜底）。
import { describe, it, expect } from 'vitest'
import {
  SECRET_MASK_PREFIX,
  maskSecret,
  isMaskedSecret,
  maskSecretList,
  maskSecretMap,
  restoreMaskedList,
  restoreMaskedMap
} from '../src/shared/secret-mask'
import { looksLikeSecret } from '../src/shared/mcp-export'

describe('maskSecret / isMaskedSecret — 占位形态', () => {
  it('空值不产生占位（避免回填歧义）', () => {
    expect(maskSecret('')).toBe('')
    expect(isMaskedSecret('')).toBe(false)
  })

  it('长值保留末 4 位，短值只剩前缀', () => {
    expect(maskSecret('sk-abcdef123456')).toBe(`${SECRET_MASK_PREFIX}3456`)
    expect(maskSecret('abc')).toBe(SECRET_MASK_PREFIX)
  })

  it('掩码结果被识别为占位，真实值不被识别', () => {
    expect(isMaskedSecret(maskSecret('sk-secret-value'))).toBe(true)
    expect(isMaskedSecret('sk-abcdef123456')).toBe(false)
    expect(isMaskedSecret(`${SECRET_MASK_PREFIX}toolongtail`)).toBe(false)
    expect(isMaskedSecret(undefined)).toBe(false)
  })
})

describe('restoreMaskedList — Provider apiKeys 按下标回填', () => {
  const existing = ['sk-one-1111', 'sk-two-2222']

  it('未改动的掩码行还原为原值，新增行保留真实值', () => {
    const incoming = maskSecretList(existing)
    incoming.push('sk-three-3333')
    expect(restoreMaskedList(incoming, existing)).toEqual([...existing, 'sk-three-3333'])
  })

  it('删除某行即真正删除（其余按下标对齐）', () => {
    const masked = maskSecretList(existing)
    expect(restoreMaskedList([masked[0]!], existing)).toEqual([existing[0]])
  })

  it('越界的掩码行（无对应原值）被丢弃，不会把占位符写成密钥', () => {
    expect(restoreMaskedList([`${SECRET_MASK_PREFIX}9999`], [])).toEqual([])
    expect(restoreMaskedList(maskSecretList(existing), [])).toEqual([])
  })

  it('新建记录（无原值）时真实值原样落库', () => {
    expect(restoreMaskedList(['sk-new'], null)).toEqual(['sk-new'])
  })

  it('空输入 → 空结果（清空所有密钥的语义保持）', () => {
    expect(restoreMaskedList([], existing)).toEqual([])
  })
})

describe('restoreMaskedMap — MCP env/headers 按 key 回填', () => {
  const existing = { API_KEY: 'sk-abc123', NODE_ENV: 'production' }

  it('掩码值取回原值，未掩码值覆盖', () => {
    const incoming = maskSecretMap(existing)
    incoming.API_KEY = 'sk-rotated'
    expect(restoreMaskedMap(incoming, existing)).toEqual({
      API_KEY: 'sk-rotated',
      NODE_ENV: 'production'
    })
  })

  it('删键即删除；新增键写真实值', () => {
    const incoming = { ...maskSecretMap({ NODE_ENV: existing.NODE_ENV }), EXTRA: 'v' }
    expect(restoreMaskedMap(incoming, existing)).toEqual({
      NODE_ENV: 'production',
      EXTRA: 'v'
    })
  })

  it('新增键却填了占位符 → 丢弃（没有原值可回填）', () => {
    expect(restoreMaskedMap({ GHOST: SECRET_MASK_PREFIX }, existing)).toEqual({})
  })

  it('非对象输入按空处理', () => {
    expect(restoreMaskedMap(null, existing)).toEqual({})
    expect(maskSecretMap(undefined)).toEqual({})
  })
})

describe('looksLikeSecret — 导出侧值形态识别', () => {
  it('命中厂商 token 形态与 Bearer', () => {
    for (const v of [
      'sk-proj-ABCDEFGHIJKLMNOP1234',
      'ghp_abcdefghijklmnop1234',
      'xoxb-1234567890-abcdef',
      'AKIAABCDEFGHIJ123456',
      'Bearer abcdef1234567890',
      'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Q' // 25 位混合大小写与数字的高熵串
    ]) {
      expect(looksLikeSecret(v), v).toBe(true)
    }
  })

  it('普通配置值不误伤', () => {
    for (const v of [
      '',
      '/usr/bin',
      'production',
      'https://api.example.com/v1',
      'node',
      'npx -y mcp-server-fetch',
      '0123456789abcdefghijklmnop', // 长但无大写 → 不算高熵
      'SHORT_1'
    ]) {
      expect(looksLikeSecret(v), v).toBe(false)
    }
  })
})
