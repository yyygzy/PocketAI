// @vitest-environment jsdom
// P0-5 第三批③：数据健康把冷数据单列（体积与条数）+ 三路清理失败计数上屏，且**不放一键清空**。
//
// 三个数各自显示、不做合计：删会话目录失败 / 淘汰失败 / 快照淘汰失败 是三条不同的坏法，
// 合成一个数会让用户以为"冷数据整体坏了"。清空按钮故意不做——会跟引用关系与还原入口打架。
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const T = (key: string, params: Record<string, string | number>): string => {
  let out = L(key)
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v))
  return out
}

const report = (): DataHealthReport => ({
  sizes: {
    userDataBytes: 20 * 1024 * 1024,
    dbBytes: 10 * 1024 * 1024,
    attachmentsBytes: 3 * 1024 * 1024,
    extensionsBytes: 0,
    logsBytes: 0,
    coldOffloadBytes: 5 * 1024 * 1024,
    coldOffloadFiles: 3,
    coldSnapshotBytes: 2 * 1024 * 1024,
    coldSnapshotFiles: 2,
    otherBytes: 0,
    browserCacheBytes: 0,
    browserCacheFiles: 0
  },
  coldFailures: { purge: 1, offloadPrune: 2, snapshotPrune: 0 },
  traces: { rows: 0, maxRowsInOneConversation: 0 },
  approvals: { rows: 0, writeFailures: 0 },
  kb: {
    total: 0,
    byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 },
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: { configured: false, passwordUndecryptable: false, configUnreadable: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
  tasks: { kbHealthCheckLastRunAt: null, kbHealthCheckLastOk: null, backupVerifyLastRunAt: null, backupVerifyLastOk: null },
  boot: { stages: [], totalMs: 0 },
  recentPerf: [],
  perfHistory: []
})

describe('冷数据单列：体积 + 条数 + 三路失败计数', () => {
  it('卸载文件与快照各自一行，条数不是"0 B"那种含糊读数', async () => {
    stubPocketai({ getDataHealth: () => report() })
    mountWithProviders(<DataHealthPanel />)
    await screen.findByText(L('dh.total'))

    expect(
      screen.getByText(
        T('dh.coldOffloadValue', {
          bytes: '5.0 MB',
          count: (3).toLocaleString('en-US')
        })
      )
    ).toBeTruthy()
    expect(
      screen.getByText(
        T('dh.coldSnapshotValue', {
          bytes: '2.0 MB',
          count: (2).toLocaleString('en-US')
        })
      )
    ).toBeTruthy()
  })

  it('三路失败计数各自上屏（0 也照实显示），并说明只在本次运行内累计', async () => {
    stubPocketai({ getDataHealth: () => report() })
    mountWithProviders(<DataHealthPanel />)
    await screen.findByText(L('dh.total'))

    expect(
      screen.getByText(
        T('dh.coldFailuresValue', { purge: 1, prune: 2, snapshot: 0 })
      )
    ).toBeTruthy()
    expect(screen.getByText(L('dh.coldFailuresHint'))).toBeTruthy()
  })

  it('冷数据区没有"一键清空"按钮', async () => {
    stubPocketai({ getDataHealth: () => report() })
    mountWithProviders(<DataHealthPanel />)
    await screen.findByText(L('dh.total'))

    await waitFor(() => {
      const buttons = screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim())
      expect(buttons.some((text) => /冷|卸载|快照/.test(text))).toBe(false)
    })
  })
})
