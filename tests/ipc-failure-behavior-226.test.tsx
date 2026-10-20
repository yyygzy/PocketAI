// @vitest-environment jsdom
// V4-Iter-226：第二形态的「读不到」——**面板本体照样显示，但那几项是默认值**（§222／§225 那一句替代整块，这一句不替代）。
//
// 撞出来的形状：`NetworkPanel` 与 `AppearancePanel` 的门是 `loaded`，而两条失败面**都会把门解除**
// （`setLoaded(true)`，注释当时写的是"否则面板永远转圈"）。门解除后屏上摆的是各 state 的初始字面量：
// 空代理框、透明度 100%、字号「中」、折叠阈值 20、CSS 空、两颗窗口行为开关未勾、回复通知勾着。
// 这些值逐条对过主进程的定义确实就是默认值（`app-config.repo.ts:367/:292/:300`、`ui-preferences.ts:42/48/70`、
// `reply-notify.ts:19`），所以能说的是"这是默认值"而不是"没东西"——**但用户看到的是一屏看起来正常的设置**。
// 最贵的一条是回复通知：读失败时它保持"开"，而"开"恰好是最打扰的那一侧。
//
// 用例分两层：① 每发读失败 ⇒ 那一句逐字出现，且**本体仍在**（这一句不替代内容）；② 三发彼此独立 ⇒
// 只让失败的那几项被点名，成功读到的不许被顺手说成默认值（这条是这批真正的判据，也是 `{what}` 存在的原因）。
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { NetworkPanel, AppearancePanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
/** 那句提示的完整形状：{what} 与 {msg} 都要插进去（漏一个就直接把 `{what}` 显示给用户） */
const DEFAULTS = (what: string, msg: string): string =>
  L('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const box = (name: string): HTMLInputElement => screen.getByLabelText(name) as HTMLInputElement

const UI_ITEMS = [L('ui.opacity'), L('ui.fontSize'), L('ui.codeCollapse'), L('ui.customCss')].join(' / ')
const BEHAVIOR_ITEMS = [L('ui.launchAtLogin'), L('ui.closeToTray')].join(' / ')

const prefsOk = { opacity: 0.8, customCss: 'body{}', chatFontSize: 'large', codeCollapseLines: 5 }
const behaviorOk = { launchAtLogin: true, closeToTray: true, launchAtLoginApplied: true }

/** 三发读按成败组合打桩：`fails` 里列的通道回 `{ok:false}` */
const stubPrefs = (fails: string[] = []): Record<string, () => unknown> => {
  const fail = () => ({ ok: false, error: '配置库被占用' })
  return {
    getUiPrefs: () => (fails.includes('getUiPrefs') ? fail() : { ok: true, data: prefsOk }),
    getWindowBehavior: () => (fails.includes('getWindowBehavior') ? fail() : behaviorOk),
    getReplyNotifyEnabled: () => (fails.includes('getReplyNotifyEnabled') ? fail() : false)
  }
}

describe('① 网络面板：读不到代理时，空输入框不是"你没配"', () => {
  it('resolve 的 {ok:false} ⇒ 那句提示出现、输入框仍在且是空的，且不弹 toast', async () => {
    stubPocketai({ getProxyUrl: () => ({ ok: false, error: '配置库被占用' }) })
    mountWithProviders(<NetworkPanel />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(L('set.proxyUrlLabel'), '配置库被占用')]))
    const input = screen.getByPlaceholderText('http://127.0.0.1:7890') as HTMLInputElement
    expect(input.value).toBe('')
    expect(toasts()).toEqual([])
  })

  it('真抛错 ⇒ 同一句提示（这一族的 reject 面以前只进 console）', async () => {
    stubPocketai({ getProxyUrl: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<NetworkPanel />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(L('set.proxyUrlLabel'), '通道没接上')]))
  })

  it('反向对照：读到代理 ⇒ 输入框显示库里的值，一个 alert 都不许有', async () => {
    stubPocketai({ getProxyUrl: () => 'http://127.0.0.1:7890' })
    mountWithProviders(<NetworkPanel />)
    await waitFor(() => expect((screen.getByPlaceholderText('http://127.0.0.1:7890') as HTMLInputElement).value).toBe('http://127.0.0.1:7890'))
    expect(alerts()).toEqual([])
  })
})

describe('② 外观面板：三发读彼此独立，谁没读到才点谁的名', () => {
  it('全成功 ⇒ 零 alert，且屏上是读到的值（不是初始值）', async () => {
    stubPocketai(stubPrefs())
    mountWithProviders(<AppearancePanel />)
    await waitFor(() => expect(box(L('ui.launchAtLogin')).checked).toBe(true))
    expect(alerts()).toEqual([])
    expect(box(L('ui.closeToTray')).checked).toBe(true)
    expect(box(L('set.replyNotify')).checked).toBe(false)
  })

  it('只有界面偏好读不到 ⇒ 点那四项的名；两颗窗口行为开关与回复通知不许被顺带说成默认值', async () => {
    stubPocketai(stubPrefs(['getUiPrefs']))
    mountWithProviders(<AppearancePanel />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(UI_ITEMS, '配置库被占用')]))
    expect(box(L('ui.launchAtLogin')).checked).toBe(true)
    expect(box(L('ui.closeToTray')).checked).toBe(true)
  })

  it('只有窗口行为读不到 ⇒ 只点那两颗开关；而回复通知保持"关"是**读到**的，不许冒第二句', async () => {
    stubPocketai(stubPrefs(['getWindowBehavior']))
    mountWithProviders(<AppearancePanel />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(BEHAVIOR_ITEMS, '配置库被占用')]))
    // 三发独立：偏好读到了 ⇒ 透明度显示读到的 80%（默认是 100%），CSS 框里是读到的那段
    await waitFor(() => expect(screen.queryByText('80%')).not.toBeNull())
    expect((screen.getByDisplayValue('body{}') as HTMLTextAreaElement).value).toBe('body{}')
  })

  it('只有回复通知读不到 ⇒ 那一句单独出现，开关仍显示默认「开」（这一侧才是打扰用户的方向）', async () => {
    stubPocketai(stubPrefs(['getReplyNotifyEnabled']))
    mountWithProviders(<AppearancePanel />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(L('set.replyNotify'), '配置库被占用')]))
    expect(box(L('set.replyNotify')).checked).toBe(true)
  })

  it('三条同时失败 ⇒ 三句各说各的，按屏上顺序出现（合并成一句就会把读到的项也说成默认值）', async () => {
    stubPocketai(stubPrefs(['getUiPrefs', 'getWindowBehavior', 'getReplyNotifyEnabled']))
    mountWithProviders(<AppearancePanel />)
    await waitFor(() => expect(alerts()).toEqual([
      DEFAULTS(UI_ITEMS, '配置库被占用'),
      DEFAULTS(BEHAVIOR_ITEMS, '配置库被占用'),
      DEFAULTS(L('set.replyNotify'), '配置库被占用')
    ]))
  })
})
