// V4-Iter-377：管家屏两张脸的真挂载（候选 #7 的界面半边＋#3 的 unknown 档）。
//
// 挂载夹具照抄 `renderer-steward-read-255.test.tsx` 的形状（StewardModule 是导出的，进那一屏只发四发读），
// 桩全部按 shared/types 的真实形状写：`vacuumFailed` 是必填字段，缺了编译期就红——
// 否则拿一个「没有这个字段」的桩去演「这个字段决定画哪句」，断言就落在假的形状上。
//
// 判据选的是**整块面板的文本逐字**，不是"屏上有没有某个词"：
// 改前的病恰好是失败那一发也画出一句结构相同、只是数字为 0 的成功句，只查关键词会放过它。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { zh } from '../src/renderer/src/i18n/zh'
import { formatBytes } from '../src/renderer/src/utils/format'
import type { CleanupResult, VacuumOutcome, DiskInfo, HardwareInfo } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const T = (key: string, params: Record<string, string | number>): string => {
  let out = L(key)
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v))
  return out
}
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())

const CLEAN_OK: CleanupResult = {
  removedOrphanMessages: 5,
  removedOrphanChunks: 3,
  vacuumedBytes: 300,
  vacuumFailed: false
}
const CLEAN_VACUUM_FAILED: CleanupResult = { ...CLEAN_OK, vacuumedBytes: 0, vacuumFailed: true }
const VACUUM_OK: VacuumOutcome = { vacuumedBytes: 300, vacuumFailed: false }
const VACUUM_FAILED: VacuumOutcome = { vacuumedBytes: 0, vacuumFailed: true }

const disk = (over: Partial<DiskInfo> = {}): DiskInfo => ({
  type: 'ssd',
  removable: false,
  drive: 'C:',
  volumeLabel: null,
  filesystem: 'NTFS',
  totalSpace: 512 * 1024 ** 3,
  freeSpace: 1024 ** 3,
  mediumType: 'SSD',
  busType: 'NVMe',
  ...over
})

const hardware = (over: Partial<DiskInfo> = {}): HardwareInfo => ({
  os: { platform: 'win32', release: '10.0', arch: 'x64', hostname: 'BOX' },
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: disk(over)
} as unknown as HardwareInfo)

const healthSample = {
  totalConversations: 3,
  totalMessages: 12,
  kbCount: 1,
  totalAttachmentsBytes: 0,
  orphanMessages: 0,
  orphanChunks: 0
}

const baseStubs = (over: Record<string, () => unknown> = {}): Record<string, () => unknown> => ({
  getHardwareInfo: () => ({ ok: true, data: hardware() }),
  checkIntegrity: () => ({ ok: true, data: { ok: true, details: 'ok' } }),
  getHealthReport: () => ({ ok: true, data: healthSample }),
  recommendModels: () => ({ ok: true, data: null }),
  // 清理/压缩成功后那一发"顺带刷新诊断"是设计内静默（§255 记的账），但通道仍会被真发出去
  // ⇒ 助手必须预置它，否则桩层按「未预置通道」抛错（全量里那两条 Error 就是这么来的）
  runDiagnose: () => ({ ok: true, data: { items: [] } }),
  getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
  onOllamaPullEvent: () => () => {},
  ...over
})

/** 两块结果面板共用同一句容器式样；两句话各以「已删除孤儿消息」与「VACUUM 」开头，按前缀认是哪一格 */
const CLEAN_PREFIX = L('steward.cleanupResult').slice(0, 7)
const VACUUM_PREFIX = L('steward.vacuumResult').slice(0, 7)
/** 同时取文本与类名：失败那一面必须是警示色（把失败画成绿色＝本枚要修的原病，只比文本看不见这一半） */
const panelBoxes = (prefix: string): Array<{ text: string; cls: string }> =>
  [...document.querySelectorAll('div')]
    .filter((d) => typeof d.className === 'string' && d.className.includes('mt-2 px-2 py-1.5 rounded'))
    .map((d) => ({ text: (d.textContent ?? '').trim(), cls: d.className as string }))
    .filter((b) => b.text.startsWith(prefix))
const cleanBoxes = (): Array<{ text: string; cls: string }> => panelBoxes(CLEAN_PREFIX)
const vacuumBoxes = (): Array<{ text: string; cls: string }> => panelBoxes(VACUUM_PREFIX)
const texts = (bs: Array<{ text: string }>): string[] => bs.map((b) => b.text)

