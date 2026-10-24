// V4-Iter-271：第四面静默名单第四簇——服务商类四发清单读（跨两屏）。
//
// 名单现查 30 条里这一族占四条，分在两屏：
//  · `ChannelsPanel.tsx:37/38`——网关配置里那两枚下拉（服务商／助手），都在挂载读；
//  · `ProviderSettings.tsx:56/65`——服务商清单＋每行模型后面那枚「委派能力判定」徽标。
// 改前四发的失败侧都是 `if (!hasIpcFailed(v)) 写 state`＝什么都不做，于是：
//  · 渠道那两枚下拉只剩占位项（「未绑定助手」「请选择服务商」）——服务商那发还会连带让「模型」下拉整块不出现；
//  · 设置页左栏摆「尚未配置，点击「新增」」＝把通道故障演成"你一台服务商都没配"；
//  · 能力判定那发让每行模型的徽标整块不出现＝**库里明明存着判定，屏上说成"这台从没探过"**。
//
// 形状：四发各挂一句（四份不同数据）、各配一颗重试键——两屏都没有"再点一下就重拉"的天然出口
// （渠道面板切网关类型不重拉这两份清单；设置页的保存／删台／取模型会顺带 `load()`，但那是做完别的事之后）。
// 「探测能否派活」那颗键**不算**能力判定那一读的出口（它是三发真请求，不是重读清单），所以那颗键不代替重试键。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ChannelsPanel } from '../src/renderer/src/modules/agent/channels/ChannelsPanel'
import { ProviderSettings } from '../src/renderer/src/modules/settings/ProviderSettings'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, ChannelConfig, ChannelType, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const PROVIDERS_WHAT = L('common.providersList')
const ASSISTANTS_WHAT = L('common.assistantsList')
const CAPS_WHAT = L('common.capabilityVerdicts')
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const options = (): string[] => Array.from(document.querySelectorAll('option')).map((o) => (o.textContent ?? '').trim())
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const REASON = 'IO:通道断了'

const GLM = {
  id: 'p-glm', type: 'openai-compatible', name: 'PROBE-GLM', baseUrl: 'https://example.invalid/v1',
  apiKeys: ['••••st6I'], models: ['glm-4.6'], enabled: true, createdAt: 1
} as unknown as ProviderRecord
const ASSISTANT = { id: 'a1', name: 'PROBE-助手', icon: '🤖' } as unknown as AssistantRecord

const fakeCfg = (type: ChannelType): ChannelConfig =>
  ({
    type, enabled: false, hasPrimarySecret: false, hasSecondarySecret: false,
    appId: '', whitelist: '', assistantId: '', providerId: '', model: '', agentMode: false
  }) as unknown as ChannelConfig

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

// ─────────────────────── ① 渠道面板那两发 ───────────────────────

function mountChannels(over: Record<string, (...a: any[]) => unknown> = {}): void {
  stubPocketai({
    getEncryptionStatus: () => ({
      mode: 'db', unlocked: true, dbEncrypted: true, fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: 131072, kdfAtCurrentTier: true
    }),
    getChannelConfig: (type: unknown) => fakeCfg(type as ChannelType),
    listChannelStatus: () => ({}),
    onChannelStatus: () => () => {},
    listProviders: () => [GLM],
    listAssistants: () => [ASSISTANT],
    startChannel: () => ({ ok: true }),
    stopChannel: () => ({ ok: true }),
    setChannelConfig: (type: unknown) => fakeCfg(type as ChannelType),
    ...over
  })
  mountWithProviders(<ChannelsPanel />)
}

