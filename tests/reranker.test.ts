// RAG reranker 纯函数测试（parseRerankScores）
import { describe, it, expect, vi } from 'vitest'

// providerManager 依赖 electron app，测试纯函数时 mock 掉
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

import { parseRerankScores } from '../src/main/knowledge/reranker'

describe('parseRerankScores', () => {
  it('正常 JSON 数组 → 按 id 映射到 scores', () => {
    const text = '[{"id":1,"score":0.9},{"id":2,"score":0.3},{"id":3,"score":0.7}]'
    expect(parseRerankScores(text, 3)).toEqual([0.9, 0.3, 0.7])
  })

  it('LLM 输出带 markdown 代码块 → 仍能提取数组', () => {
    const text = '```json\n[{"id":1,"score":0.8},{"id":2,"score":0.6}]\n```'
    expect(parseRerankScores(text, 2)).toEqual([0.8, 0.6])
  })

  it('LLM 输出带前后解释文字 → 提取中间数组', () => {
    const text = '好的，评分如下：\n[{"id":1,"score":1.0},{"id":2,"score":0.0}]\n以上是结果。'
    expect(parseRerankScores(text, 2)).toEqual([1.0, 0.0])
  })

  it('部分 id 缺失 → 对应位置填 0', () => {
    const text = '[{"id":2,"score":0.5}]'
    expect(parseRerankScores(text, 3)).toEqual([0, 0.5, 0])
  })

  it('全部为 0 分 → 返回 null（视为无效）', () => {
    const text = '[{"id":1,"score":0},{"id":2,"score":0}]'
    expect(parseRerankScores(text, 2)).toBeNull()
  })

  it('无效 JSON → null', () => {
    expect(parseRerankScores('not json at all', 2)).toBeNull()
    expect(parseRerankScores('[{id:1,score:0.5}]', 2)).toBeNull()
  })

  it('非数组 JSON → null', () => {
    expect(parseRerankScores('{"id":1,"score":0.5}', 2)).toBeNull()
  })

  it('分数超出 0-1 范围 → 忽略该项', () => {
    const text = '[{"id":1,"score":1.5},{"id":2,"score":0.8}]'
    expect(parseRerankScores(text, 2)).toEqual([0, 0.8])
  })

  it('id 为字符串数字 → 正常解析', () => {
    const text = '[{"id":"1","score":0.9},{"id":"2","score":0.4}]'
    expect(parseRerankScores(text, 2)).toEqual([0.9, 0.4])
  })

  it('id 越界 → 忽略', () => {
    const text = '[{"id":99,"score":0.9},{"id":1,"score":0.5}]'
    expect(parseRerankScores(text, 2)).toEqual([0.5, 0])
  })
})
