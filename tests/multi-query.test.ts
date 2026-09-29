// Multi-Query 变体查询解析（纯函数）测试
import { describe, it, expect, vi } from 'vitest'

// mock providerManager，避免加载真实 provider 链路
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

import {
  parseMultiQueries,
  MAX_MULTI_QUERIES,
  MAX_VARIANT_CHARS
} from '../src/main/knowledge/multi-query'

describe('parseMultiQueries — LLM 输出解析', () => {
  it('每行一个查询，去空行', () => {
    expect(parseMultiQueries('查询一\n查询二\n\n查询三')).toEqual(['查询一', '查询二', '查询三'])
  })

  it('去常见序号/列表前缀（1. 1、1) - *）', () => {
    expect(parseMultiQueries('1. 查询A\n2、查询B\n3) 查询C\n* 查询D')).toEqual([
      '查询A',
      '查询B',
      '查询C',
      '查询D'
    ])
  })

  it('去重（完全相同的行只保留一次）', () => {
    expect(parseMultiQueries('查询A\n查询A\n查询B')).toEqual(['查询A', '查询B'])
  })

  it('限量 MAX_MULTI_QUERIES 条', () => {
    const text = Array.from({ length: 10 }, (_, i) => `查询${i + 1}`).join('\n')
    const out = parseMultiQueries(text)
    expect(out).toHaveLength(MAX_MULTI_QUERIES)
    expect(out[0]).toBe('查询1')
  })

  it('超过单条长度上限的行被丢弃', () => {
    const long = '长'.repeat(MAX_VARIANT_CHARS + 1)
    expect(parseMultiQueries(`正常查询\n${long}`)).toEqual(['正常查询'])
  })

  it('空输入/无有效行返回空数组', () => {
    expect(parseMultiQueries('')).toEqual([])
    expect(parseMultiQueries('\n\n  \n')).toEqual([])
  })

  it('null/undefined 容错返回空数组', () => {
    expect(parseMultiQueries(null as unknown as string)).toEqual([])
    expect(parseMultiQueries(undefined as unknown as string)).toEqual([])
  })
})
