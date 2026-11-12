// @vitest-environment jsdom
// 冷数据/快照/审批条数已从设置页「数据健康」并入平台管家「数据健康」卡（同一批 Row）。
// 口径要求：
// ① 读到多少画多少（0 也是真实读数）；
// ② 没读成只摆一句原因 + 页头全局重试，**不许**把失败演成 0 B／暂无审批记录；
// ③ 冷数据仍不放「一键清空」——会跟引用关系与还原入口打架。
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const T = (key: string, params: Record<string, string | number>): string => {
  let out = L(key)
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v))
  return out
}

const report = (over: Partial<DataHealthReport['sizes']> = {}, approvalsRows = 0): DataHealthReport => ({
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
    browserCacheFiles: 0,
    ...over
  },
  approvals: { rows: approvalsRows, writeFailures: 0 },
  kb: {
    total: 0,
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: { configured: false, passwordUndecryptable: false, configUnreadable: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
  tasks: { kbHealthCheckLastRunAt: null, kbHealthCheckLastOk: null, backupVerifyLastRunAt: null, backupVerifyLastOk: null }
})

const stubs = (over: Record<string, () => unknown> = {}): Record<string, () => unknown> => ({
  getHardwareInfo: () => ({
    ok: true,
    data: {
      cpu: { model: 'Test CPU', cores: 4 },
      memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
      gpus: [],
      disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false },
      os: { platform: 'win32', release: '10', arch: 'x64', hostname: 'test-host' }
    }
  }),
  checkIntegrity: () => ({ ok: true, data: { ok: true, details: 'ok' } }),
  getHealthReport: () => ({
    ok: true,
    data: { totalConversations: 1, totalMessages: 2, kbCount: 0, totalAttachmentsBytes: 0, orphanMessages: 0, orphanChunks: 0 }
  }),
  getDataHealth: () => report(),
  recommendModels: () => ({ ok: true, data: null }),
  getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
  onOllamaPullEvent: () => () => {},
  ...over
})

describe('冷数据/快照/审批条数并入管家数据健康卡', () => {
  it('三项各自一行，读到多少画多少', async () => {
    stubPocketai(stubs({ getDataHealth: () => report({}, 7) }))
    mountWithProviders(<StewardModule />)
    await screen.findByText(L('dh.coldOffload'))

    expect(screen.getByText(T('dh.coldOffloadValue', { bytes: '5.0 MB', count: (3).toLocaleString('en-US') }))).toBeTruthy()
    expect(screen.getByText(T('dh.coldSnapshotValue', { bytes: '2.0 MB', count: (2).toLocaleString('en-US') }))).toBeTruthy()
    expect(screen.getByText(T('dh.approvals.value', { rows: (7).toLocaleString('en-US') }))).toBeTruthy()
  })

  it('跑成了但都是 0：如实写 0 B／暂无审批记录（与"没跑成"分开）', async () => {
    stubPocketai(stubs({ getDataHealth: () => report({ coldOffloadBytes: 0, coldOffloadFiles: 0, coldSnapshotBytes: 0, coldSnapshotFiles: 0 }, 0) }))
    mountWithProviders(<StewardModule />)
    await screen.findByText(L('dh.coldOffload'))

    expect(screen.getByText(T('dh.coldOffloadValue', { bytes: '0 B', count: (0).toLocaleString('en-US') }))).toBeTruthy()
    expect(screen.getByText(T('dh.coldSnapshotValue', { bytes: '0 B', count: (0).toLocaleString('en-US') }))).toBeTruthy()
    expect(screen.getByText(L('dh.approvals.empty'))).toBeTruthy()
  })

  it('没读成：只摆原因，不拿 0 冒充', async () => {
    stubPocketai(stubs({ getDataHealth: () => ({ ok: false, data: undefined, error: '冷数据读取失败' }) }))
    mountWithProviders(<StewardModule />)
    await screen.findByText(/冷数据读取失败/)

    expect(screen.queryByText(L('dh.coldOffload'))).toBeNull()
    expect(screen.queryByText(L('dh.coldSnapshots'))).toBeNull()
    expect(screen.queryByText(L('dh.approvals.empty'))).toBeNull()
    expect(screen.queryByText(T('dh.coldOffloadValue', { bytes: '0 B', count: (0).toLocaleString('en-US') }))).toBeNull()
  })

  it('冷数据区没有"一键清空"按钮', async () => {
    stubPocketai(stubs())
    mountWithProviders(<StewardModule />)
    await screen.findByText(L('dh.coldOffload'))

    const buttons = screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim())
    expect(buttons.some((text) => /冷|卸载|快照/.test(text))).toBe(false)
  })
})

// 审批记录：条数与「能清」放在同一张卡上（V4-Iter-2xx 从设置页「数据健康」搬来）。
// 两条各守一侧：清成了要看得见条数归零 + 成功回执；没清成要看得见原因，且条数与按钮都不许被演成"清过了"。
describe('审批记录清空：按钮搬进管家数据健康卡', () => {
  it('能清：确认后调 clearApprovalRecords，条数回到 0 并给成功回执', async () => {
    let reads = 0
    stubPocketai(
      stubs({
        // 第一次是挂载时的读（7 条），清完那次重读回到 0
        getDataHealth: () => {
          reads += 1
          return report({}, reads === 1 ? 7 : 0)
        },
        clearApprovalRecords: () => ({ cleared: 7 })
      })
    )
    mountWithProviders(<StewardModule />)
    await screen.findByText(T('dh.approvals.value', { rows: (7).toLocaleString('en-US') }))

    fireEvent.click(screen.getByRole('button', { name: L('dh.approvals.clear') }))
    await waitFor(() => expect(screen.queryByText(L('common.confirm'))).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: L('common.confirm') }))

    await waitFor(() => expect(screen.queryByText(L('dh.approvals.empty'))).not.toBeNull())
    await waitFor(() =>
      expect(screen.queryAllByRole('status').map((e) => e.textContent).join('|')).toContain(
        T('dh.approvals.clearDone', { count: 7 })
      )
    )
  })

  it('失败可见：回 {ok:false} ⇒ 弹原因、条数照旧、按钮仍可再点', async () => {
    stubPocketai(
      stubs({
        getDataHealth: () => report({}, 7),
        clearApprovalRecords: () => ({ ok: false, error: '账本被占用' })
      })
    )
    mountWithProviders(<StewardModule />)
    await screen.findByText(T('dh.approvals.value', { rows: (7).toLocaleString('en-US') }))

    fireEvent.click(screen.getByRole('button', { name: L('dh.approvals.clear') }))
    await waitFor(() => expect(screen.queryByText(L('common.confirm'))).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: L('common.confirm') }))

    await waitFor(() =>
      expect(screen.queryAllByRole('status').map((e) => e.textContent).join('|')).toContain('账本被占用')
    )
    expect(screen.getByText(T('dh.approvals.value', { rows: (7).toLocaleString('en-US') }))).toBeTruthy()
    expect((screen.getByRole('button', { name: L('dh.approvals.clear') }) as HTMLButtonElement).disabled).toBe(false)
  })
})
