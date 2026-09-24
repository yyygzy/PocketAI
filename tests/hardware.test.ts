// hardware 硬件采集中的纯函数测试
//
// 覆盖 src/main/steward/hardware.ts 的两个纯函数：
// - parseJsonSafe：剥离 PowerShell CLIXML/进度输出，截取首个 {...} 或 [...] 并 JSON.parse
// - mapEnum：枚举值映射（null/空→null、纯数字→映射表查、否则原样返回）
//
// 策略：两函数均不依赖硬件探测；mock ../portable 避免 APP_ROOT 初始化副作用。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/portable', () => ({ APP_ROOT: '/mock/app/root' }))

import { parseJsonSafe, mapEnum } from '../src/main/steward/hardware'

describe('parseJsonSafe — PowerShell 输出安全 JSON 提取', () => {
  it('纯 JSON 对象 → 原样解析', () => {
    expect(parseJsonSafe<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('纯 JSON 数组 → 原样解析', () => {
    expect(parseJsonSafe<number[]>('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('空串 → null', () => {
    expect(parseJsonSafe('')).toBeNull()
  })

  it('null → null', () => {
    expect(parseJsonSafe(null)).toBeNull()
  })

  it('无 JSON 标记 → null', () => {
    expect(parseJsonSafe('hello world')).toBeNull()
  })

  it('前缀有 CLIXML 进度输出 → 截取 JSON 解析', () => {
    const raw = '#< CLIXML\r\n<Objs Version="1.1.0.1">\r\n</Objs>\r\n{"name":"cpu","cores":8}'
    expect(parseJsonSafe<{ name: string; cores: number }>(raw)).toEqual({ name: 'cpu', cores: 8 })
  })

  it('JSON 前后有额外文本 → 截取首尾标记之间', () => {
    expect(parseJsonSafe('prefix {"key":"val"} suffix')).toEqual({ key: 'val' })
  })

  it('数组前缀 + 后缀文本', () => {
    expect(parseJsonSafe('garbage [1,2,3] garbage')).toEqual([1, 2, 3])
  })

  it('解析失败（非法 JSON）→ null', () => {
    expect(parseJsonSafe('{invalid json}')).toBeNull()
  })

  it('只有开标记无闭标记 → null（end<=start）', () => {
    expect(parseJsonSafe('{"a":1')).toBeNull()
  })

  it('嵌套对象 → 正常解析', () => {
    expect(parseJsonSafe<{ nested: { x: number } }>('{"nested":{"x":42}}')).toEqual({ nested: { x: 42 } })
  })

  it('数组内含对象（[{...}]）→ 正常解析', () => {
    expect(parseJsonSafe<Array<{ a: number }>>('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('两个独立 JSON 块间有文本 → 整体解析失败 → null', () => {
    // start=首个 [ ，end=末个 } ，中间文本导致 JSON.parse 抛错
    expect(parseJsonSafe('[1,2] extra {"a":1}')).toBeNull()
  })
})

describe('mapEnum — 枚举映射', () => {
  const map: Record<string, string> = { '3': 'HDD', '4': 'SSD', '7': 'USB' }

  it('null → null', () => {
    expect(mapEnum(map, null)).toBeNull()
  })

  it('undefined → null', () => {
    expect(mapEnum(map, undefined)).toBeNull()
  })

  it('空串 → null', () => {
    expect(mapEnum(map, '')).toBeNull()
  })

  it('纯数字命中映射表 → 映射值', () => {
    expect(mapEnum(map, 3)).toBe('HDD')
    expect(mapEnum(map, '4')).toBe('SSD')
    expect(mapEnum(map, 7)).toBe('USB')
  })

  it('纯数字未命中 → 原样数字字符串', () => {
    expect(mapEnum(map, 99)).toBe('99')
  })

  it('非纯数字 → 原样返回', () => {
    expect(mapEnum(map, 'NVMe')).toBe('NVMe')
    expect(mapEnum(map, 'SATA')).toBe('SATA')
  })
})
