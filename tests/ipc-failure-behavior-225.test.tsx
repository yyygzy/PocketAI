// @vitest-environment jsdom
// V4-Iter-225：把 §222 那句「读不到」接进设置页剩下的四块面板。
//
// 这四块与 §222 那三块形状不同：**加密／许可证／更新的数据不是面板自己拉的**，
// 是 SettingsModule 挂载时一次拉三份再当 props 传下去。§221 把"失败对象被当数据写进 state"收口后，
// 失败的结果就是那份数据一直是 null，而面板的门是 `if (!x) return 加载中…` ⇒
// 用户看到的是一个**永远不会结束的加载**。所以原因得由父页一起交下来（`err` prop），
// 面板的门改成"没有数据时：有原因就说原因，没原因才说还在加载"。
//
// 划词浮窗那块是自己拉的，它以前在真抛错时**降级成「全关 + 空快捷键」当配置显示**
// （注释写明是为了"避免面板卡 loading"）——那是 §196 那一族：把默认值当成已保存的事实，
// 而这时候拨一颗开关就会把整份配置按默认值写回去。本批把那条降级换成「读不到」。
//
// 两层证据：面板的门（真挂载，含 §222 学来的"残留的 err 不许压过到了的数据"这条反向对照）
// ＋ 父页的接线（源码区域断言：每发 fetch 的两条失败面都要落进自己那块面板的 err，调用点要把它传下去）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { screen, waitFor } from '@testing-library/react'
import { EncryptionPanel, LicensePanel, UpdatePanel, PopupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { EncryptionStatus, LicenseStatus, UpdateInfo } from '../src/shared/types'

const NL = String.fromCharCode(10)
const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
/** 常驻那句应长成这样；同一条用例里「加载中…」必须不在场（§222 口径：只断言前者会放过两句同时挂着的写法） */
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const loadingOn = (): boolean => screen.queryByText(L('common.loading')) !== null

const enc = (): EncryptionStatus => ({ dbEncrypted: true, unlocked: true, masterPasswordVerified: true, autoLockTimeout: 0 } as unknown as EncryptionStatus)
const lic = (): LicenseStatus => ({ licensed: true, edition: 'pro', expiresAt: null } as unknown as LicenseStatus)
const info = (): UpdateInfo => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: true } as unknown as UpdateInfo)

describe('① 加密面板：数据由父页传下来，门要有三条腿', () => {
  it('没数据且有原因 ⇒ 「读不到：库被占用」常驻，「加载中…」不在场', () => {
    stubPocketai({})
    mountWithProviders(<EncryptionPanel enc={null} err="库被占用" onChange={() => {}} />)
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(loadingOn()).toBe(false)
  })

  it('没数据也没有原因 ⇒ 这才是"还在加载"，这时不许冒 alert（两句分得开才有意义）', () => {
    stubPocketai({})
    mountWithProviders(<EncryptionPanel enc={null} err={null} onChange={() => {}} />)
    expect(loadingOn()).toBe(true)
    expect(alerts()).toEqual([])
  })

  it('反向对照：数据到了 ⇒ 面板照常渲染，残留的原因不许把面板压掉（§222 那三行死代码的教训）', () => {
    // 数据一到，加密面板会连带挂出自动锁与恢复密钥两块，它们各自还要一发读
    stubPocketai({ getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 0 }), hasRecoveryKey: () => false })
    mountWithProviders(<EncryptionPanel enc={enc()} err="库被占用" onChange={() => {}} />)
    expect(alerts()).toEqual([])
    expect(loadingOn()).toBe(false)
  })
})

