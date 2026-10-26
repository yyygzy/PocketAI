// V4-Iter-327 挂载用例：云端那份清单的时间读不出来时，这一屏三处都不许猜。
//
// 为什么还要一份挂载用例：主进程那侧（webdav-client／selectPrunableBackups）已经各自钉住了
// "NaN 不进删除名单"，但屏上那三处（状态格的时间、「哪边更新」那句、两颗指向"最新那一份"的键）
// 是**同一份数据的三次自己重算**——改前各算各的，一条 NaN 就把它们一起算坏（探针实测）：
// 「云端最新」显示「从未」、「哪边更新」演成「已同步」、那颗键指向最旧那一份。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { fmtCloudCellSize, fmtCloudCellTime, latestCloudBackup } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { WebDAVBackupFile } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
/**
 * 那一格到底说了什么——label 与值是兄弟 div，所以按兄弟取。
 * （变异 Y8 就是靠这个抓出来的：只判"屏上某处出现过这句"会把状态格那格的账糊过去，
 *  因为"哪边更新"那行也挂着同一句。）
 */
const slotAfter = (label: string): string => {
  const el = screen.getByText(label).nextElementSibling
  return el ? el.textContent ?? '' : ''
}

const CFG = { url: 'https://dav.example.com/backups', username: 'me', passwordCipher: 'x', directory: '/b' }
const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null, lastResult: null }
const mk = (name: string, mtime: number, size = 2048): WebDAVBackupFile => ({
  name,
  size,
  mtime,
  encrypted: false,
  kind: 'full'
})
const UNKNOWN = mk('pocketai-backup-.zip', NaN, NaN)
const KNOWN = mk('pocketai-backup-20261020T032000Z.zip', Date.UTC(2026, 9, 20, 3, 20))

const mountBackup = (over: Record<string, (...a: any[]) => unknown> = {}): void => {
  stubPocketai({
    loadWebDAVConfig: () => CFG,
    getBackupSchedule: () => SCHED,
    listWebDAVBackups: () => [UNKNOWN],
    mergeScanWebDAVBackup: () => ({ ok: true, tables: [], attachmentsToAdd: 0 }),
    ...over
  })
  mountWithProviders(<BackupPanel enc={null} />)
}

describe('§327 云端时间读不出来的那一屏', () => {
  it('一份都判不出来 ⇒ 状态格与那行都说"读不出来"（不许「未拉取」也不许「已同步」），两颗"最新那一份"的键不出现', async () => {
    mountBackup()
    await waitFor(() => expect(bodyText()).toContain(UNKNOWN.name))
    expect(slotAfter(L('bk.cloudLatest')), '「云端最新」那一格自己要说实话').toBe(L('bk.cloudTimeUnknown'))
    expect(screen.getAllByText(L('bk.cloudTimeUnknown')), '两处（状态格＋哪边更新那行）各一句，同一份数据不重复造键').toHaveLength(2)
    expect(bodyText(), '「未拉取」＝说用户没取过列表，明明取到了').not.toContain(L('bk.cloudNotFetched'))
    expect(bodyText(), '时间不可判时不许宣称两边一致').not.toContain(L('bk.inSyncHint'))
    expect(screen.queryByText(L('bk.restoreFromCloud'))).toBeNull()
    expect(screen.queryByText(L('bk.mergeFromCloud'))).toBeNull()
    // 列表行里那两格空着，而不是 0 KB／Invalid Date
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(bodyText()).not.toContain('NaN')
    expect(bodyText()).not.toContain('Invalid Date')
  })

  it('混着时取可判那一份：两颗键都指向它，「云端最新」也是它', async () => {
    const scan = vi.fn((_name: string) => ({ ok: true, tables: [], attachmentsToAdd: 0 }))
    mountBackup({ listWebDAVBackups: () => [UNKNOWN, KNOWN], mergeScanWebDAVBackup: scan })
    await waitFor(() => expect(bodyText()).toContain(KNOWN.name))
    expect(slotAfter(L('bk.cloudLatest')), '可判的那一份就是这一格的答案').toBe(new Date(KNOWN.mtime).toLocaleString())
    fireEvent.click(screen.getByText(L('bk.mergeFromCloud')))
    await waitFor(() => expect(scan).toHaveBeenCalled())
    expect(scan.mock.calls[0]![0], '合并扫描必须拿可判的那份，不是列表第一行').toBe(KNOWN.name)
    expect(bodyText()).not.toContain(L('bk.cloudTimeUnknown'))
  })

  it('反向对照：全部可判 ⇒ 时间照常显示、两颗键都在', async () => {
    mountBackup({ listWebDAVBackups: () => [KNOWN] })
    await waitFor(() => expect(bodyText()).toContain(new Date(KNOWN.mtime).toLocaleString()))
    expect(slotAfter(L('bk.cloudLatest'))).toBe(new Date(KNOWN.mtime).toLocaleString())
    expect(bodyText()).toContain(L('bk.restoreFromCloud'))
    expect(bodyText()).not.toContain(L('bk.cloudTimeUnknown'))
    expect(screen.queryAllByText('—')).toHaveLength(0)
  })
})

describe('§327 那两个纯函数的形状', () => {
  it('latestCloudBackup：空表与全不可判都回 null（不返回"随便一份"）', () => {
    expect(latestCloudBackup([])).toBeNull()
    expect(latestCloudBackup([UNKNOWN])).toBeNull()
    expect(latestCloudBackup([UNKNOWN, KNOWN])?.name).toBe(KNOWN.name)
    expect(latestCloudBackup([mk('a.zip', 1), mk('b.zip', 2), UNKNOWN])?.name).toBe('b.zip')
  })

  it('格子格式化：NaN 空着，正常值照旧', () => {
    expect(fmtCloudCellSize(NaN)).toBe('—')
    expect(fmtCloudCellSize(2048)).toBe('2.0 KB')
    expect(fmtCloudCellTime(NaN)).toBe('—')
    expect(fmtCloudCellTime(Date.UTC(2026, 9, 20))).toBe(new Date(Date.UTC(2026, 9, 20)).toLocaleString())
  })
})
