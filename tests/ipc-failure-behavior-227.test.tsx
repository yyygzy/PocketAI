// @vitest-environment jsdom
// V4-Iter-227：同族最后两处「读不到却演成了一件事实」。
//
// 两处的形状与 §226 不同，因此两句话也不同：
// ① `AutoLockRow`（设置页加密块里那颗自动锁下拉）：读失败时 select 显示的是 AUTO_LOCK_OPTIONS 的
//    第一档「永不」，而那颗正是未配置时的默认值（`app-config.repo.ts:265` = `v ? Number(v) : 0`）
//    ⇒ 沿用 §226 那句「当前显示的是默认值」。原来的 `.catch(() => setValue(0))` 更糟：它把"没读到"
//    **写成"读到的是永不"**，还顺手把 disabled 解除，用户可以在不知道现状的情况下直接改。
// ② 划词浮条 `SelectionToolbar`：这一项的应用默认是**开**（`popup.ts:43` `!== '0'`），读失败时
//    `enabled` 保持初始的 false ⇒ 屏面上"不弹工具条"与"你自己关了"一模一样，而**显示的并不是默认值**。
//    所以那句换成「{what}读不到：{msg}（暂时按关闭处理）」，并且只在用户真的选词、也就是这条浮条
//    本该出现的那一刻出现（不弹 toast：那是 role=status，会和读数类提示混在一个面里）。
//
// 这批还撞出一条独立缺陷（用例③把它钉住）：浮条的定位要等 `useLayoutEffect` 量完 bar 的实际尺寸才
// `setPos`，而渲染的门是 `if (!bar || !pos) return null` ⇒ `barRef.current` 永远是 null ⇒ pos 永远
// 算不出来。**互锁**：工具条一次也没有出现过。这条以前没被任何用例碰过（`selection-actions.test.ts` 只测纯函数）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { EncryptionPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { SelectionToolbar } from '../src/renderer/src/components/SelectionToolbar'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'
import { SELECTION_ACTIONS } from '../src/renderer/src/utils/selection-actions'
import type { EncryptionStatus } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NL = String.fromCharCode(10)
const DEFAULTS = (what: string, msg: string): string =>
  L('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)
const OFF = (what: string, msg: string): string =>
  L('common.loadFailedOff').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

let warns: string[] = []
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})
const traces = (): string[] => warns.filter((w) => w.startsWith('[ipc] '))

const enc = (): EncryptionStatus =>
  ({ dbEncrypted: true, unlocked: true, masterPasswordVerified: true, autoLockTimeout: 0 } as unknown as EncryptionStatus)

/** 面板里那颗自动锁下拉（EncryptionPanel 只有这一颗 select） */
const lockSelect = (): HTMLSelectElement => {
  const all = screen.queryAllByRole('combobox')
  expect(all, '自动锁那颗下拉没挂出来').toHaveLength(1)
  return all[0] as HTMLSelectElement
}
/** 没有选中项时返回一句显眼的话，别让 undefined 混进逐字比对 */
const selectedText = (sel: HTMLSelectElement): string => sel.options[sel.selectedIndex]?.text ?? '(没有选中项)'

describe('① 自动锁下拉：读不到时那格「永不」必须被点名（它同时也是未配置时的默认值）', () => {
  const base = { hasRecoveryKey: () => false }

  it('resolve 的 {ok:false} ⇒ 一句「自动锁屏读不到：…（当前显示的是默认值）」，下拉仍是禁用态', async () => {
    stubPocketai({ ...base, getLockStatus: () => ({ ok: false, error: '锁服务不可达' }) })
    mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(L('enc.autoLock'), '锁服务不可达')]))
    // 本体不许被替代：那颗下拉与「永不」这格还在（§226 口径：这句不替代内容）
    expect(selectedText(lockSelect())).toBe(L('enc.autoLockNever'))
    expect(lockSelect().disabled).toBe(true)
    expect(toasts()).toEqual([])
  })

  it('真抛错 ⇒ 同一句、原因换成那句原文，并留下一条 [ipc] 痕', async () => {
    stubPocketai({ ...base, getLockStatus: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
    await waitFor(() => expect(alerts()).toEqual([DEFAULTS(L('enc.autoLock'), '通道没接上')]))
    expect(traces()).toEqual(['[ipc] settings.getLockStatus 失败: 通道没接上'])
  })

  it('原写法会把"没读到"写成"读到的是永不"：失败时不许解除禁用（否则用户是在不知道现状的情况下改）', async () => {
    stubPocketai({ ...base, getLockStatus: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(lockSelect().disabled).toBe(true)
  })

  it('反向对照：读到 0 ⇒ 无 alert，但下拉可用且显示「永不」——读到的永不与读不到的永不必须分得开', async () => {
    stubPocketai({ ...base, getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 0 }) })
    mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
    await waitFor(() => expect(lockSelect().disabled).toBe(false))
    expect(selectedText(lockSelect())).toBe(L('enc.autoLockNever'))
    expect(alerts()).toEqual([])
  })

  it('读到 5 分钟 ⇒ 显示「5 分钟」、无 alert（这句只属于读不到那一支）', async () => {
    stubPocketai({ ...base, getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 300_000 }) })
    mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
    await waitFor(() => expect(selectedText(lockSelect())).toBe(L('enc.autoLockMin').replace('{n}', '5')))
    expect(alerts()).toEqual([])
  })
})

