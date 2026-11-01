// V4-Iter-382（缺陷 hunt §381-⑥）：数据健康「定时备份」那一格其实有三种到货——
// 没配过／配了但口令解不开／配了且能用。改前只有两种：`configured = !!loadWebDAVConfig()`
// 在"有密文却解不开"时读到非空 ⇒ 那一格说「已开启，每 N 小时」或「已配置，定时未开启」，
// 而 warn 只由 `!configured || !enabled` 决定＝这一档连警示色都没有；下一次备份必在鉴权那步失败。
//
// 本文件＝真挂载看三张脸（逐值比 `Row` 的 title、比 className），并按槽位钉住"同一时刻只一句"
// （第 32 条：同一句话挂在两个槽位时"屏上出现过"不是判据）。
// 决策与契约那一半在 `tests/data-health-backup-face-382.test.ts`；结构纪律在
// `tests/webdav-configured-face-gate-382.test.ts`。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
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

const zeroSizes: DataHealthReport['sizes'] = {
  userDataBytes: 1024,
  dbBytes: 1024,
  attachmentsBytes: 0,
  extensionsBytes: 0,
  logsBytes: 0,
  otherBytes: 0,
  browserCacheBytes: 0,
  browserCacheFiles: 0
}

const backupOf = (over: Partial<DataHealthReport['backup']>): DataHealthReport['backup'] => ({
  configured: false,
  passwordUndecryptable: false,
  enabled: false,
  intervalHours: 6,
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  ...over
})

const reportOf = (backup: DataHealthReport['backup']): DataHealthReport => ({
  sizes: zeroSizes,
  traces: { rows: 0, maxRowsInOneConversation: 0 },
  kb: {
    total: 0,
    byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 },
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup,
  tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
  boot: { stages: [{ id: 'window', ms: 900 }], totalMs: 900 },
  recentPerf: [],
  perfHistory: []
})

/** 挂那一屏并把「定时备份」那一格读出来：值取 `Row` 自己的 `title`（逐值），warn 取 className */
async function mountBackup(backup: DataHealthReport['backup']): Promise<{ value: string; warn: boolean }> {
  stubPocketai({
    getDataHealth: () => reportOf(backup),
    openDataFolder: () => ({ ok: true }),
    clearBrowserCache: () => ({ ok: true, beforeBytes: 0, afterBytes: 0 }),
    cleanKbOrphans: () => ({ removedVectors: 0, removedChunks: 0 }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    deduplicateKbDocs: () => ({ removed: 0 })
  })
  mountWithProviders(<DataHealthPanel />)
  // 门的到货见证＝那一格的值真的挂上了 title（初值是没有这一格，不是恒真门）
  await screen.findByText(L('dh.backupState'))
  let el: HTMLElement | null = screen.getByText(L('dh.backupState'))
  while (el && (el.textContent ?? '').trim() === L('dh.backupState')) el = el.parentElement
  expect(el, `「${L('dh.backupState')}」那一格找不到`).not.toBeNull()
  const span = el!.querySelector('span[title]')
  expect(span, '那一格没有带 title 的值位（Row 的形状变了，读法要跟着改）').not.toBeNull()
  return { value: span!.getAttribute('title') ?? '', warn: (span!.className ?? '').includes('--color-warning') }
}

/** 三种到货各自该说的那一句 */
const SENTENCES = [L('dh.backupNotConfigured'), L('dh.backupPwdBroken'), L('dh.backupOff')]

describe('① 三种到货三张脸（逐值比那一句）', () => {
  it('没配过 ⇒ 仍是既有那句「未配置 WebDAV」，不是新那句', async () => {
    const r = await mountBackup(backupOf({ configured: false, passwordUndecryptable: false }))
    expect(r.value).toBe(L('dh.backupNotConfigured'))
    expect(r.warn).toBe(true)
  })

  it('配了但口令解不开 ⇒ 第三张脸（改前这一档说的是「已配置，定时未开启」或「已开启，每 N 小时」）', async () => {
    const r = await mountBackup(backupOf({ configured: true, passwordUndecryptable: true, enabled: false }))
    expect(r.value).toBe(L('dh.backupPwdBroken'))
    expect(r.warn).toBe(true)
  })

  it('正向对照：口令解得开＋定时开着 ⇒ 那句照常说「已开启，每 6 小时」，且不 warn', async () => {
    const r = await mountBackup(backupOf({ configured: true, passwordUndecryptable: false, enabled: true }))
    expect(r.value).toBe(T('dh.backupOn', { hours: 6 }))
    expect(r.warn).toBe(false)
  })

  it('正向对照：口令解得开＋定时没开 ⇒ 「已配置，定时未开启」（新那颗为 false 时不许改这一档的话）', async () => {
    const r = await mountBackup(backupOf({ configured: true, passwordUndecryptable: false, enabled: false }))
    expect(r.value).toBe(L('dh.backupOff'))
    expect(r.warn).toBe(true)
  })

  it('解不开优先于"定时没开"：enabled 为 false 时说的仍是那句（不把鉴权坏说成没开启）', async () => {
    const r = await mountBackup(backupOf({ configured: true, passwordUndecryptable: true, enabled: false }))
    expect(r.value).not.toBe(L('dh.backupOff'))
    expect(r.value).toContain('解不开')
  })
})

describe('② 按槽位钉住"同一时刻只一句"＋两件事同屏各说各的', () => {
  it('解不开那一档：整屏只出现那一句，另两句一个都不在', async () => {
    // enabled 为 true 时也要 warn＝那一格的警示色不能只靠"定时没开"喂绿
    const r = await mountBackup(backupOf({ configured: true, passwordUndecryptable: true, enabled: true }))
    const body = document.body.textContent ?? ''
    const hit = SENTENCES.filter((s) => body.includes(s))
    expect(hit, `期望恰好一句，实际看到：${hit.join(' § ')}`).toEqual([L('dh.backupPwdBroken')])
    expect(body).not.toContain(T('dh.backupOn', { hours: 6 }))
    expect(r.warn).toBe(true)
  })

  it('lastError 那一行照在（新那句不替掉上次真实失败，也不被它替掉）', async () => {
    await mountBackup(
      backupOf({
        configured: true,
        passwordUndecryptable: true,
        enabled: true,
        lastRunAt: 123,
        lastOkAt: null,
        lastError: '401 Unauthorized'
      })
    )
    const row = (label: string): string => {
      let el: HTMLElement | null = screen.getByText(label)
      while (el && (el.textContent ?? '').trim() === label) el = el.parentElement
      return el?.querySelector('span[title]')?.getAttribute('title') ?? ''
    }
    expect(row(L('dh.backupState'))).toBe(L('dh.backupPwdBroken'))
    expect(row(L('dh.lastError'))).toBe('401 Unauthorized')
  })
})
