// i18n 不变量：zh/en/ja/ko 四本字典必须保持结构对等
// - key 集合完全一致（新增文案漏翻译会直接红灯）
// - 每条文案非空
// - 同名 key 的 {placeholder} 集合一致（参数名漂移会让插值失效，直接显示 {xxx}）
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const dicts: Record<string, Record<string, string>> = { zh, en, ja, ko }
const names = Object.keys(dicts)

const placeholders = (s: string): string[] => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]!).sort()

describe('i18n 字典对等', () => {
  it('四本字典非空且条目数一致', () => {
    expect(Object.keys(zh).length).toBeGreaterThan(1000)
    for (const name of names) {
      expect(Object.keys(dicts[name]!).length, name).toBe(Object.keys(zh).length)
    }
  })

  it('key 集合完全一致（以 zh 为基准）', () => {
    const zhKeys = new Set(Object.keys(zh))
    for (const name of names.slice(1)) {
      const onlyLang = Object.keys(dicts[name]!).filter((k) => !zhKeys.has(k))
      const onlyZh = Object.keys(zh).filter((k) => !(k in dicts[name]!))
      expect(onlyLang, `${name} 多出的 key`).toEqual([])
      expect(onlyZh, `zh 独有的 key（${name} 缺失）`).toEqual([])
    }
  })

  it('每条文案都是非空字符串', () => {
    for (const name of names) {
      for (const [k, v] of Object.entries(dicts[name]!)) {
        expect(typeof v, `${name}[${k}]`).toBe('string')
        expect(v.trim().length, `${name}[${k}]`).toBeGreaterThan(0)
      }
    }
  })

  it('同名 key 的插值占位符集合一致', () => {
    const mismatches: string[] = []
    for (const name of names) {
      for (const k of Object.keys(zh)) {
        const a = placeholders(zh[k]!).join(',')
        const b = placeholders(dicts[name]![k] ?? '').join(',')
        if (a !== b) mismatches.push(`${name}.${k}: zh{${a}} ${name}{${b}}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})
