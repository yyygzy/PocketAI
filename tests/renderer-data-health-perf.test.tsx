// @vitest-environment jsdom
// 数据健康面板的「跨会话慢事件统计」区块：聚合行渲染、标签映射、空态、模型归因
//
// 这块只能在真实应用里点出来才看得见，所以用整份报告打桩钉住渲染契约：
// 主进程只下发 PerfSummary（日志原文不过 IPC），面板负责把 label 翻成可读名。
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import type { DataHealthReport, PerfSummary } from '../src/shared/types'

const summary = (over: Partial<PerfSummary> = {}): PerfSummary => ({
  label: 'kb.ingest',
  count: 3,
  p50Ms: 1000,
  maxMs: 9000,
  lastAt: new Date('2026-10-10T08:12:34').getTime(),
  byModel: [],
  ...over
})

function report(perfHistory: PerfSummary[], kbOver: Partial<DataHealthReport['kb']> = {}): DataHealthReport {
  return {
    sizes: {
      dataDirBytes: 20 * 1024 * 1024,
      dbBytes: 8 * 1024 * 1024,
      vectorDbBytes: 4 * 1024 * 1024,
      attachmentsBytes: 2 * 1024 * 1024,
      extensionsBytes: 1 * 1024 * 1024,
      logsBytes: 512 * 1024,
      otherBytes: 0
    },
    kb: {
      total: 2,
      byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 2, error: 0 },
      errorDocs: [],
      integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
      vectorIndex: { count: 0, dims: [] },
      ...kbOver
    },
    backup: { configured: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
    tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
    boot: { stages: [{ id: 'window', ms: 900 }], totalMs: 900 },
    recentPerf: [{ label: 'kb.retrieve', ms: 4200, at: new Date('2026-10-10T08:20:00').getTime() }],
    perfHistory
  }
}

async function mount(perfHistory: PerfSummary[], kbOver: Partial<DataHealthReport['kb']> = {}): Promise<void> {
  stubPocketai({
    getDataHealth: () => report(perfHistory, kbOver),
    cleanKbOrphans: () => ({ removedVectors: 0, removedChunks: 0 }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    deduplicateKbDocs: () => ({ removed: 0 })
  })
  mountWithProviders(<DataHealthPanel />)
  await screen.findByText('跨会话慢事件统计')
}

describe('数据健康面板 · 跨会话慢事件', () => {
  it('聚合行显示次数/中位/峰值，label 走字典映射', async () => {
    await mount([summary()])
    expect(screen.getByText('知识库入库')).toBeTruthy()
    const row = screen.getByText(/3 次 · 中位 1000ms · 峰值 9000ms/)
    expect(row.textContent).toContain('2026')
  })

  it('未知 label 原样显示（字典没这条也不崩，肉眼仍可对应日志标签）', async () => {
    await mount([summary({ label: 'weird.label', count: 1, p50Ms: 50, maxMs: 50 })])
    expect(screen.getByText('weird.label')).toBeTruthy()
  })

  it('空统计显示空态而不是空表', async () => {
    await mount([])
    expect(screen.getByText('暂无统计（日志里还没有超过阈值的记录）')).toBeTruthy()
  })

it('模型细分渲染成子行（哪个模型慢要一眼看得见）', async () => {
    await mount([
      summary({
        byModel: [
          { model: 'deepseek-reasoner', count: 2, p50Ms: 6100, maxMs: 9200 },
          { model: 'glm-4', count: 1, p50Ms: 5200, maxMs: 5200 }
        ]
      })
    ])
    expect(screen.getByText('· deepseek-reasoner')).toBeTruthy()
    expect(screen.getByText('2 次 · 中位 6100ms · 峰值 9200ms')).toBeTruthy()
    expect(screen.getByText('· glm-4')).toBeTruthy()
  })

  it('lastAt 为 0（日志行没时间戳）时显示 -，不输出 1970', async () => {
    await mount([summary({ lastAt: 0 })])
    expect(screen.getByText(/· 最近 -$/)).toBeTruthy()
  })
})
// —— V4-Iter-172：B48 对账现查的缺口 ——
// 向量索引那张卡的**数据源**（真库 5 例）与**文案函数**（4 例）早有 CI，
// 但 DataHealthPanel 上那一行本身没有任何挂载用例 ⇒ "卡片到底显示了什么"没人证。
describe('数据健康面板 · 向量索引卡片（V4-Iter-172 补）', () => {
  it('真规模走 kb.vectorIndex：「1,240 条 · 1024 维」逐字出现', async () => {
    await mount([], { vectorIndex: { count: 1240, dims: [1024] } })
    expect(screen.getByText('向量索引')).toBeTruthy()
    expect(screen.getByText('1,240 条 · 1024 维')).toBeTruthy()
  })

  it('混过两套 embedding 模型 ⇒ 维度并列（这是 dim-mismatch 的现场证据，不许压成一个数）', async () => {
    await mount([], { vectorIndex: { count: 5, dims: [512, 1024] } })
    expect(screen.getByText('5 条 · 512/1024 维')).toBeTruthy()
  })

  it('从未建索引显示「未建立」，不是 0 条也不是历史的 "-"（dims 有值也一样，条数才是判据）', async () => {
    await mount([], { vectorIndex: { count: 0, dims: [1024] } })
    expect(screen.getByText('未建立')).toBeTruthy()
    expect(screen.queryByText(/0 条/)).toBeNull()
  })
})
