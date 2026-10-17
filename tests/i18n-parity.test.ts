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

import fs from 'node:fs'
import path from 'node:path'

const SRC_ROOT = path.join(process.cwd(), 'src', 'renderer', 'src')
/** 只认单行字面量 key：必须带点、不含空格与插值，避免把别处的 t() 或散文误当文案 */
const KEY_USE_RE = /(?:^|[^\w$.])t\(\s*(['"])([a-z][\w-]*(?:\.[\w-]+)+)\1/g

/** 递归收集渲染层 .ts/.tsx（跳过 i18n 目录：那里是 key 的定义处，不是引用处） */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, it.name)
    if (it.isDirectory()) {
      if (it.name !== 'i18n') out.push(...listSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(it.name)) {
      out.push(full)
    }
  }
  return out
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

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
        const a = placeholders((zh as Record<string, string>)[k]!).join(',')
        const b = placeholders(dicts[name]![k] ?? '').join(',')
        if (a !== b) mismatches.push(`${name}.${k}: zh{${a}} ${name}{${b}}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

// 引用了但四本字典都没有的 key：面板会原样显示 `a.b.c`。
// 对等比对结构性测不出这类问题（四本一起漏），所以要拿源码里出现的字面 key 反查字典。
describe('源码引用的 key 都在字典里', () => {
  it('源码里出现的静态字面量 key 都在字典里（模板串文案由组件用例覆盖）', () => {
    const files = listSourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(50)
    const missing: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      for (const m of text.matchAll(KEY_USE_RE)) {
        const key = m[2]!
        const srcLine = text.slice(0, m.index!).split('\n').pop() ?? ''
        // 注释与 JSDoc 里的示例写法不算引用（例如 useConfirm 的用法说明）
        if (/^\s*(\/\/|\*|\/\*)/.test(srcLine)) continue
        if (key in zh) continue
        missing.push(`${f.replace(SRC_ROOT, '')}:${lineOf(text, m.index!)} → ${key}`)
      }
    }
    expect(missing, '漏译 key：' + missing.join(' | ')).toEqual([])
  })
})
