// RAG reranker 测试：parseRerankScores 纯函数 + rerankChunks 的降级回调（A3）
import { describe, it, expect, vi } from 'vitest'

/** 可控 adapter 桩：rerankChunks 的三条降级路都靠它触发 */
const H = vi.hoisted(() => ({
  adapter: null as { streamChat: (...args: unknown[]) => Promise<{ content: string }> } | null
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => H.adapter }
}))

import { parseRerankScores, rerankChunks } from '../src/main/knowledge/reranker'
import type { RetrievedChunk } from '../src/shared/types'

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

// A3：重排失败以前与「重排后恰好还是这个顺序」外部无法区分，于是注入质量掉一档没人知道。
// rerankChunks 的第 5 个参数就是为了把原因说出来——这几条钉住「说了什么」和「什么时候不该说」。
describe('rerankChunks 的降级回调', () => {
  const chunks: RetrievedChunk[] = [
    { chunkId: 'a', docId: 'd1', kbId: 'k1', seq: 0, docTitle: 'T1', content: '甲', score: 0.1 },
    { chunkId: 'b', docId: 'd2', kbId: 'k1', seq: 1, docTitle: 'T2', content: '乙', score: 0.2 }
  ]

  it('没有 adapter ⇒ 报「找不到服务商」，顺序原样退回', async () => {
    H.adapter = null
    const reasons: string[] = []
    const out = await rerankChunks('q', chunks, 'pX', 'm1', (r) => reasons.push(r))
    expect(out.map((c) => c.chunkId)).toEqual(['a', 'b'])
    expect(reasons).toEqual(['找不到服务商 adapter：pX'])
  })

  it('模型输出解析不出分 ⇒ 报解析失败，顺序原样退回', async () => {
    H.adapter = { streamChat: async () => ({ content: '我觉得都挺相关的' }) }
    const reasons: string[] = []
    const out = await rerankChunks('q', chunks, 'p1', 'm1', (r) => reasons.push(r))
    expect(out.map((c) => c.chunkId)).toEqual(['a', 'b'])
    expect(reasons[0]).toContain('解析不出任何非零分')
  })

  it('调用抛错 ⇒ 把错误信息带进原因（不是只说「失败了」）', async () => {
    H.adapter = {
      streamChat: async () => {
        throw new Error('429 too many requests')
      }
    }
    const reasons: string[] = []
    const out = await rerankChunks('q', chunks, 'p1', 'm1', (r) => reasons.push(r))
    expect(out.map((c) => c.chunkId)).toEqual(['a', 'b'])
    expect(reasons[0]).toContain('429 too many requests')
  })

  it('反向对照：正常打分既不改回调顺序也不报降级', async () => {
    H.adapter = { streamChat: async () => ({ content: '[{"id":1,"score":0.1},{"id":2,"score":0.9}]' }) }
    const reasons: string[] = []
    const out = await rerankChunks('q', chunks, 'p1', 'm1', (r) => reasons.push(r))
    expect(out.map((c) => c.chunkId)).toEqual(['b', 'a'])
    expect(reasons).toEqual([])
  })

  it('只有一条候选时无需重排，这不算降级（别把面板刷出假警报）', async () => {
    H.adapter = null
    const reasons: string[] = []
    await rerankChunks('q', [chunks[0]!], 'p1', 'm1', (r) => reasons.push(r))
    expect(reasons).toEqual([])
  })
})
