// i18n 不变量：zh/en 两本字典必须保持结构对等
// - key 集合完全一致（新增文案漏翻译会直接红灯）
// - 每条文案非空
// - 同名 key 的 {placeholder} 集合一致（参数名漂移会让插值失效，直接显示 {xxx}）
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'

const placeholders = (s: string): string[] => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]!).sort()

describe('i18n 字典对等', () => {
  it('两本字典非空且条目数一致', () => {
    expect(Object.keys(zh).length).toBeGreaterThan(1000)
    expect(Object.keys(en).length).toBe(Object.keys(zh).length)
  })

  it('key 集合完全一致', () => {
    const onlyZh = Object.keys(zh).filter((k) => !(k in en))
    const onlyEn = Object.keys(en).filter((k) => !(k in zh))
    expect(onlyZh).toEqual([])
    expect(onlyEn).toEqual([])
  })

  it('每条文案都是非空字符串', () => {
    for (const [k, v] of Object.entries(zh)) {
      expect(typeof v, `zh[${k}]`).toBe('string')
      expect(v.trim().length, `zh[${k}]`).toBeGreaterThan(0)
    }
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v, `en[${k}]`).toBe('string')
      expect(v.trim().length, `en[${k}]`).toBeGreaterThan(0)
    }
  })

  it('同名 key 的插值占位符集合一致', () => {
    const mismatches: string[] = []
    for (const k of Object.keys(zh)) {
      const a = placeholders(zh[k]!).join(',')
      const b = placeholders(en[k]!).join(',')
      if (a !== b) mismatches.push(`${k}: zh{${a}} en{${b}}`)
    }
    expect(mismatches).toEqual([])
  })
})
