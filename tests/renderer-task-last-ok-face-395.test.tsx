// V4-Iter-395（缺陷 hunt §391 候选 ⑤）：数据健康面板把维护任务的 `last_run_at` 单摆成一行时间。
// 那个键在成功与失败两种收尾里都写（`runTask` 的 `finally`），于是「备份校验连着 24 小时每次都在
// WebDAV 那步撞错」在屏上读起来是一条越来越新的正常时间——没有任何一格说它失败过。
//
// 本文件＝真挂载看两条任务各自的三张脸（值逐字取 `Row` 自己的 title，warn 取 className），
// 并按槽位钉住（第 32 条：同一句话挂在两个槽位时"屏上出现过"不是判据）：
// 两条行各自读自己那颗 flag，一条红不许把另一条也带红。
//
// 契约三档在 `data-health-task-last-ok-395.test.ts`，生产侧写入在 `task-scheduler-last-ok-395.test.ts`，
// 结构纪律在 `task-last-ok-gate-395.test.ts`。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const fmt = (ms: number): string => new Date(ms).toLocaleString()

const AT = 1_730_000_000_000

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

const tasksOf = (over: Partial<DataHealthReport['tasks']>): DataHealthReport['tasks'] => ({
  kbHealthCheckLastRunAt: null,
  kbHealthCheckLastOk: null,
  backupVerifyLastRunAt: null,
  backupVerifyLastOk: null,
  ...over
})

const reportOf = (tasks: DataHealthReport['tasks']): DataHealthReport => ({
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
  tasks
})

/** 挂那一屏并把两行任务各读出来：值取 `Row` 自己的 title（逐值），warn 取 className */
async function mountTasks(tasks: DataHealthReport['tasks']): Promise<Record<'kb' | 'verify', { value: string; warn: boolean }>> {
  stubPocketai({
    getDataHealth: () => reportOf(tasks),
    openDataFolder: () => ({ ok: true }),
    clearBrowserCache: () => ({ ok: true, beforeBytes: 0, afterBytes: 0 }),
    cleanKbOrphans: () => ({ removedVectors: 0, removedChunks: 0 }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    deduplicateKbDocs: () => ({ removed: 0 })
  })
  mountWithProviders(<DataHealthPanel />)
  const labels = { kb: L('dh.task.kbHealthCheck'), verify: L('dh.task.backupVerify') }
  // 到货见证＝两行的值位各自挂上了 title（初值是"这一格还没渲染"，不是恒真门——§364 那条纪律）
  await waitFor(() => {
    for (const key of ['kb', 'verify'] as const) {
      const el = rowValueSpan(labels[key])
      if (!el || el.getAttribute('title') === null) throw new Error(`${labels[key]} 那一行还没挂上值`)
    }
  })
  const out = {} as Record<'kb' | 'verify', { value: string; warn: boolean }>
  for (const key of ['kb', 'verify'] as const) {
    const el = rowValueSpan(labels[key])!
    out[key] = { value: el.getAttribute('title') ?? '', warn: (el.className ?? '').includes('--color-warning') }
  }
  return out
}

/** 从行标签往上走到那一行的 `Row` 容器，再取它自己的值位（带 title 的那个 span） */
function rowValueSpan(label: string): HTMLElement | null {
  const labelEl = screen.queryByText(label)
  if (!labelEl) return null
  // 标签自己就是那个值位的兄弟：先上一格到 Row 的容器，再在里面找带 title 的 span
  const row = labelEl.parentElement
  const span = row?.querySelector('span[title]')
  return span instanceof HTMLElement ? span : null
}

describe('① 成功／失败／不知道 三张脸（kb 那一行）', () => {
  it('lastOk = true ⇒ 时间后面接「上次运行未报错」，且不 warn', async () => {
    const r = await mountTasks(tasksOf({ kbHealthCheckLastRunAt: AT, kbHealthCheckLastOk: true }))
    expect(r.kb.value).toBe(`${fmt(AT)} · ${L('dh.task.lastOk')}`)
    expect(r.kb.warn).toBe(false)
  })

  it('lastOk = false ⇒ 时间后面接「上次运行失败」，且 warn 上色（改前这一档与上一档画同一个数）', async () => {
    const r = await mountTasks(tasksOf({ kbHealthCheckLastRunAt: AT, kbHealthCheckLastOk: false }))
    expect(r.kb.value).toBe(`${fmt(AT)} · ${L('dh.task.lastFailed')}`)
    expect(r.kb.warn).toBe(true)
  })

  it('lastOk = null（升级前跑过的旧数据）⇒ 只报时间：既不说"未报错"也不说"失败"', async () => {
    const r = await mountTasks(tasksOf({ kbHealthCheckLastRunAt: AT, kbHealthCheckLastOk: null }))
    expect(r.kb.value).toBe(fmt(AT))
    expect(r.kb.warn).toBe(false)
  })

  it('从未运行 ⇒ 那句「从未运行」，不带任何成败后缀（null 时间不许配上 true 的话）', async () => {
    const r = await mountTasks(tasksOf({ kbHealthCheckLastRunAt: null, kbHealthCheckLastOk: true }))
    expect(r.kb.value).toBe(L('dh.never'))
    expect(r.kb.value).not.toContain(L('dh.task.lastOk'))
  })
})

describe('② 备份校验那一行同一条链，且两条互不顶替', () => {
  it('lastOk = false ⇒ 那一行说「上次运行失败」并 warn', async () => {
    const r = await mountTasks(tasksOf({ backupVerifyLastRunAt: AT, backupVerifyLastOk: false }))
    expect(r.verify.value).toBe(`${fmt(AT)} · ${L('dh.task.lastFailed')}`)
    expect(r.verify.warn).toBe(true)
  })

  it('按槽位钉住：只有 kb 红时，备份校验那一行不跟着上色（两条各读自己那颗 flag）', async () => {
    const r = await mountTasks(
      tasksOf({ kbHealthCheckLastRunAt: AT, kbHealthCheckLastOk: false, backupVerifyLastRunAt: AT, backupVerifyLastOk: true })
    )
    expect(r.kb.warn).toBe(true)
    expect(r.kb.value).toContain(L('dh.task.lastFailed'))
    expect(r.verify.warn).toBe(false)
    expect(r.verify.value).toContain(L('dh.task.lastOk'))
    expect(r.verify.value).not.toContain(L('dh.task.lastFailed'))
  })

  it('反向对照：两条同时 false ⇒ 两行各自红，且都带那一句（谁也没被另一条顶掉）', async () => {
    const r = await mountTasks(
      tasksOf({ kbHealthCheckLastRunAt: AT, kbHealthCheckLastOk: false, backupVerifyLastRunAt: AT, backupVerifyLastOk: false })
    )
    expect([r.kb.warn, r.verify.warn]).toEqual([true, true])
    expect(r.kb.value).toBe(r.verify.value)
  })

  it('那一句的措辞说"未报错"而不是"成功"：跳过的一跑（没配 WebDAV）也算跑完没抛，不许替它编成校验通过', async () => {
    expect(L('dh.task.lastOk')).toContain('未报错')
    expect(L('dh.task.lastOk')).not.toContain('成功')
  })
})
