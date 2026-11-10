// @vitest-environment jsdom
// P0-5 第三批③：数据健康把冷数据单列（体积与条数）上屏，且**不放一键清空**。
// 清空按钮故意不做——会跟引用关系与还原入口打架。
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
  approvals: { rows: 0, writeFailures: 0 },
  kb: {
    total: 0,
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: { configured: false, passwordUndecryptable: false, configUnreadable: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
  tasks: { kbHealthCheckLastRunAt: null, kbHealthCheckLastOk: null, backupVerifyLastRunAt: null, backupVerifyLastOk: null }
})

describe('冷数据单列：体积 + 条数', () => {
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
