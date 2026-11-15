// P2-2 渲染面：数据健康面板里「维护任务」那一格开放开关与间隔。
//
// 钉住四件事：
// 1. 控件按主进程目录回的值摆（kb 6h／备份校验 24h），不把值画成第一档
// 2. 取消勾选 / 改间隔都只发这两粒参数，且以主进程回执为准（回执说什么屏上就是什么）
// 3. 主进程拒了（非法间隔）⇒ 屏上不跟着变，并把原因说出来（不许静默装作保存成功）
// 4. 设置读失败 ⇒ 出那句原因，且两行「上次执行」照旧在（读不到节奏 ≠ 这一格空白）
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport, MaintenanceTaskSchedule } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const zeroSizes: DataHealthReport['sizes'] = {
  userDataBytes: 1024,
  dbBytes: 1024,
  attachmentsBytes: 0,
  extensionsBytes: 0,
  logsBytes: 0,
  coldOffloadBytes: 0,
  coldOffloadFiles: 0,
  coldSnapshotBytes: 0,
  coldSnapshotFiles: 0,
  otherBytes: 0,
  browserCacheBytes: 0,
  browserCacheFiles: 0
}

const reportOf: DataHealthReport = {
  sizes: zeroSizes,
  approvals: { rows: 0, writeFailures: 0 },
  kb: {
    total: 0,
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: {
    configured: false, passwordUndecryptable: false, configUnreadable: false,
    enabled: false, intervalHours: 6, lastRunAt: null, lastOkAt: null, lastError: null
  },
  tasks: {
    kbHealthCheckLastRunAt: null,
    kbHealthCheckLastOk: null,
    backupVerifyLastRunAt: null,
    backupVerifyLastOk: null
  }
}

const kbSchedule: MaintenanceTaskSchedule = { key: 'kb_health_check', enabled: true, intervalHours: 6, lastRunAt: null, lastOk: null }
const verifySchedule: MaintenanceTaskSchedule = { key: 'backup_verify', enabled: true, intervalHours: 24, lastRunAt: null, lastOk: null }

/** 面板挂载即读的那几发（缺一发桩就当场抛，见 helper 顶部说明） */
function baseImpls(over: Record<string, (...args: any[]) => unknown> = {}): Record<string, (...args: any[]) => unknown> {
  return {
    getDataHealth: () => reportOf,
    openDataFolder: () => ({ ok: true }),
    cleanKbOrphans: () => ({ removedVectors: 0, removedChunks: 0 }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    deduplicateKbDocs: () => ({ removed: 0 }),
    listTaskSchedules: () => [kbSchedule, verifySchedule],
    setTaskSchedule: (key: string, patch: { enabled?: boolean; intervalHours?: number }) => ({
      ok: true,
      task: { ...(key === 'kb_health_check' ? kbSchedule : verifySchedule), ...patch }
    }),
    ...over
  }
}

const selectOf = (testId: string): HTMLSelectElement => screen.getByTestId(testId) as HTMLSelectElement
const checkboxOf = (testId: string): HTMLInputElement => screen.getByTestId(testId) as HTMLInputElement

describe('① 目录回什么就摆什么', () => {
  it('两条任务的开关与间隔按回值渲染（6h / 24h，不是一律第一档）', async () => {
    stubPocketai(baseImpls())
    mountWithProviders(<DataHealthPanel />)

    const kb = (await screen.findByTestId('dh-task-interval-kb_health_check')) as HTMLSelectElement
    const verify = selectOf('dh-task-interval-backup_verify')
    expect(kb.value).toBe('6')
    expect(verify.value).toBe('24')
    expect(checkboxOf('dh-task-enabled-kb_health_check').checked).toBe(true)
    expect(checkboxOf('dh-task-enabled-backup_verify').checked).toBe(true)
    // 两行「上次执行」照旧在（关掉控件不等于关掉这一格的信息）
    expect(screen.queryByText(L('dh.task.kbHealthCheck'))).not.toBeNull()
    expect(screen.queryByText(L('dh.task.backupVerify'))).not.toBeNull()
    // 读成功时不出那行失败提示
    expect(screen.queryByTestId('dh-tasks-config-fail')).toBeNull()
  })
})

describe('② 改开关／间隔只发这两粒，并以回执为准', () => {
  it('取消勾选 → 发 {enabled:false}，回执后屏上出「已关闭」', async () => {
    stubPocketai(baseImpls())
    mountWithProviders(<DataHealthPanel />)
    const box = (await screen.findByTestId('dh-task-enabled-kb_health_check')) as HTMLInputElement

    fireEvent.click(box)

    await waitFor(() => {
      const call = pocketaiCalls().find((c) => c.fn === 'setTaskSchedule')
      expect(call?.args).toEqual(['kb_health_check', { enabled: false }])
    })
    await screen.findByTestId('dh-task-off-kb_health_check')
    expect(checkboxOf('dh-task-enabled-kb_health_check').checked).toBe(false)
  })

  it('改间隔 → 发 {intervalHours:12}，回执后下拉停在 12', async () => {
    stubPocketai(baseImpls())
    mountWithProviders(<DataHealthPanel />)
    const sel = (await screen.findByTestId('dh-task-interval-backup_verify')) as HTMLSelectElement

    fireEvent.change(sel, { target: { value: '12' } })

    await waitFor(() => {
      const call = pocketaiCalls().find((c) => c.fn === 'setTaskSchedule')
      expect(call?.args).toEqual(['backup_verify', { intervalHours: 12 }])
    })
    await waitFor(() => expect(selectOf('dh-task-interval-backup_verify').value).toBe('12'))
    // 另一条没被顺手改掉
    expect(selectOf('dh-task-interval-kb_health_check').value).toBe('6')
  })
})

describe('③ 主进程拒了就如实说，屏上不许跟着变', () => {
  it('非法间隔被拒：下拉退回原值，并弹出原因', async () => {
    stubPocketai(
      baseImpls({
        setTaskSchedule: () => ({ ok: false, code: 'INVALID_INTERVAL', error: '间隔必须是 1–720 小时的整数' })
      })
    )
    mountWithProviders(<DataHealthPanel />)
    const sel = (await screen.findByTestId('dh-task-interval-kb_health_check')) as HTMLSelectElement

    fireEvent.change(sel, { target: { value: '12' } })

    await screen.findByText(L('dh.task.invalidInterval'))
    await waitFor(() => expect(selectOf('dh-task-interval-kb_health_check').value).toBe('6'))
  })
})

describe('④ 设置读失败：说原因，但不把「上次执行」一起抹掉', () => {
  it('listTaskSchedules 回 {ok:false} → 出失败行、不出控件，两行 Row 照旧', async () => {
    stubPocketai(baseImpls({ listTaskSchedules: () => ({ ok: false, error: '读不到任务配置' }) }))
    mountWithProviders(<DataHealthPanel />)

    const fail = await screen.findByTestId('dh-tasks-config-fail')
    expect(fail.textContent).toContain('读不到任务配置')
    expect(screen.queryByTestId('dh-task-controls-kb_health_check')).toBeNull()
    // 值位还在（这一格的「上次什么时候跑的」不依赖设置读没读到）：两条任务各一句「从未运行」
    expect(screen.queryAllByText(L('dh.never'))).toHaveLength(2)
  })

  it('反向对照：读成功就不出那行（失败行不是常驻装饰）', async () => {
    stubPocketai(baseImpls())
    mountWithProviders(<DataHealthPanel />)
    await screen.findByTestId('dh-task-controls-kb_health_check')
    expect(screen.queryByTestId('dh-tasks-config-fail')).toBeNull()
  })
})
