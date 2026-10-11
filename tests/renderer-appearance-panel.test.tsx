// @vitest-environment jsdom
// 外观面板用例：折叠阈值输入的提交/回滚口径（V4-Iter-87 当时唯一没进 CI 的一块）
//
// 拆组件并不必要（V4-Iter-96 证伪了这条假设）：AppearancePanel 只依赖 useI18n + 本地 state，
// 桩 7 个 IPC 通道就能挂起来。测的重点是三条只有真点才有意义的行为：
// 越界夹取、空输入不写库、写库失败要连全局阈值一起回滚。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { AppearancePanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { CODE_COLLAPSE_THRESHOLD } from '../src/renderer/src/utils/code-block'
import { codeCollapseLines, setCodeCollapseLines } from '../src/renderer/src/code-collapse'

const INPUT_ID = 'ui-code-collapse-lines'

let saved: Record<string, unknown>[] = []

function mount(prefs: Record<string, unknown> = {}) {
  saved = []
  stubPocketai({
    getUiPrefs: () => ({
      ok: true,
      data: {
        opacity: 1,
        customCss: '',
        chatFontSize: 'medium',
        codeCollapseLines: 5,
        ...prefs
      }
    }),
    setUiPrefs: (patch: Record<string, unknown>) => {
      saved.push(patch)
      return { ok: true, data: { opacity: 1, customCss: '', chatFontSize: 'medium', codeCollapseLines: 5, ...patch } }
    },
    getWindowBehavior: () => ({ launchAtLogin: false, closeToTray: false }),
    getReplyNotifyEnabled: () => true,
    setLaunchAtLogin: (v: boolean) => ({ launchAtLogin: v }),
    setCloseToTray: (v: boolean) => ({ closeToTray: v }),
    setReplyNotifyEnabled: (v: boolean) => v
  })
  mountWithProviders(<AppearancePanel />)
}

function input(): HTMLInputElement {
  return document.getElementById(INPUT_ID) as HTMLInputElement
}

beforeEach(() => {
  setCodeCollapseLines(CODE_COLLAPSE_THRESHOLD)
})

describe('外观面板 — 代码块折叠阈值', () => {
  it('挂载后输入框显示持久化值（不是常量默认）', async () => {
    mount()
    await screen.findByText('代码块折叠行数')
    expect(input().value).toBe('5')
    expect(codeCollapseLines()).toBe(CODE_COLLAPSE_THRESHOLD) // 读偏好不改全局
  })

  it('输入 999 失焦：提交前夹到 200，全局阈值同步生效', async () => {
    mount()
    await screen.findByText('代码块折叠行数')
    fireEvent.change(input(), { target: { value: '999' } })
    fireEvent.blur(input())
    expect(saved.some((p) => (p as { codeCollapseLines?: number }).codeCollapseLines === 200)).toBe(true)
    expect(input().value).toBe('200')
    expect(codeCollapseLines()).toBe(200)
  })

  it('清空后失焦：还原当前值且一次都不写库', async () => {
    mount()
    await screen.findByText('代码块折叠行数')
    const before = saved.length
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.blur(input())
    expect(input().value).toBe('5')
    expect(saved.length).toBe(before)
    expect(pocketaiCalls().some((c) => c.fn === 'setUiPrefs')).toBe(false)
  })

  it('填 0 是合法值（永不折叠），不能被当成"没填"', async () => {
    mount()
    await screen.findByText('代码块折叠行数')
    fireEvent.change(input(), { target: { value: '0' } })
    fireEvent.blur(input())
    expect(saved.some((p) => (p as { codeCollapseLines?: number }).codeCollapseLines === 0)).toBe(true)
    expect(codeCollapseLines()).toBe(0)
  })

  it('持久化失败要连全局阈值一起回滚，并把原因显示出来', async () => {
    stubPocketai({
      getUiPrefs: () => ({
        ok: true,
        data: { opacity: 1, customCss: '', chatFontSize: 'medium', codeCollapseLines: 7 }
      }),
      setUiPrefs: () => ({ ok: false, error: '存不下' }),
      getWindowBehavior: () => ({ launchAtLogin: false, closeToTray: false }),
      getReplyNotifyEnabled: () => true,
      setLaunchAtLogin: (v: boolean) => ({ launchAtLogin: v }),
      setCloseToTray: (v: boolean) => ({ closeToTray: v }),
      setReplyNotifyEnabled: (v: boolean) => v
    })
    setCodeCollapseLines(7) // 全局阈值与偏好一致（启动时 loadCodeCollapseLines 的效果）
    mountWithProviders(<AppearancePanel />)
    await screen.findByText('代码块折叠行数')
    expect(input().value).toBe('7')
    fireEvent.change(input(), { target: { value: '40' } })
    fireEvent.blur(input())
    expect(await screen.findByText(/存不下/)).toBeTruthy()
    // 回滚回到「面板加载到的持久化值」，且输入框与全局阈值不能一个新一一个旧
    expect(input().value).toBe('7')
    expect(codeCollapseLines()).toBe(7)
  })
})