describe('② 许可证面板', () => {
  const stubs = { getLicenseFingerprint: () => 'fp-1234' }

  it('lic 为 null 且有原因 ⇒ 那句原因常驻，「加载中…」不在场', () => {
    stubPocketai(stubs)
    mountWithProviders(<LicensePanel lic={null} err="许可证文件损坏" onChange={() => {}} />)
    expect(alerts()).toEqual([FAILED('许可证文件损坏')])
    expect(loadingOn()).toBe(false)
  })

  it('反向对照：lic 到了 ⇒ 无 alert、无「加载中…」', () => {
    stubPocketai(stubs)
    mountWithProviders(<LicensePanel lic={lic()} err={null} onChange={() => {}} />)
    expect(alerts()).toEqual([])
    expect(loadingOn()).toBe(false)
  })

  // §294 B165：LicensePanel 里那一发指纹读失败不能演成「没有指纹」。
  // `SettingsModule.tsx:1582-1595` 是组件自己拉的（不像 lic 从父页传下来），
  // §278 那批交付时把失败面写成 `ShowingDefaultsNotice what={t('lic.fpLabel')} …`
  // ——即"这里显示的是默认值"那一族（§226），但**只在源码级**判据；本批把两半都补进 CI。
  it('§294 指纹那一读失败 ⇒ 那句「这里显示的是默认值」上屏（§226 第二形态）', async () => {
    stubPocketai({
      ...stubs,
      getLicenseFingerprint: () => ({ ok: false, error: 'FP:指纹通道断了' })
    })
    mountWithProviders(<LicensePanel lic={lic()} err={null} onChange={() => {}} />)
    // ShowingDefaultsNotice 用 `common.loadFailedDefaults` 那句、"有东西但那不是你的设置"
    const sentence = L('common.loadFailedDefaults')
      .replace('{what}', L('lic.fpLabel'))
      .replace('{msg}', 'FP:指纹通道断了')
    await waitFor(() => expect(alerts()).toEqual([sentence]))
    // 老实说"读不到"不许同时把那一栏禁掉——`无法读取` 兜底字要仍在场（说实话不等于禁输入）
    expect(screen.getByText(L('lic.fpUnavailable'))).toBeTruthy()
  })

  it('§294 反向对照：指纹读到 ⇒ 那句不出现、指纹值上屏（默认值兜底也不该出现）', async () => {
    stubPocketai(stubs) // 复用文件顶的 'fp-1234'
    mountWithProviders(<LicensePanel lic={lic()} err={null} onChange={() => {}} />)
    await waitFor(() => expect(screen.getByText('fp-1234')).toBeTruthy())
    expect(alerts(), '"读到了"不该被说成"这里显示的是默认值"').toEqual([])
    expect(screen.queryByText(L('lic.fpUnavailable')), '兜底字只在真读不到时挂').toBeNull()
  })
})

describe('③ 更新面板', () => {
  it('info 为 null 且有原因 ⇒ 那句原因常驻（"当前版本／检查更新"全建在这份数据上）', () => {
    stubPocketai({})
    mountWithProviders(<UpdatePanel info={null} err="更新源不可达" status={{ status: 'idle' }} />)
    expect(alerts()).toEqual([FAILED('更新源不可达')])
    expect(loadingOn()).toBe(false)
  })

  it('反向对照：info 到了 ⇒ 无 alert、不出现那句「读不到」', async () => {
    stubPocketai({})
    mountWithProviders(<UpdatePanel info={info()} err={null} status={{ status: 'idle' }} />)
    await waitFor(() => expect(loadingOn()).toBe(false))
    expect(alerts()).toEqual([])
  })
})