describe('① 清理完了、但 VACUUM 没跑成：不许还是那句绿色「回收 0」', () => {
  it('runCleanup 回 vacuumFailed:true ⇒ 那一格只有一句＝警示那句（带 m/c、不提回收字节）', async () => {
    stubPocketai(baseStubs({ runCleanup: () => CLEAN_VACUUM_FAILED }))
    mountWithProviders(<StewardModule />)
    fireEvent.click(screen.getByText(L('steward.startCleanup')))
    const want = T('steward.cleanupVacuumFailed', { m: 5, c: 3 })
    // 逐值比整格：改前的病恰好是"同一格里那句成功话、只是 b=0"，只查关键词会放过它
    await waitFor(() => expect(texts(cleanBoxes()), '警示那句没上屏').toEqual([want]))
    expect(cleanBoxes()[0]?.cls, '失败那一面画成了成功色').toContain('--color-warning')
    expect(toasts().join(' ')).not.toContain('VACUUM')
  })

  it('正向对照：runCleanup 回 vacuumFailed:false ⇒ 那一格只有成功句（回收字节照说、绿色）', async () => {
    stubPocketai(baseStubs({ runCleanup: () => CLEAN_OK }))
    mountWithProviders(<StewardModule />)
    fireEvent.click(screen.getByText(L('steward.startCleanup')))
    const want = T('steward.cleanupResult', { m: 5, c: 3, b: formatBytes(300) })
    await waitFor(() => expect(texts(cleanBoxes()), '成功那句没上屏').toEqual([want]))
    expect(cleanBoxes()[0]?.cls, '成功那一面反倒换了脸色').toContain('--color-success')
  })
})

describe('② 手动 VACUUM：没跑成 ≠ 跑过了没东西可回收', () => {
  it('runVacuum 回 vacuumFailed:true ⇒ 那一格只有「VACUUM 没跑成，空间未压缩」这一句', async () => {
    stubPocketai(baseStubs({ runVacuum: () => VACUUM_FAILED }))
    mountWithProviders(<StewardModule />)
    fireEvent.click(screen.getByText(L('steward.vacuum')))
    await waitFor(() =>
      expect(texts(vacuumBoxes()), '警示那句没上屏').toEqual([L('steward.vacuumFailed')])
    )
    expect(vacuumBoxes()[0]?.cls, '失败那一面画成了成功色').toContain('--color-warning')
  })

  it('正向对照：runVacuum 回 vacuumFailed:false ⇒ 那一格只有「VACUUM 回收 {b}」（绿色照旧）', async () => {
    stubPocketai(baseStubs({ runVacuum: () => VACUUM_OK }))
    mountWithProviders(<StewardModule />)
    fireEvent.click(screen.getByText(L('steward.vacuum')))
    await waitFor(() =>
      expect(texts(vacuumBoxes()), '成功那句没上屏').toEqual([T('steward.vacuumResult', { b: formatBytes(300) })])
    )
    expect(vacuumBoxes()[0]?.cls, '成功那一面反倒换了脸色').toContain('--color-success')
  })

  it('§378：跑成了但一个字节也没回收 ⇒ 绿色那句说「回收 0 B」，不许再借 formatBytes(0) 的 \'-\' 说成"读不到"', async () => {
    stubPocketai(baseStubs({ runVacuum: () => ({ vacuumedBytes: 0, vacuumFailed: false }) }))
    mountWithProviders(<StewardModule />)
    fireEvent.click(screen.getByText(L('steward.vacuum')))
    await waitFor(() =>
      expect(texts(vacuumBoxes()), '「回收 0 B」那句没上屏').toEqual([T('steward.vacuumResult', { b: formatBytes(0) })])
    )
    expect(vacuumBoxes().map((b) => b.text).join(' ')).not.toContain(' -')
  })

  it('信封失败面照旧：通道回 {ok:false} ⇒ 只有 toast，那一格整格不出现（§216 那颗判据还在）', async () => {
    stubPocketai(baseStubs({ runVacuum: () => ({ ok: false, error: 'DB_LOCKED:数据库被占用' }) }))
    mountWithProviders(<StewardModule />)
    fireEvent.click(screen.getByText(L('steward.vacuum')))
    await waitFor(() => expect(toasts().join(' ')).toContain('DB_LOCKED:数据库被占用'))
    expect(vacuumBoxes()).toEqual([])
    expect(cleanBoxes()).toEqual([])
  })
})

describe('③ 磁盘那一行：介质没探到就写「未知」，不许写 SSD', () => {
  it("hardware.disk.type='unknown' 且没有 mediumType ⇒ 行值是「未知」，整屏不出现 SSD 字样", async () => {
    stubPocketai(
      baseStubs({
        getHardwareInfo: () => ({
          ok: true,
          data: hardware({ type: 'unknown', mediumType: null, busType: null })
        })
      })
    )
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText(L('steward.dt.unknown')), '「未知」没上屏').not.toBeNull())
    expect(document.body.textContent).not.toContain('SSD')
    expect(document.body.textContent).not.toContain(L('steward.dt.ssd'))
  })

  it('正向对照：实测到 SSD ⇒ 照常写「SSD」那一档（闸门不是把这一档一起删了）', async () => {
    stubPocketai(baseStubs({ getHardwareInfo: () => ({ ok: true, data: hardware() }) }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText(L('steward.dt.ssd')), 'SSD 档没上屏').not.toBeNull())
    expect(screen.queryByText(L('steward.dt.unknown'))).toBeNull()
  })
})
