// sandbox-service 输入清洗测试
//
// 覆盖 src/main/sandbox/sandbox-service.ts 的三个纯函数：
// - cleanName：控制符→空格、trim、截 60、空→fallback
// - cleanIcon：取首字符、空→'📦'
// - cleanDescription：控制符→空格、trim、截 200
//
// 策略：三函数均不依赖 fs/DB；mock ../portable + sandboxRepo 避免模块加载重依赖。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/portable', () => ({ DATA_DIR: '/mock/data' }))
vi.mock('../src/main/db/repositories/sandbox.repo', () => ({ sandboxRepo: { list: () => [] } }))

import { cleanName, cleanIcon, cleanDescription } from '../src/main/sandbox/sandbox-service'

// ── cleanName ────────────────────────────────────────────
describe('cleanName — 名称清洗', () => {
  it('正常名称 → 原样', () => {
    expect(cleanName('我的沙箱')).toBe('我的沙箱')
  })

  it('控制字符 → 替换为空格', () => {
    expect(cleanName('a\x00b\x01c')).toBe('a b c')
    expect(cleanName('line1\nline2')).toBe('line1 line2')
  })

  it('前后空白 trim', () => {
    expect(cleanName('  name  ')).toBe('name')
  })

  it('超过 60 字符 → 截断', () => {
    const long = 'a'.repeat(100)
    expect(cleanName(long)).toHaveLength(60)
  })

  it('恰好 60 字符 → 不截断', () => {
    const name = 'a'.repeat(60)
    expect(cleanName(name)).toBe(name)
  })

  it('空串 → fallback 默认', () => {
    expect(cleanName('')).toBe('未命名')
  })

  it('纯空白 → fallback 默认', () => {
    expect(cleanName('   ')).toBe('未命名')
  })

  it('自定义 fallback', () => {
    expect(cleanName('', '默认名')).toBe('默认名')
  })

  it('全控制符清洗后为空 → fallback', () => {
    expect(cleanName('\x00\x01\x02')).toBe('未命名')
  })
})

// ── cleanIcon ────────────────────────────────────────────
describe('cleanIcon — 图标清洗', () => {
  it('单 emoji → 原样', () => {
    expect(cleanIcon('📦')).toBe('📦')
  })

  it('多字符 → 取首字符', () => {
    expect(cleanIcon('abc')).toBe('a')
  })

  it('多 emoji → 取首字符', () => {
    expect(cleanIcon('🚀🎯')).toBe('🚀')
  })

  it('空串 → 默认 📦', () => {
    expect(cleanIcon('')).toBe('📦')
  })

  it('纯空白 → 默认 📦', () => {
    expect(cleanIcon('   ')).toBe('📦')
  })

  it('前后空白 trim 后取首字符', () => {
    expect(cleanIcon('  🎨  ')).toBe('🎨')
  })
})

// ── cleanDescription ─────────────────────────────────────
describe('cleanDescription — 描述清洗', () => {
  it('正常描述 → 原样', () => {
    expect(cleanDescription('一个工具')).toBe('一个工具')
  })

  it('控制字符 → 替换为空格', () => {
    expect(cleanDescription('a\x00b\x7fc')).toBe('a b c')
  })

  it('前后空白 trim', () => {
    expect(cleanDescription('  desc  ')).toBe('desc')
  })

  it('超过 200 字符 → 截断', () => {
    const long = 'a'.repeat(300)
    expect(cleanDescription(long)).toHaveLength(200)
  })

  it('空串 → 空串（无 fallback）', () => {
    expect(cleanDescription('')).toBe('')
  })

  it('纯空白 → 空串', () => {
    expect(cleanDescription('   ')).toBe('')
  })
})