describe('④ 划词浮窗：自己拉配置，两条失败面都要落到「读不到」，不再显示假的"全关"', () => {
  it('resolve 的 {ok:false} ⇒ 那句原因，两颗开关的标题一律不在场，也不弹 toast', async () => {
    stubPocketai({ getPopupConfig: () => ({ ok: false, error: '配置文件被占用' }) })
    mountWithProviders(<PopupPanel />)
    await waitFor(() => expect(alerts()).toEqual([FAILED('配置文件被占用')]))
    expect(loadingOn()).toBe(false)
    expect(toasts()).toEqual([])
    expect(screen.queryByText(L('popup.quickTitle'))).toBeNull()
    expect(screen.queryByText(L('popup.selectionTitle'))).toBeNull()
  })

  it('真抛错 ⇒ 同样那句原因（以前这里降级成「全关 + 空快捷键」，把默认值当已保存的配置显示）', async () => {
    stubPocketai({ getPopupConfig: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<PopupPanel />)
    await waitFor(() => expect(alerts()).toEqual([FAILED('通道没接上')]))
    expect(screen.queryByText(L('popup.quickTitle'))).toBeNull()
  })

  it('反向对照：读到配置 ⇒ 两颗开关照常在，alert 与「加载中…」都不该出现', async () => {
    stubPocketai({ getPopupConfig: () => ({ quickEnabled: true, selectionEnabled: false, quickAccelerator: 'CommandOrControl+Shift+K', selectionAccelerator: '' }) })
    mountWithProviders(<PopupPanel />)
    await waitFor(() => expect(screen.queryByText(L('popup.quickTitle'))).not.toBeNull())
    expect(alerts()).toEqual([])
    expect(loadingOn()).toBe(false)
  })
})

describe('⑤ 父页的接线：三发 fetch 各有两条失败面，都要交给自己那块面板', () => {
  // 这文件是 w/crlf：先归一成 LF，区域锚才能用多行写法——"区域对不对"与"行尾是什么"是两件事
  //（§216 那次孤立 CR 的坑正是被行尾骗出来的）
  const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/settings/SettingsModule.tsx'), 'utf-8').replace(/\r\n/g, '\n')
  /** [起点锚, 终点锚) 之间那一段。两条锚都必须只命中一次——区域本身不许是猜的（§204 那条"区域溢出"的教训） */
  const region = (from: string, to: string): string => {
    expect(src.split(from).length - 1, `起点锚命中次数不对：${from}`).toBe(1)
    expect(src.split(to).length - 1, `终点锚命中次数不对：${to}`).toBe(1)
    const i = src.indexOf(from)
    const j = src.indexOf(to)
    expect(j, `终点锚在起点之前：${to}`).toBeGreaterThan(i)
    return src.slice(i, j)
  }
  /** 调用点那一句 JSX：从标签起，到它自己那个 `/>` 止 */
  const callSite = (tag: string): string => {
    expect(src.split(tag).length - 1, `调用锚命中次数不对：${tag}`).toBe(1)
    const i = src.indexOf(tag)
    return src.slice(i, src.indexOf('/>', i) + 2)
  }

  it('加密／许可证／更新：resolve 与 reject 两条失败面都写进各自的 err，成功分支仍写数据本体', () => {
    const cases: Array<[string, string, string, string]> = [
      // 许可证／更新这两发仍在父页里；加密那一发 §344 搬进了共享同步器，单独一条判据在下面
      ['window.pocketai.getLicenseStatus().then((v) => {' + NL + '      if (hasIpcFailed(v)) { setLicErr(', 'window.pocketai.getUpdateInfo().then((v) => {' + NL + '      if (hasIpcFailed(v)) { setUpdErr(', 'setLicErr', 'setLic(v)'],
      ['window.pocketai.getUpdateInfo().then((v) => {' + NL + '      if (hasIpcFailed(v)) { setUpdErr(', '// 监听主进程推送的更新状态事件', 'setUpdErr', 'setUpdateInfo(v)']
    ]
    for (const [from, to, setter, okSetter] of cases) {
      const r = region(from, to)
      expect(r, `${setter}：resolve 面没判`).toContain('if (hasIpcFailed(v))')
      expect(r, `${setter}：resolve 面没把原因交出去`).toContain(`${setter}(ipcFailText(v, t('common.unknownError')))`)
      expect(r, `${setter}：reject 面没把原因交出去`).toContain(`${setter}(errText(e, t('common.unknownError')))`)
      expect(r, `${okSetter}：成功分支不许被顺手删掉`).toContain(okSetter)
    }
  })

  // §344 把加密那一发（挂载／锁屏事件／面板动作后三处）收进 utils/lock-flags.ts 的共享同步器。
  // 本节的意图不变：这一发的两条失败面都要把原因交出去、成功分支照旧写本体——只是读者搬了家，判据跟着搬。
  it('加密那一发搬进共享同步器后，两条失败面与成功分支仍然齐全', () => {
    const flags = fs
      .readFileSync(path.resolve(__dirname, '../src/renderer/src/utils/lock-flags.ts'), 'utf-8')
      .replace(/\r\n/g, '\n')
    const ANCHOR = 'export function createEncryptionStatusSyncer'
    expect(flags.split(ANCHOR).length - 1, `起点锚命中次数不对：${ANCHOR}`).toBe(1)
    const body = flags.slice(flags.indexOf(ANCHOR))
    expect(body, 'resolve 面没判').toContain('if (hasIpcFailed(s))')
    expect(body, 'resolve 面没把原因交出去').toContain(`deps.setErr(ipcFailText(s, deps.t('common.unknownError')))`)
    expect(body, 'reject 面没把原因交出去').toContain(`deps.setErr(errText(e, deps.t('common.unknownError')))`)
    expect(body, '成功分支不许被顺手删掉').toContain('deps.setStatus(s)')
  })

  it('三个调用点都把各自的 err 传下去了（漏一个就还是那个永远不会结束的加载）', () => {
    expect(callSite('<EncryptionPanel ')).toContain('err={encCopy.err}')
    expect(callSite('<UpdatePanel ')).toContain('err={updErr}')
    expect(callSite('<LicensePanel ')).toContain('err={licErr}')
  })
})
