// @vitest-environment jsdom
// 数据健康面板的「跨会话慢事件统计」区块：聚合行渲染、标签映射、空态、模型归因
//
// 这块只能在真实应用里点出来才看得见，所以用整份报告打桩钉住渲染契约：
// 主进程只下发 PerfSummary（日志原文不过 IPC），面板负责把 label 翻成可读名。
import { describe, it, expect } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { formatBytes } from '../src/renderer/src/utils/format'
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

function report(
  perfHistory: PerfSummary[],
  kbOver: Partial<DataHealthReport['kb']> = {},
  tracesOver: Partial<DataHealthReport['traces']> = {},
  sizesOver: Partial<DataHealthReport['sizes']> = {}
): DataHealthReport {
  return {
    sizes: {
      userDataBytes: 20 * 1024 * 1024,
      dbBytes: 8 * 1024 * 1024,
      attachmentsBytes: 2 * 1024 * 1024,
      extensionsBytes: 1 * 1024 * 1024,
      logsBytes: 512 * 1024,
      otherBytes: 0,
      browserCacheBytes: 801 * 1024 * 1024,
      browserCacheFiles: 21103,
      ...sizesOver
    },
    traces: { rows: 12340, maxRowsInOneConversation: 1200, ...tracesOver },
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

/** 记录 getDataHealth 每次被调用时 refresh 传了什么（V4-Iter-177：只有「刷新」按钮该传 true） */
const refreshArgs: boolean[] = []
/** 「打开数据目录」那颗按钮的桩（V4-Iter-179） */
let openDirCalls = 0
let openDirResult: { ok: boolean; error?: string } = { ok: true }

async function mount(
  perfHistory: PerfSummary[],
  kbOver: Partial<DataHealthReport['kb']> = {},
  tracesOver: Partial<DataHealthReport['traces']> = {},
  sizesOver: Partial<DataHealthReport['sizes']> = {}
): Promise<void> {
  refreshArgs.length = 0
  openDirCalls = 0
  stubPocketai({
    openDataFolder: () => {
      openDirCalls++
      return openDirResult
    },
    getDataHealth: (refresh?: boolean) => {
      refreshArgs.push(refresh === true)
      return report(perfHistory, kbOver, tracesOver, sizesOver)
    },
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

// —— V4-Iter-174：Agent 运行账本的规模那一行 ——
// 173 那批毫秒数要落到真实库上，靠的就是这两个数出现在界面上；所以这里钉的是
// 「面板确实把报告里的 traces 渲染出来了、而且两个数各归各的位置」。
describe('数据健康面板 · Agent 分步明细（V4-Iter-174）', () => {
  it('标签 +「12,340 步 · 同一会话最多 1,200 步」逐字出现（两个数取自两个字段）', async () => {
    await mount([], {}, { rows: 12340, maxRowsInOneConversation: 1200 })
    expect(screen.getByText('Agent 分步明细')).toBeTruthy()
    expect(screen.getByText('12,340 步 · 同一会话最多 1,200 步')).toBeTruthy()
  })

  it('一行都没跑过时复用 Agent 面板那句「暂无分步明细」，不摆 0 步', async () => {
    await mount([], {}, { rows: 0, maxRowsInOneConversation: 0 })
    expect(screen.getByText('暂无分步明细')).toBeTruthy()
    expect(screen.queryByText(/0 步/)).toBeNull()
  })

  it('rows=0 但 max 非 0（库里被清空过）也走空态——判据是行数，与向量那张卡同形', async () => {
    await mount([], {}, { rows: 0, maxRowsInOneConversation: 500 })
    expect(screen.getByText('暂无分步明细')).toBeTruthy()
    expect(screen.queryByText(/500/)).toBeNull()
  })
})

// —— V4-Iter-177：浏览器缓存不进合计、且只有「刷新」才重算 ——
describe('数据健康面板 · 浏览器缓存单列（V4-Iter-177）', () => {
  it('「浏览器缓存」那一行逐字显示字节 + 文件数', async () => {
    await mount([], {}, {}, { browserCacheBytes: 801 * 1024 * 1024, browserCacheFiles: 21103 })
    expect(screen.getByText('浏览器缓存')).toBeTruthy()
    expect(screen.getByText(`${formatBytes(801 * 1024 * 1024)} · 21,103 个文件`)).toBeTruthy()
  })

  it('合计读 userDataBytes，不掺缓存字节（缓存并进合计就该红）', async () => {
    await mount([], {}, {}, { userDataBytes: 20 * 1024 * 1024, browserCacheBytes: 801 * 1024 * 1024 })
    const card = screen.getByText('数据合计').parentElement
    expect(card?.textContent).toContain(formatBytes(20 * 1024 * 1024))
    expect(card?.textContent).not.toContain(formatBytes(821 * 1024 * 1024))
  })

  it('只有那颗「刷新」按钮把 refresh=true 传给主进程；挂载那一次传 false', async () => {
    await mount([])
    expect(refreshArgs).toEqual([false])
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => expect(refreshArgs).toEqual([false, true]))
  })
})

// —— V4-Iter-179：缓存那一格旁边的「打开数据目录」 ——
describe('数据健康面板 · 打开数据目录（V4-Iter-179）', () => {
  it('点一次发一次通道；成功时不许冒出错误 toast', async () => {
    openDirResult = { ok: true }
    await mount([])
    fireEvent.click(screen.getByText('打开数据目录'))
    await waitFor(() => expect(openDirCalls).toBe(1))
    expect(screen.queryByText(/操作失败/)).toBeNull()
  })

  it('主进程报失败时必须弹出具体的那句话说给用户（不能"点了没反应"）', async () => {
    openDirResult = { ok: false, error: '无法打开此位置' }
    await mount([])
    fireEvent.click(screen.getByText('打开数据目录'))
    expect(await screen.findByText('操作失败：无法打开此位置')).toBeTruthy()
  })
})
