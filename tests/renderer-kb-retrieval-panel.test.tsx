// 检索测试面板的显示层（B60 ②、B63 ①、B64 ③、B65 ①②④）——能 DOM 断言的那一半搬进 CI
// @vitest-environment jsdom
//
// 为什么能搬：`RetrievalTest` 只吃 kbId/topN 加一条 IPC（retrieveKbDebug），挂得起；
// 此前这几条被判成"只能真机看"，其实看的是**数字有没有出现在对的位置**，那是 DOM 断言的活。
// 剩下真正只有肉眼的：徽标的配色、宽度挤压、输入框排版——那些留在校验清单里。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { RetrievalTest } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { RetrievedChunk } from '../src/shared/types'

type Chunk = RetrievedChunk

const retrieveKbDebug = vi.hoisted(() => vi.fn())

function chunk(over: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'c1',
    docId: 'd1',
    kbId: 'kb1',
    seq: 0,
    docTitle: '退款手册',
    content: '7 天内可退款，生鲜类除外。',
    score: 0.01639344262295082,
    sources: ['vector', 'bm25'],
    ...over
  }
}

const diag = (over: Record<string, unknown> = {}): unknown => ({
  hydeUsed: false,
  queryVariants: ['退款政策'],
  vectorHits: 4,
  bm25Hits: 2,
  rerankUsed: false,
  candidateCount: 6,
  filteredByThreshold: 0,
  degradations: [],
  timings: { hydeMs: 0, multiQueryMs: 0, searchMs: 12, rerankMs: 0, mmrMs: 1, totalMs: 15 },
  ...over
})

/** 挂载面板 → 输入问题 → 点搜索 → 等结果渲染出来 */
async function mountAndSearch(payload: { chunks: Chunk[]; diagnostics: unknown }, topN = 2) {
  // 组件读的是 `r.result.chunks` 与 `r.diagnostics`（retrieveKbDebug 的真实返回形状）
  retrieveKbDebug.mockResolvedValue({
    result: { query: '退款政策', chunks: payload.chunks },
    diagnostics: payload.diagnostics
  } as never)
  stubPocketai({ retrieveKbDebug })
  mountWithProviders(<RetrievalTest kbId="kb1" topN={topN} />)
  fireEvent.change(screen.getByPlaceholderText(zh['kb.searchPh']), { target: { value: '退款政策' } })
  fireEvent.click(screen.getByText(zh['kb.search']))
  await waitFor(() => expect(retrieveKbDebug).toHaveBeenCalledWith(['kb1'], '退款政策'))
}

beforeEach(() => {
  retrieveKbDebug.mockReset()
})

describe('检索测试面板：降级徽标（B63 ①）', () => {
  it('有降级 ⇒ 出现「本次检索有 N 路降级」，悬停逐条带 stage(kbId)：reason', async () => {
    await mountAndSearch({
      chunks: [chunk()],
      diagnostics: diag({
        degradations: [
          { stage: 'vector', kbId: 'kb1', reason: '向量化或向量检索失败：embedding 服务 502' },
          { stage: 'mmr', reason: '向量多样性计算失败' }
        ]
      })
    })
    const badge = screen.getByText(zh['kb.diagDegraded'].replace('{n}', '2'))
    expect(badge).toBeTruthy()
    const tip = (badge.getAttribute('title') ?? '')
    expect(tip).toContain('vector(kb1)：向量化或向量检索失败：embedding 服务 502')
    expect(tip).toContain('mmr：向量多样性计算失败')
  })

  it('反向对照：没有降级时**不该**出现这枚徽标（否则面板永远是假警报）', async () => {
    await mountAndSearch({ chunks: [chunk()], diagnostics: diag() })
    expect(screen.queryByText(zh['kb.diagDegraded'].replace('{n}', '0'))).toBeNull()
    expect(screen.queryByText(/降级/)).toBeNull()
  })
})

describe('检索测试面板：相似度显示（B65 ①②④）', () => {
  it('每条命中显示自己的相似度（两位小数），上方一行分布摘要', async () => {
    await mountAndSearch({
      chunks: [chunk({ chunkId: 'c1', similarity: 0.9123 }), chunk({ chunkId: 'c2', similarity: 0.31 })],
      diagnostics: diag({ filteredByThreshold: 1 })
    })
    expect(screen.getByText(zh['kb.simValue'].replace('{v}', '0.91'))).toBeTruthy()
    expect(screen.getByText(zh['kb.simValue'].replace('{v}', '0.31'))).toBeTruthy()
    // 分布摘要逐字：条数只数算得出相似度的那些
    expect(
      screen.getByText(
        zh['kb.simStats']
          .replace('{n}', '2')
          .replace('{min}', '0.31')
          .replace('{med}', '0.61')
          .replace('{max}', '0.91')
      )
    ).toBeTruthy()
    // 悬停那句是用户唯一能读到"阈值该怎么画"的地方，文案与语义都得在
    const line = screen.getByText(new RegExp(`^${zh['kb.simStats'].split('{n}')[0]}`))
    expect(line.getAttribute('title')).toBe(zh['kb.simStatsHint'])
    expect(line.getAttribute('title')).toContain('本次检索所用查询向量')
  })

  it('反向对照：算不出相似度的片段**不显示** sim，也不显示成 0.00 这种假数', async () => {
    await mountAndSearch({
      chunks: [chunk({ chunkId: 'c1', similarity: undefined })],
      diagnostics: diag()
    })
    expect(screen.queryByText(new RegExp(`^${zh['kb.simValue'].split('{v}')[0]}`))).toBeNull()
    expect(screen.queryByText(/sim 0\.00/)).toBeNull()
    // 一条都算不出来 ⇒ 整行摘要不出现（而不是"相似度：0 条 / 最低 0.00…"）
    expect(screen.queryByText(/相似度：/)).toBeNull()
  })

  it('相似度与排名分同时在场（用户要能看出 score 是名次、sim 才是相关性）', async () => {
    await mountAndSearch({ chunks: [chunk({ similarity: 0.5 })], diagnostics: diag() })
    expect(screen.getByText('sim 0.50')).toBeTruthy()
    expect(screen.getByText(/score 0\.0164/)).toBeTruthy()
  })
})

describe('检索测试面板：阈值滤掉条数与注入条数（B64 ③、B60 ②）', () => {
  it('filteredByThreshold>0 ⇒ 出现「阈值滤掉 N 条」，数字来自诊断而不是本地猜', async () => {
    await mountAndSearch({ chunks: [chunk()], diagnostics: diag({ filteredByThreshold: 3 }) })
    expect(screen.getByText(zh['kb.diagFiltered'].replace('{n}', '3'))).toBeTruthy()
  })

  it('等于 0 时不显示（不制造"阈值在干活"的错觉）', async () => {
    await mountAndSearch({ chunks: [chunk()], diagnostics: diag({ filteredByThreshold: 0 }) })
    expect(screen.queryByText(/阈值滤掉/)).toBeNull()
  })

  it('底部那句必须显示**该库配置的 topN**（B60 的前提：这句以前报的是没生效的数字）', async () => {
    await mountAndSearch({ chunks: [chunk()], diagnostics: diag() }, 2)
    expect(screen.getByText(zh['kb.injectHint'].replace('{n}', '2'))).toBeTruthy()
  })
})
