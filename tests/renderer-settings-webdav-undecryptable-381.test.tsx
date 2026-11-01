// §381 挂载半：WebDAV 配置那一屏的两张新脸
//
//  · `bk.pwdUndecryptable`——口令「有密文却解不开」：配置照旧显示（同步卡片在），但必须说一句"这份用不了、去重填"；
//    它不许在「没配过」「读不到」「一切正常」那三档里出现，也不许在用户重填并保存之后还赖着（陈旧谎报）。
//  · `bk.incProbeUnknown`——增量备份完成后，只有真有过"探测没跑成"才追加那半句。
//
// 夹具照抄本仓现成的挂载 harness（tests/ipc-badvalue-pair-262.test.tsx 的 mountBackup）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const SENTENCE = L('bk.pwdUndecryptable')
const bodyText = (): string => document.body.textContent ?? ''
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

const SCHED = { enabled: false, intervalHours: 24, retentionCount: 0, lastRunAt: null, lastResult: null }
const CFG_OK = { url: 'https://dav.example.com/backups', username: 'me', passwordCipher: '••••abcd', directory: '/b', passwordUndecryptable: false }
const CFG_BAD = { ...CFG_OK, passwordCipher: '••••9A==', passwordUndecryptable: true }

type Impl = (...a: any[]) => unknown
const mountBackup = (over: Record<string, Impl> = {}): void => {
  stubPocketai({
    loadWebDAVConfig: () => CFG_OK,
    getBackupSchedule: () => SCHED,
    listWebDAVBackups: () => [],
    saveWebDAVConfig: (c: unknown) => ({ ok: true, cfg: c }),
    uploadIncrementalBackup: () => ({
      ok: true,
      filename: 'pocketai-inc-x.json',
      attachmentsTotal: 3,
      blobsUploaded: 1,
      blobsSkipped: 2,
      blobsProbeUnknown: 0,
      bytesUploaded: 2048,
      encrypted: false
    }),
    ...over
  })
  mountWithProviders(<BackupPanel enc={null} />)
}

describe('①「这份口令解不开」那一句', () => {
  it('解不开 ⇒ 那句上屏，而"配过"那些块照常（它说的是用不了，不是没有）', async () => {
    mountBackup({ loadWebDAVConfig: () => CFG_BAD })
    await waitFor(() => expect(alerts()).toContain(SENTENCE))
    expect(bodyText()).toContain(L('bk.syncCard'))
  })

  it('反向对照：一切正常 ⇒ 屏上零 alert、那句一个字都不许出现', async () => {
    mountBackup()
    await waitFor(() => expect(bodyText()).toContain(L('bk.syncCard')))
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain(SENTENCE)
  })

  it('没配过（null）⇒ 没有那句（"没配过"与"配了但用不了"是两格）', async () => {
    mountBackup({ loadWebDAVConfig: () => null })
    await waitFor(() => expect(bodyText()).toContain(L('bk.webdavTitle')))
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain(SENTENCE)
  })

  it('配置文件读不到 ⇒ 只有既有那张"读不到"的脸，不叠这句（那发根本不知道口令是什么状态）', async () => {
    mountBackup({ loadWebDAVConfig: () => ({ ok: false, error: 'WEBDAV_CFG:配置文件读不到' }) })
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]).toContain(L('common.loadFailed').replace('{msg}', 'WEBDAV_CFG:配置文件读不到'))
    expect(alerts()).not.toContain(SENTENCE)
  })

  it('重填口令并保存 ⇒ 那句当场收回（它已经跟着这次写入换新钥了）', async () => {
    mountBackup({ loadWebDAVConfig: () => CFG_BAD })
    await waitFor(() => expect(alerts()).toContain(SENTENCE))
    const inputs = Array.from(document.querySelectorAll('input.input')) as HTMLInputElement[]
    fireEvent.change(inputs[2]!, { target: { value: 'a-brand-new-dav-pwd' } })
    fireEvent.click(screen.getByText(L('bk.saveCfg')))
    await waitFor(() => expect(bodyText()).toContain(L('bk.cfgSaved')))
    expect(alerts()).not.toContain(SENTENCE)
  })

  it('只改目录（口令栏留空＝沿用已存那份）⇒ 那句不许替它说话，仍然在屏上', async () => {
    mountBackup({ loadWebDAVConfig: () => CFG_BAD })
    await waitFor(() => expect(alerts()).toContain(SENTENCE))
    const dir = Array.from(document.querySelectorAll('input.input'))[3] as HTMLInputElement
    fireEvent.change(dir, { target: { value: '/b2' } })
    fireEvent.click(screen.getByText(L('bk.saveCfg')))
    await waitFor(() => expect(bodyText()).toContain(L('bk.cfgSaved')))
    expect(alerts()).toContain(SENTENCE)
  })
})

describe('②增量备份那句「有几个没能确认」', () => {
  const INC = (over: Record<string, unknown> = {}): unknown => ({
    ok: true,
    filename: 'pocketai-inc-x.json',
    attachmentsTotal: 3,
    blobsUploaded: 1,
    blobsSkipped: 2,
    blobsProbeUnknown: 0,
    bytesUploaded: 2048,
    encrypted: false,
    ...over
  })

  it('全都在 ⇒ 只有原来那句，追加那半句一个字都不出现', async () => {
    mountBackup({ uploadIncrementalBackup: () => INC() })
    await waitFor(() => expect(bodyText()).toContain(L('bk.syncCard')))
    fireEvent.click(screen.getByText(L('bk.incBtn')))
    await waitFor(() =>
      expect(bodyText()).toContain(
        L('bk.incDone')
          .replace('{total}', '3')
          .replace('{uploaded}', '1')
          .replace('{skipped}', '2')
          .replace('{kb}', (2048 / 1024).toFixed(1))
      )
    )
    expect(bodyText()).not.toContain(L('bk.incProbeUnknown').replace('{n}', '0'))
    expect(bodyText()).not.toContain('没能确认')
  })

  it('有两个没探明 ⇒ 那句跟着计数出现在同一行结论里', async () => {
    mountBackup({ uploadIncrementalBackup: () => INC({ blobsProbeUnknown: 2 }) })
    await waitFor(() => expect(bodyText()).toContain(L('bk.syncCard')))
    fireEvent.click(screen.getByText(L('bk.incBtn')))
    await waitFor(() => expect(bodyText()).toContain(L('bk.incProbeUnknown').replace('{n}', '2')))
  })
})
