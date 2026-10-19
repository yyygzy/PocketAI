// @vitest-environment jsdom
// V4-Iter-220：§219 那批「catch 护不住当数据用」的点，挑最看得见的两处补真挂载行为用例。
//
// §219 的证据是"分类器读得出＋摘掉守卫闸门会红"，那仍然是一句**源码级**的话。这一批要演的是：
// 失败发生时，界面上那个控件真的回到它该在的位置、那句原因真的出现在用户眼前。
// 两处都各配反向对照——"失败要报错"改过了头变成"成功也报错"同样是回归。
//
// 首启向导那一处（同一形状的 reject 分支早已在用例里）补在 tests/renderer-first-run-wizard.test.tsx，
// 两条挨着才看得出来"抛错"与"resolve 的失败"是两条不同的路。
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useProviderData } from '../src/renderer/src/modules/agent/hooks/useProviderData'
import { AppearancePanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ProviderRecord } from '../src/shared/types'

const ZH = zh as unknown as Record<string, string>
const L = (key: string): string => ZH[key]!
/** 每条 toast / Notice 都是一个 role=status 的盒子；不滤空串（§218 的教训） */
const panels = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const provider = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'p1', type: 'openai', name: '探针服务商', baseUrl: 'https://api.example.com/v1',
  apiKeys: ['k'], models: ['old-model'], enabled: true, createdAt: 1, ...over
} as ProviderRecord)

describe('① useProviderData：拉模型失败不许把 {ok:false} 当成模型列表写进 provider.models', () => {
  it('失败 ⇒ provider.models 仍是拉之前那一份（V4-Iter-115 那个空盒子形状），且不打断"静默"口径', async () => {
    stubPocketai({
      listProviders: () => [provider()],
      listAssistants: () => [],
      fetchModels: () => ({ ok: false, error: 'Key 无效' })
    })
    const { result } = renderHook(() => useProviderData(), { wrapper: HookProviders })
    await waitFor(() => expect(result.current.providers).toHaveLength(1))
    await act(async () => { await result.current.fetchModels('p1') })
    await settle()
    expect(result.current.providers[0]!.models).toEqual(['old-model'])
    // 原注释写明的"失败静默"是既有决定：本批只保证不污染，不新增提示
    expect(panels()).toEqual([])
    expect(result.current.fetchingModels).toBe(false)
  })

  it('反向对照：拉成功 ⇒ 模型列表被换成新的（挡住"失败不写"顺手改成"从不写"）', async () => {
    stubPocketai({
      listProviders: () => [provider()],
      listAssistants: () => [],
      fetchModels: () => ['new-a', 'new-b']
    })
    const { result } = renderHook(() => useProviderData(), { wrapper: HookProviders })
    await waitFor(() => expect(result.current.providers).toHaveLength(1))
    await act(async () => { await result.current.fetchModels('p1') })
    await settle()
    expect(result.current.providers[0]!.models).toEqual(['new-a', 'new-b'])
  })
})

const mountPanel = (over: Record<string, unknown> = {}): void => {
  stubPocketai({
    getUiPrefs: () => ({ ok: true, data: { opacity: 1, customCss: '', chatFontSize: 'medium', codeCollapseLines: 5 } }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: { opacity: 1, customCss: '', chatFontSize: 'medium', codeCollapseLines: 5, ...patch } }),
    getWindowBehavior: () => ({ launchAtLogin: false, closeToTray: false }),
    getReplyNotifyEnabled: () => true,
    setLaunchAtLogin: (v: boolean) => ({ launchAtLogin: v }),
    setCloseToTray: (v: boolean) => ({ closeToTray: v }),
    setReplyNotifyEnabled: (v: boolean) => v,
    ...over
  })
  mountWithProviders(<AppearancePanel />)
}
const box = (label: RegExp): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement

describe('② 外观面板的两颗开关：乐观置位之后失败要回滚，并把原因说出来', () => {
  it('开机自启写入失败 ⇒ 勾回到原值、Notice 逐字给出主进程那句原因', async () => {
    mountPanel({ setLaunchAtLogin: () => ({ ok: false, error: '启动项写入失败' }) })
    fireEvent.click(await screen.findByLabelText(new RegExp(L('ui.launchAtLogin'))))
    await settle()
    expect(box(new RegExp(L('ui.launchAtLogin'))).checked).toBe(false)
    expect(screen.getByText('启动项写入失败')).toBeTruthy()
  })

  it('关到托盘写入失败 ⇒ 同样回滚＋报原因（两处同一形状，逐个钉免得只改一个）', async () => {
    mountPanel({ setCloseToTray: () => ({ ok: false, error: '注册表被占用' }) })
    fireEvent.click(await screen.findByLabelText(new RegExp(L('ui.closeToTray'))))
    await settle()
    expect(box(new RegExp(L('ui.closeToTray'))).checked).toBe(false)
    expect(screen.getByText('注册表被占用')).toBeTruthy()
  })

  it('反向对照：写入成功 ⇒ 勾留在新值、一个 Notice 都不弹', async () => {
    mountPanel({ setLaunchAtLogin: (v: boolean) => ({ launchAtLogin: v }) })
    fireEvent.click(await screen.findByLabelText(new RegExp(L('ui.launchAtLogin'))))
    await settle()
    expect(box(new RegExp(L('ui.launchAtLogin'))).checked).toBe(true)
    expect(panels()).toEqual([])
    expect(document.body.textContent).not.toContain('启动项写入失败')
  })

  // 注：§219 的第 18 处（`getReplyNotifyEnabled().then(setReplyNotify)` 那条 .then）我试过写用例，
  // 但它在这颗开关上**没有可观测面**：状态默认就是"开"，而失败对象 `{ok:false}` 是真值 ⇒ DOM 上两种写法都显示勾着，
  // React 也不为这种取值告警（实测：把 .then 装回原样，我的断言与 console 探针全绿）。
  // 所以那一处只留 §219 的源码级判据，不在此伪装成"演过一遍"。
})