/**
 * 造一段"用户选中了正文"的现场：`readSelection` 只要三样东西——非折叠选区、可读文本、
 * 一个非编辑区的宿主。jsdom 的选区没法真造，所以把 window.getSelection 换成结构等价的对象，
 * 组件的判定链（宿主、文本、矩形）全部真走。
 */
function fakeTextSelection(): void {
  const host = document.createElement('p')
  document.body.appendChild(host)
  const range = {
    commonAncestorContainer: host,
    getBoundingClientRect: () => ({ top: 40, bottom: 60, left: 20, right: 200, width: 180, height: 20 })
  }
  const sel = { rangeCount: 1, isCollapsed: false, toString: () => '  精选文本  ', getRangeAt: () => range }
  vi.spyOn(window, 'getSelection').mockReturnValue(sel as unknown as Selection)
}
const selectSomeText = async (): Promise<void> => {
  fireEvent.mouseUp(document, { button: 0 })
  await settle()
}
const actionButtons = (): string[] => screen.queryAllByRole('button').map((b) => (b.textContent ?? '').trim())

describe('② 划词浮条：默认是「开」的那一项，读不到时不能靠"不出现"来表态', () => {
  it('正向对照（也是本批撞出来的那条互锁）：读到 selectionEnabled:true ⇒ 选词后四个动作按钮真的挂出来', async () => {
    stubPocketai({ getPopupConfig: () => ({ quickEnabled: true, selectionEnabled: true, quickAccelerator: 'Alt+K', selectionAccelerator: 'Alt+J' }) })
    mountWithProviders(<SelectionToolbar />)
    await waitFor(() => expect(traces()).toEqual([]))
    await settle() // 那一发读要先落地：readErr 也是门的一部分，落地后组件才装选区监听
    fakeTextSelection()
    await selectSomeText()
    expect(actionButtons()).toEqual(SELECTION_ACTIONS.map((a) => L(`popup.act.${a}`)))
    expect(alerts()).toEqual([])
  })

  it('resolve 的 {ok:false} ⇒ 选词那一刻浮出「选区助手读不到：…（暂时按关闭处理）」，动作按钮一个都不在', async () => {
    stubPocketai({ getPopupConfig: () => ({ ok: false, error: '配置文件被占用' }) })
    mountWithProviders(<SelectionToolbar />)
    await settle() // 那一发读要先落地：readErr 也是门的一部分，落地后组件才装选区监听
    fakeTextSelection()
    await selectSomeText()
    expect(alerts()).toEqual([OFF(L('popup.selectionTitle'), '配置文件被占用')])
    expect(actionButtons()).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('真抛错 ⇒ 同一句，并留下一条 [ipc] 痕（原来这里是 .catch(() => setEnabled(false))，无声）', async () => {
    stubPocketai({ getPopupConfig: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<SelectionToolbar />)
    await settle() // 那一发读要先落地：readErr 也是门的一部分，落地后组件才装选区监听
    fakeTextSelection()
    await selectSomeText()
    expect(alerts()).toEqual([OFF(L('popup.selectionTitle'), '通道没接上')])
    expect(traces()).toEqual(['[ipc] selection.getPopupConfig 失败: 通道没接上'])
  })

  it('先前读到"开"、之后焦点刷新读不到 ⇒ 浮条让位给那句提示，不许继续按"开"演', async () => {
    let failing = false
    stubPocketai({
      getPopupConfig: () => (failing ? { ok: false, error: '配置文件被占用' } : { quickEnabled: true, selectionEnabled: true, quickAccelerator: 'Alt+K', selectionAccelerator: 'Alt+J' })
    })
    mountWithProviders(<SelectionToolbar />)
    await settle() // 那一发读要先落地：readErr 也是门的一部分，落地后组件才装选区监听
    fakeTextSelection()
    await selectSomeText()
    expect(actionButtons()).toEqual(SELECTION_ACTIONS.map((a) => L(`popup.act.${a}`)))
    failing = true
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise((r) => setTimeout(r, 0)) })
    await selectSomeText()
    expect(alerts()).toEqual([OFF(L('popup.selectionTitle'), '配置文件被占用')])
    expect(actionButtons()).toEqual([])
  })

  it('反向对照：真的读到"关" ⇒ 选词后什么都不出现——"你关了"不许被演成"读不到"', async () => {
    stubPocketai({ getPopupConfig: () => ({ quickEnabled: false, selectionEnabled: false, quickAccelerator: '', selectionAccelerator: '' }) })
    mountWithProviders(<SelectionToolbar />)
    await settle() // 那一发读要先落地：readErr 也是门的一部分，落地后组件才装选区监听
    fakeTextSelection()
    await selectSomeText()
    expect(alerts()).toEqual([])
    expect(actionButtons()).toEqual([])
  })

  it('挂载时就失败也不许先冒一句：那句只在用户真的选词、也就是浮条本该出现的那一刻出现', async () => {
    stubPocketai({ getPopupConfig: () => ({ ok: false, error: '配置文件被占用' }) })
    mountWithProviders(<SelectionToolbar />)
    await settle()
    expect(alerts()).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('窗口重新聚焦后读到了 ⇒ 那句消失、动作按钮回来（成功分支必须把残留的原因清掉）', async () => {
    let failing = true
    stubPocketai({
      getPopupConfig: () => (failing ? { ok: false, error: '配置文件被占用' } : { quickEnabled: true, selectionEnabled: true, quickAccelerator: 'Alt+K', selectionAccelerator: 'Alt+J' })
    })
    mountWithProviders(<SelectionToolbar />)
    await settle() // 那一发读要先落地：readErr 也是门的一部分，落地后组件才装选区监听
    fakeTextSelection()
    await selectSomeText()
    expect(alerts()).toEqual([OFF(L('popup.selectionTitle'), '配置文件被占用')])
    failing = false
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise((r) => setTimeout(r, 0)) })
    await selectSomeText()
    expect(alerts()).toEqual([])
    expect(actionButtons()).toEqual(SELECTION_ACTIONS.map((a) => L(`popup.act.${a}`)))
  })
})

describe('③ 两处的接线（源码区域断言：两条失败面都要落进自己那句提示）', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n')

  it('AutoLockRow 那一发：两条失败面都写 readErr，成功分支把读到的值交出去（§228 起还记住它好回滚）', () => {
    const src = read('src/renderer/src/modules/settings/SettingsModule.tsx')
    const from = 'window.pocketai' + NL + '      .getLockStatus()' + NL + '      .then((s) => {'
    const to = 'const label = (ms: number) =>'
    expect(src.split(from).length - 1, '起点锚命中次数不对').toBe(1)
    expect(src.split(to).length - 1, '终点锚命中次数不对').toBe(1)
    const r = src.slice(src.indexOf(from), src.indexOf(to))
    expect(r).toContain('setReadErr(ipcFailText(s, t(\'common.unknownError\')))')
    expect(r).toContain('setReadErr(errText(e, t(\'common.unknownError\')))')
    expect(r).toContain('lastKnown.current = s.autoLockTimeout ?? 0')
    expect(r).toContain('setValue(lastKnown.current)')
    // 这一发里 setValue 只许出现一次：只有"读到了"那一支才有权写值（原写法在 catch 里也调了一次）
    expect(r.split('setValue(').length - 1, 'setValue 的调用次数不对').toBe(1)
    expect(r).toContain('logIpcError(\'settings.getLockStatus\', e)')
    // 这一发只在挂载时读一次（deps 是 `[]`，父页的 refreshEnc 走的是另一条通道），
    // 所以这里**没有**"残留的原因压住后到的真数据"那一支——照 §225 补一句 setReadErr(null) 会是死代码
    // 提示本体挂在同一块里，且点的就是这颗下拉的名
    const row = src.slice(src.indexOf('return (' + NL + '    <div className="space-y-1">'), src.indexOf('const NoticeFn'))
    expect(row).toContain('<ShowingDefaultsNotice what={t(\'enc.autoLock\')} msg={readErr} />')
  })

  it('划词浮条那一发：两条失败面都交原因，成功分支把原因清掉、开关归位', () => {
    const src = read('src/renderer/src/components/SelectionToolbar.tsx')
    const from = '.getPopupConfig()'
    const to = 'useEffect(() => {' + NL + '    refreshEnabled()'
    expect(src.split(from).length - 1, '起点锚命中次数不对').toBe(1)
    expect(src.split(to).length - 1, '终点锚命中次数不对').toBe(1)
    const r = src.slice(src.indexOf(from), src.indexOf(to))
    expect(r).toContain('setReadErr(ipcFailText(cfg, t(\'common.unknownError\')))')
    expect(r).toContain('setReadErr(errText(e, t(\'common.unknownError\')))')
    expect(r).toContain('setReadErr(null)')
    // setEnabled 只许在"读到了"那一支出现：失败时没有任何可观察的降级可写（写了就是假装做了事，
    // 而真正的门是下面那句 `readErr ? 提示 : 按钮排`）
    expect(r.split('setEnabled(').length - 1, 'setEnabled 的调用次数不对').toBe(1)
    expect(r).toContain('logIpcError(\'selection.getPopupConfig\', e)')
    // 那句挂在浮条本体的位置上，且读失败时动作按钮整排让位
    expect(src).toContain("t('common.loadFailedOff', { what: t('popup.selectionTitle'), msg: readErr })")
    expect(src.split('role="alert"').length - 1).toBe(1)
  })

  it('两处都不许把提示写成 toast（role=status 那一面是操作反馈，读数类必须走 alert）', () => {
    expect(read('src/renderer/src/components/SelectionToolbar.tsx')).not.toContain('useToast')
    const sm = read('src/renderer/src/modules/settings/SettingsModule.tsx')
    expect(sm.slice(sm.indexOf('const AutoLockRow'), sm.indexOf('type NoticeFn'))).not.toContain('toast.error')
  })
})
