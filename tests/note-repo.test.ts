// note.repo 行映射与标签转换测试
//
// 覆盖 src/main/db/repositories/note.repo.ts 的两个纯函数：
//   - rowToNote: DB 行 → Note（tags 逗号拆分/过滤、pinned 0/1→布尔）
//   - tagsToStr: string[] → 逗号分隔字符串（trim + 过滤空项）
//
// 策略：纯函数，mock dbService/mustGet 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToNote, tagsToStr } from '../src/main/db/repositories/note.repo'

const baseRow = {
  id: 'n1',
  title: '标题',
  content: '内容',
  tags: '',
  pinned: 0,
  created_at: 100,
  updated_at: 200
}

describe('rowToNote — DB 行映射为 Note', () => {
  it('基础字段原样透传', () => {
    const note = rowToNote(baseRow)
    expect(note.id).toBe('n1')
    expect(note.title).toBe('标题')
    expect(note.content).toBe('内容')
    expect(note.createdAt).toBe(100)
    expect(note.updatedAt).toBe(200)
  })

  it('tags 为空字符串 → 空数组', () => {
    expect(rowToNote(baseRow).tags).toEqual([])
  })

  it('tags 逗号分隔 → 拆分数组', () => {
    const note = rowToNote({ ...baseRow, tags: 'a,b,c' })
    expect(note.tags).toEqual(['a', 'b', 'c'])
  })

  it('tags 元素含前后空格 → trim 后保留', () => {
    const note = rowToNote({ ...baseRow, tags: '  a , b , c  ' })
    expect(note.tags).toEqual(['a', 'b', 'c'])
  })

  it('tags 含空项 → filter(Boolean) 过滤', () => {
    const note = rowToNote({ ...baseRow, tags: 'a,,b, ,c' })
    expect(note.tags).toEqual(['a', 'b', 'c'])
  })

  it('pinned=1 → true', () => {
    expect(rowToNote({ ...baseRow, pinned: 1 }).pinned).toBe(true)
  })

  it('pinned=0 → false', () => {
    expect(rowToNote({ ...baseRow, pinned: 0 }).pinned).toBe(false)
  })

  it('pinned 非 0/1 → false（严格等于 1）', () => {
    expect(rowToNote({ ...baseRow, pinned: 2 }).pinned).toBe(false)
  })
})

describe('tagsToStr — string[] 转为逗号分隔字符串', () => {
  it('undefined → 空串', () => {
    expect(tagsToStr(undefined)).toBe('')
  })

  it('空数组 → 空串', () => {
    expect(tagsToStr([])).toBe('')
  })

  it('单标签 → 无逗号', () => {
    expect(tagsToStr(['a'])).toBe('a')
  })

  it('多标签 → 逗号拼接', () => {
    expect(tagsToStr(['a', 'b', 'c'])).toBe('a,b,c')
  })

  it('元素含前后空格 → trim 后拼接', () => {
    expect(tagsToStr([' a ', '  b', 'c  '])).toBe('a,b,c')
  })

  it('含空项/空白项 → 过滤后拼接', () => {
    expect(tagsToStr(['a', '', ' ', 'b'])).toBe('a,b')
  })
})
