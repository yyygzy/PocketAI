// @vitest-environment jsdom
// V4-Iter-312（渲染层那半边）：点「重启安装」失败必须以**返回值**的形式说话。
//
// §312 给补丁消费加了身份与哈希对账：对账不过 ⇒ 主进程返回 `{ok:false,error:'补丁已过期或与要安装的版本不符…'}`
// ——safeHandle 的失败是 resolve 出来的信封，不抛。修前 `handleRestart` 只 `await` 不看那份返回值，
// 于是按了那颗键屏上什么都没变：这是 §196／§204 那句「失败被咽」在更新链上的又一处
// （那条通道本来就带失败分支，只是这一批才第一次真的会走到它）。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { UpdatePanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { UpdateEvent, UpdateInfo } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const STALE = '补丁已过期或与要安装的版本不符，请重新检查更新'

const panelProps = (): { info: UpdateInfo; err: null; status: UpdateEvent; onReloadInfo: () => void } => ({
  info: { isPackaged: true, currentVersion: '1.2.8', autoUpdateEnabled: false } as unknown as UpdateInfo,
  err: null,
  status: { status: 'downloaded', newVersion: '1.3.0' } as unknown as UpdateEvent,
  // §354：那颗「重试」的新 prop；本批用例点的是「重启并安装」，这里给个不被调用的入口即可
  onReloadInfo: () => {}
})

/** 点「重启并安装」→ 确认框点「确认」（弹窗的出路在那颗键自己身上） */
const clickRestart = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: L('upd.installBtn') }))
  fireEvent.click(await screen.findByRole('button', { name: L('common.confirm') }))
}

describe('§312 重启安装那发：失败是返回值，就得把原因说出来', () => {
  it('对账不过 ⇒ 那句「补丁已过期…」上屏（不是静默不动）', async () => {
    stubPocketai({ quitAndInstall: () => ({ ok: false, error: STALE }) })
    mountWithProviders(<UpdatePanel {...panelProps()} />)
    await clickRestart()
    await waitFor(() => expect(screen.getByText(STALE)).toBeTruthy())
    expect(pocketaiCalls().filter((c) => c.fn === 'quitAndInstall')).toHaveLength(1)
  })

  it('兜底话术：信封没带 error ⇒ 说「安装失败」，不许留空', async () => {
    stubPocketai({ quitAndInstall: () => ({ ok: false }) })
    mountWithProviders(<UpdatePanel {...panelProps()} />)
    await clickRestart()
    await waitFor(() => expect(screen.getByText(L('upd.installFail'))).toBeTruthy())
  })

  it('正向对照：安装真的开始了 ⇒ 屏上不许冒任何失败句（别把成功演成错）', async () => {
    stubPocketai({ quitAndInstall: () => ({ ok: true }) })
    mountWithProviders(<UpdatePanel {...panelProps()} />)
    await clickRestart()
    await waitFor(() => expect(pocketaiCalls().filter((c) => c.fn === 'quitAndInstall')).toHaveLength(1))
    expect(screen.queryByText(STALE)).toBeNull()
    expect(screen.queryByText(L('upd.installFail'))).toBeNull()
  })
})
