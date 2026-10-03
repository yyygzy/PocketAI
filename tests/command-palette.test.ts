// 命令面板纯函数测试：子串匹配、截断保序、循环键盘导航
import { describe, it, expect } from 'vitest'
import {
  matchesQuery,
  filterPaletteItems,
  nextPaletteIndex,
  PALETTE_LIMIT,
  type PaletteItem
} from '../src/renderer/src/utils/command-palette'

function item(partial: Partial<PaletteItem> & { id: string; title: string }): PaletteItem {
  return { type: 'module', ...partial }
}

const items: PaletteItem[] = [
  item({ id: '1', title: '周报讨论', subtitle: '整理本周工作' }),
  item({ id: '2', title: 'Weekly Sync', subtitle: 'align with team', type: 'conv-chat' }),
  item({ id: '3', title: '翻译助手', subtitle: 'Translator', type: 'assistant' }),
  item({ id: '4', title: '产品知识库', type: 'kb' })
]

describe('matchesQuery', () => {
  it('空查询全命中', () => {
    expect(matchesQuery(items[0]!, '')).toBe(true)
  })
  it('大小写不敏感匹配 title 与 subtitle', () => {
    expect(matchesQuery(items[1]!, 'weekly')).toBe(true)
    expect(matchesQuery(items[1]!, 'ALIGN')).toBe(true)
    expect(matchesQuery(items[2]!, 'translator')).toBe(true)
  })
  it('中文子串与未命中', () => {
    expect(matchesQuery(items[0]!, '本周')).toBe(true)
    expect(matchesQuery(items[3]!, '周报')).toBe(false)
  })
})

describe('filterPaletteItems', () => {
  it('空白查询：保序返回全部', () => {
    expect(filterPaletteItems(items, '   ').map((i) => i.id)).toEqual(['1', '2', '3', '4'])
  })
  it('命中保序（title 与 subtitle 任一命中）', () => {
    // id1：title「周报讨论」；id4「产品知识库」不命中
    expect(filterPaletteItems(items, '周').map((i) => i.id)).toEqual(['1'])
    expect(filterPaletteItems(items, 'translator').map((i) => i.id)).toEqual(['3'])
  })
  it('默认上限 PALETTE_LIMIT 截断', () => {
    const many = Array.from({ length: PALETTE_LIMIT + 10 }, (_, i) => item({ id: `${i}`, title: 'x' }))
    expect(filterPaletteItems(many, 'x')).toHaveLength(PALETTE_LIMIT)
  })
  it('自定义 limit', () => {
    expect(filterPaletteItems(items, '', 2)).toHaveLength(2)
  })
})

describe('nextPaletteIndex', () => {
  it('空列表恒为 -1', () => {
    expect(nextPaletteIndex(-1, 0, 1)).toBe(-1)
    expect(nextPaletteIndex(0, 0, -1)).toBe(-1)
  })
  it('从 -1 进入：向下取 0，向上取末项', () => {
    expect(nextPaletteIndex(-1, 3, 1)).toBe(0)
    expect(nextPaletteIndex(-1, 3, -1)).toBe(2)
  })
  it('循环前进/回退', () => {
    expect(nextPaletteIndex(2, 3, 1)).toBe(0)
    expect(nextPaletteIndex(0, 3, -1)).toBe(2)
    expect(nextPaletteIndex(1, 3, 1)).toBe(2)
  })
})
