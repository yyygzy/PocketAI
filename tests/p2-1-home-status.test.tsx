// @vitest-environment jsdom
// P2-1 第一刀：起始屏状态卡（本地备份 + 便携版更新提示）
//
// 要能真失败的四处：
//  ① 没备份 ⇒ 恢复入口根本不渲染（不是禁用、不是灰着）；
//  ② 有备份 ⇒ 最近一次时间、恢复入口、不自动覆盖的提示都在；
//  ③ 便携版查到新版本 ⇒ 版本号与下载链接上屏，且一次 downloadUpdate 都不发；
//  ④ 非便携版 ⇒ 卡片不出现、也不去查版本。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { HomeStatusPanel } from '../src/renderer/src/components/HomeStatusPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { LocalBackupEntry, UpdateEvent, UpdateInfo } from '../src/shared/types'

const NOT_PORTABLE: UpdateInfo = {
  currentVersion: '1.0.0',
  isPackaged: true,
  isPortable: false,
  autoUpdateEnabled: false,
  updatesExpired: false
}
const PORTABLE: UpdateInfo = { ...NOT_PORTABLE, isPortable: true }

function mkBackup(over: Partial<LocalBackupEntry> = {}): LocalBackupEntry {
  return {
    name: 'pocketai-backup-20260102-000000.zip',
    mtime: 1767312000000,
    size: 2048,
    encrypted: false,
    ...over
  }
}

const called = (fn: string): number => pocketaiCalls().filter((c) => c.fn === fn).length

describe('首页状态卡：本地备份', () => {
  it('没有本地备份 ⇒ 不摆恢复入口，照实说还没有备份', async () => {
    stubPocketai({ listLocalBackups: () => [], getUpdateInfo: () => NOT_PORTABLE })
    mountWithProviders(<HomeStatusPanel />)
    expect(await screen.findByTestId('home-backup-none')).toBeTruthy()
    expect(screen.queryByTestId('home-restore')).toBeNull()
    expect(screen.queryByTestId('home-restore-hint')).toBeNull()
    expect(called('restoreLocalBackup')).toBe(0)
  })

  it('有备份 ⇒ 最近一次时间 + 恢复入口 + 不自动覆盖的提示都在', async () => {
    const b = mkBackup()
    stubPocketai({ listLocalBackups: () => [b], getUpdateInfo: () => NOT_PORTABLE })
    mountWithProviders(<HomeStatusPanel />)
    const last = await screen.findByTestId('home-backup-last')
    expect(last.textContent).toBe(
      zh['home.backupLast'].replace('{time}', new Date(b.mtime).toLocaleString())
    )
    expect(screen.getByTestId('home-restore')).toBeTruthy()
    expect(screen.getByTestId('home-restore-hint').textContent).toBe(zh['home.restoreDetected'])
    // 只给入口：读清单不许顺手触发恢复
    expect(called('restoreLocalBackup')).toBe(0)
  })

  it('备份成功 ⇒ 结果上屏，并立刻刷新清单（不用等下次启动）', async () => {
    let reads = 0
    stubPocketai({
      listLocalBackups: () => (reads++ === 0 ? [] : [mkBackup()]),
      createLocalBackup: () => ({ ok: true, path: 'C:/backups/x.zip', size: 20480 }),
      getUpdateInfo: () => NOT_PORTABLE
    })
    mountWithProviders(<HomeStatusPanel />)
    await screen.findByTestId('home-backup-none')
    fireEvent.click(screen.getByText(zh['bk.localBtn']))
    const notice = await screen.findByTestId('home-backup-notice')
    expect(notice.textContent).toBe(zh['bk.localDone'].replace('{size}', '20.0'))
    expect(screen.getByTestId('home-backup-last')).toBeTruthy()
    expect(called('createLocalBackup')).toBe(1)
  })
})

describe('首页状态卡：便携版更新', () => {
  it('查到新版本 ⇒ 版本号与下载链接上屏，且一次下载都不发起', async () => {
    let push: ((e: UpdateEvent) => void) | null = null
    stubPocketai({
      listLocalBackups: () => [],
      getUpdateInfo: () => PORTABLE,
      checkUpdate: () => ({ ok: true }),
      onUpdateEvent: (cb: (e: UpdateEvent) => void) => {
        push = cb
        return () => {}
      }
    })
    mountWithProviders(<HomeStatusPanel />)
    expect(await screen.findByTestId('home-portable-update')).toBeTruthy()
    await waitFor(() => expect(called('checkUpdate')).toBe(1))

    const url = 'https://github.com/yyygzy/PocketAI/releases/tag/v9.9.9'
    await act(async () => {
      push?.({ status: 'available', newVersion: '9.9.9', downloadUrl: url })
    })
    expect(screen.getByTestId('home-update-available').textContent).toBe(
      zh['upd.available'].replace('{v}', '9.9.9')
    )
    expect((screen.getByTestId('home-update-url') as HTMLInputElement).value).toBe(url)
    expect(screen.getByText(zh['home.downloadPage'])).toBeTruthy()
    // 便携版只提示 + 给入口：应用内下载/替换一次都不许发生
    expect(called('downloadUpdate')).toBe(0)
    expect(called('quitAndInstall')).toBe(0)
  })

  it('非便携版 ⇒ 卡片不出现，也不去查版本（不重复自动更新那套 UI）', async () => {
    stubPocketai({ listLocalBackups: () => [], getUpdateInfo: () => NOT_PORTABLE })
    mountWithProviders(<HomeStatusPanel />)
    await screen.findByTestId('home-backup-none')
    expect(screen.queryByTestId('home-portable-update')).toBeNull()
    expect(called('checkUpdate')).toBe(0)
    expect(called('onUpdateEvent')).toBe(0)
  })
})