describe('① 渠道面板：服务商与助手两发各说一句一颗键', () => {
  it('服务商那发失败 ⇒ 那句上屏，而助手那发明明读到、不许跟着闭嘴', async () => {
    mountChannels({ listProviders: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(PROVIDERS_WHAT, REASON)]))
    expect(bodyText(), '读到的一份不许被另一发说成不可信').not.toContain(FAILED(ASSISTANTS_WHAT, ''))
    expect(options()).toContain('PROBE-助手')
  })

  it('助手那发 reject ⇒ 同一张脸、点自己的名', async () => {
    mountChannels({ listAssistants: () => Promise.reject(new Error('ASSIST:助手通道断了')) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(ASSISTANTS_WHAT, 'ASSIST:助手通道断了')]))
    expect(options()).toContain('PROBE-GLM')
  })

  it('那颗键点了有效，而且不去重发另一发', async () => {
    let providersFail = true
    let assistantCalls = 0
    mountChannels({
      listProviders: () => (providersFail ? { ok: false, error: REASON } : [GLM]),
      listAssistants: () => {
        assistantCalls += 1
        return [ASSISTANT]
      }
    })
    await waitFor(() => expect(alerts()).toEqual([FAILED(PROVIDERS_WHAT, REASON)]))
    const before = assistantCalls
    providersFail = false
    fireEvent.click(screen.getByTestId('channels-providers-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(options()).toContain('PROBE-GLM')
    expect(assistantCalls, '服务商那颗键只重发服务商这一发').toBe(before)
  })

  // 同上一条纪律：每一颗键都要有用例点一次（否则"键接错发"这种写法在 CI 里是看不见的）
  it('助手那颗键点的是助手那一发：读完那句收回，且不替服务商重发', async () => {
    let assistantsFail = true
    let providerCalls = 0
    mountChannels({
      listProviders: () => {
        providerCalls += 1
        return [GLM]
      },
      listAssistants: () => (assistantsFail ? Promise.reject(new Error('ASSIST:助手通道断了')) : [ASSISTANT])
    })
    await waitFor(() => expect(alerts()).toEqual([FAILED(ASSISTANTS_WHAT, 'ASSIST:助手通道断了')]), MOUNT_BUDGET)
    const before = providerCalls
    assistantsFail = false
    fireEvent.click(screen.getByTestId('channels-assistants-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(providerCalls, '助手那颗键只重发助手这一发').toBe(before)
    expect(options()).toContain('PROBE-助手')
  })

  it('反向对照：两发都读到 ⇒ 零 alert，两枚下拉各有项', async () => {    mountChannels()
    await waitFor(() => expect(options()).toContain('PROBE-GLM'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    expect(options()).toContain('PROBE-助手')
  })

  // §295 B158：切 channel type tab 不重拉这两份清单。§271 那批交付时把这条写在本文件顶注里
  // （"渠道面板切网关类型不重拉这两份清单"）——是"这一屏的天然出口不是切 tab、而是各发自己
  // 的重试键"这个形状判断的依据，但只在源码里：`ChannelsPanel.tsx:194-198` 那个 `switchType`
  // 只做 `setActiveType` ＋ 清两份凭据草稿、不调 `loadProviders` / `loadAssistants`。
  // 本批钉这个"不"：默认 Telegram、点 Discord ⇒ 两个通道 callCount 都停在挂载那一次的 1。
  it('§295 B158：切 tab 只切状态、不重发服务商与助手两份清单', async () => {
    const calls = { providers: 0, assistants: 0 }
    mountChannels({
      listProviders: () => {
        calls.providers += 1
        return [GLM]
      },
      listAssistants: () => {
        calls.assistants += 1
        return [ASSISTANT]
      }
    })
    await waitFor(() => {
      expect(calls.providers).toBe(1)
      expect(calls.assistants).toBe(1)
    }, MOUNT_BUDGET)
    // 切到 Discord（默认是 Telegram）；stub 的自增发生在被调那一刻、同步，
    // 所以 fireEvent.click 后立刻读计数就能抓住"切 tab 顺手多发一发"的形状
    fireEvent.click(screen.getByRole('button', { name: L('channel.discord.title') }))
    expect(calls.providers, '切 tab 不重发服务商清单').toBe(1)
    expect(calls.assistants, '切 tab 不重发助手清单').toBe(1)
  })
})

// ─────────────────────── ② 设置页那两发 ───────────────────────

function mountProviderSettings(over: Record<string, (...a: any[]) => unknown> = {}): void {
  stubPocketai({
    listProviders: () => [GLM],
    saveProvider: (r) => r,
    deleteProvider: () => ({ ok: true }),
    revealProviderKeys: () => ({ apiKeys: ['sk-real-looking-key'] }),
    fetchModels: () => [],
    testProvider: () => ({ ok: true }),
    listDelegateCapabilities: () => [],
    probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: null }),
    ...over
  })
  mountWithProviders(<ProviderSettings />)
}

const CAP_PROBE_BTN = '探测能否派活'

describe('② 设置页：服务商清单与能力判定各说一句一颗键', () => {
  it('服务商那发失败 ⇒「尚未配置，点击「新增」」让位给那句；那颗键点了有效', async () => {
    let fail = true
    mountProviderSettings({ listProviders: () => (fail ? { ok: false, error: REASON } : [GLM]) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(PROVIDERS_WHAT, REASON)]))
    expect(bodyText(), '把"读不到"演成"你一台都没配"').not.toContain(L('provider.empty'))
    fail = false
    fireEvent.click(screen.getByTestId('provider-settings-providers-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain('PROBE-GLM')
  })

  it('能力判定那发失败 ⇒ 编辑态里那句上屏，而那颗「探测能否派活」仍可点（说实话不等于禁输入）', async () => {
    mountProviderSettings({ listDelegateCapabilities: () => ({ ok: false, error: 'CAPS:判定表读不到' }) })
    fireEvent.click(await screen.findByText('PROBE-GLM'))
    await waitFor(() => expect(alerts()).toEqual([FAILED(CAPS_WHAT, 'CAPS:判定表读不到')]), MOUNT_BUDGET)
    const probe = screen.getByText(CAP_PROBE_BTN).closest('button')
    expect(probe, '那颗键本来就在，别把它按 disabled').toBeTruthy()
    expect(probe!.disabled).toBe(false)
  })

  it('反向对照：判定表读到 ⇒ 零 alert，那颗探测键照常在场', async () => {
    mountProviderSettings({
      listDelegateCapabilities: () => [
        { key: `p-glm::glm-4.6`, capability: 'native_tools_ok', samples: 3, nativeHits: 3, stale: false, delegationEnabled: false }
      ]
    })
    fireEvent.click(await screen.findByText('PROBE-GLM'))
    await waitFor(() => expect(bodyText()).toContain(CAP_PROBE_BTN), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })

  it('两发各点各的名：服务商读到而判定读不到 ⇒ 只有判定那一句，左栏照常列台子', async () => {
    mountProviderSettings({ listDelegateCapabilities: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(bodyText()).toContain('PROBE-GLM'), MOUNT_BUDGET)
    expect(alerts(), '未进编辑态时不该先挂上判定那句').toEqual([])
    fireEvent.click(screen.getByText('PROBE-GLM'))
    await waitFor(() => expect(alerts()).toEqual([FAILED(CAPS_WHAT, REASON)]), MOUNT_BUDGET)
    expect(bodyText()).not.toContain(FAILED(PROVIDERS_WHAT, ''))
  })

  // 变异 V13 第一版没杀掉：把判定那颗键接去重发服务商清单，屏上看着一样（那句永远收不掉，但没人点过它）
  // ⇒ 那颗键必须有用例点一次，并钉它只重发自己那一发
  it('判定那颗键点的是判定那一发：读完那句收回，且不替左栏重发清单', async () => {
    let capsFail = true
    let providerCalls = 0
    mountProviderSettings({
      listProviders: () => {
        providerCalls += 1
        return [GLM]
      },
      listDelegateCapabilities: () => (capsFail ? { ok: false, error: 'CAPS:判定表读不到' } : [])
    })
    fireEvent.click(await screen.findByText('PROBE-GLM'))
    await waitFor(() => expect(alerts()).toEqual([FAILED(CAPS_WHAT, 'CAPS:判定表读不到')]), MOUNT_BUDGET)
    const before = providerCalls
    capsFail = false
    fireEvent.click(screen.getByTestId('provider-settings-caps-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(providerCalls, '判定那颗键只重发判定这一发').toBe(before)
    expect(bodyText()).toContain('PROBE-GLM')
  })
})
