// V4-Iter-258：管家页那三发裸值通道改信封＋Agent 面板那两发写失败上屏。
//
// 为什么不是"再补一句提示"就完事：这三发在 preload 里类型标成裸值（原 `src/preload/index.ts:116/122/1204`），
// 而 `safeHandle` 的失败是一个**解析出来的** `{ok:false,error}`（`src/main/ipc/safe-handle.ts:181`）⇒
// 失败对象既过得了类型、又过得了 `if (hw) setHardware(hw)`。探针实测的三种谎法（本批的立项依据）：
//  · 硬件画像 ⇒ render 当场 TypeError（`hardware.os.platform`），根层 AppErrorBoundary 接住＝**整站**变崩溃屏；
//  · 数据库完整性 ⇒ 「integrity_check ❌ undefined」——把"没读到"演成"库坏了"（`integrityCheck()` 自己的形状就是 `{ok,details}`，撞车）；
//  · 数据健康报告 ⇒ 三个计数 undefined、孤儿消息／向量块反而显示「✅ 0」（把没读到演成健康）。
// 所以这一批走的是**根治形状**：main 侧包信封、preload 类型诚实化 ⇒ 调用点不判就编译期红。
// 界面那一档按既有那两张脸：失败时整块换成「读不到：原因」（§222），且必须与"检查真的失败"分辨开。
//
// 另一件：`setUiPrefs` 那两发是**写**，失败过去只进 console（§257 登记的设计内）。口径改成
// "面板常驻一句、写成功即收回"，不弹 toast——那发在挂载恢复后也会重放一次同值写入，
// 弹出来会撞在启动那一下。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  AssistantRecord,
  ConversationRecord,
  HardwareInfo,
  HealthReport,
  ModelRecommendation,
  ProviderRecord
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => (document.body.textContent ?? '')

// 桩按返回类型写死（§255 那条教训）：缺字段编译期就红，而不是运行期 TypeError 或假绿
const HW: HardwareInfo = {
  os: { platform: 'win32', release: '10.0', arch: 'x64', hostname: 'BOX' },
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: {
    type: 'ssd', removable: false, drive: 'C:', volumeLabel: null, filesystem: 'NTFS',
    totalSpace: 512 * 1024 ** 3, freeSpace: 1024 ** 3, mediumType: 'SSD', busType: 'NVMe'
  }
}
const HEALTH: HealthReport = {
  dbIntegrity: { ok: true, details: 'ok' },
  orphanMessages: 0,
  orphanChunks: 0,
  kbCount: 1,
  totalMessages: 12,
  totalConversations: 3,
  totalAttachmentsBytes: 0
}
const RECOMMEND: ModelRecommendation = {
  tier: 'entry',
  summary: 'cpu_high',
  summaryParams: {},
  localPicks: [],
  onlineHint: 'low_end',
  ollamaRunning: true,
  installedModels: [],
  warnings: []
}

type Impl = (...a: unknown[]) => unknown
/** 三发默认给"读到"，各用例只改自己那一发 */
const stewardStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  getHardwareInfo: () => ({ ok: true, data: HW }),
  checkIntegrity: () => ({ ok: true, data: { ok: true, details: 'ok' } }),
  getHealthReport: () => ({ ok: true, data: HEALTH }),
  recommendModels: () => ({ ok: true, data: RECOMMEND }),
  getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
  onOllamaPullEvent: () => () => {},
  ...over
})

describe('① 管家页：信封化之后，读不到的那一块说的是「读不到」', () => {
  it('三发都回 {ok:false} ⇒ 三块各摆自己的原因，且屏上不许有一个 undefined', async () => {
    stubPocketai(stewardStubs({
      getHardwareInfo: () => ({ ok: false, error: 'HW_PROBE:探测超时' }),
      checkIntegrity: () => ({ ok: false, error: 'DB_BUSY:库被占用' }),
      getHealthReport: () => ({ ok: false, error: 'HEALTH:读不到' })
    }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(alerts()).toEqual([
      FAILED('DB_BUSY:库被占用'),
      FAILED('HW_PROBE:探测超时'),
      FAILED('HEALTH:读不到')
    ]))
    // 三条负向：这三条就是改动前屏上的原话
    expect(bodyText()).not.toContain('undefined')
    expect(bodyText()).not.toContain('❌ undefined')
    expect(bodyText()).not.toContain('✅ 0')
  })

  it('反向对照：三发都读到 ⇒ 一句"读不到"都不许有，屏上是真值', async () => {
    stubPocketai(stewardStubs())
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('integrity_check')).not.toBeNull())
    expect(alerts()).toEqual([])
    // 这几串是 Row 实际渲染出来的值（逐字回读，不按实现猜）
    expect(bodyText()).toContain('win32 10.0')
    expect(bodyText()).toContain('16.0 GB')
    expect(bodyText()).toContain('✅ ok')
    expect(bodyText()).toContain('总会话数3')
  })

  it('库真的不完整（读到了、结论是坏）⇒ 说「❌ 原文」，不换脸成「读不到」', async () => {
    stubPocketai(stewardStubs({
      checkIntegrity: () => ({ ok: true, data: { ok: false, details: 'integrity_check failed: 3 messages' } })
    }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(bodyText()).toContain('❌ integrity_check failed: 3 messages'))
    expect(alerts()).toEqual([])
  })

  it('后来到货 ⇒ 那句「读不到」必须自己收回（不留陈旧谎报）', async () => {
    let hwOk = false
    stubPocketai(stewardStubs({
      // 桩读闭包里的开关：点「重新检测」时只让硬件那一发改成读到的
      getHardwareInfo: () => (hwOk ? { ok: true, data: HW } : { ok: false, error: 'HW_PROBE:探测超时' }),
      checkIntegrity: () => ({ ok: false, error: 'DB_BUSY:库被占用' }),
      getHealthReport: () => ({ ok: false, error: 'HEALTH:读不到' })
    }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(alerts()).toContain(FAILED('HW_PROBE:探测超时')))
    hwOk = true
    fireEvent.click(screen.getByText(L('steward.recheck')))
    await waitFor(() => expect(alerts()).not.toContain(FAILED('HW_PROBE:探测超时')))
    // 收回不是删掉就完事：那一块得真的换上快照
    await waitFor(() => expect(bodyText()).toContain('win32 10.0'))
    // 另两块没重试，那句必须还挂着（不许被一次成功的全清）
    expect(alerts()).toContain(FAILED('DB_BUSY:库被占用'))
    expect(alerts()).toContain(FAILED('HEALTH:读不到'))
  })

  it('reject 面（通道真抛错＝Promise 被拒）⇒ 同一张脸，原因是抛出来的原文', async () => {
    stubPocketai(stewardStubs({
      // 真 IPC 不会同步抛（invoke 返回的是 Promise），所以这里也给它一个 rejected Promise
      getHardwareInfo: () => Promise.reject(new Error('HW 通道炸了'))
    }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(alerts()).toContain(FAILED('HW 通道炸了')))
  })

  it('读到但没带数据（{ok:true}）⇒ 也算读不到，不许演成"这台机器不该有"', async () => {
    stubPocketai(stewardStubs({ getHardwareInfo: () => ({ ok: true }) }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(alerts()).toContain(FAILED(L('common.unknownError'))))
    expect(bodyText()).not.toContain('undefined')
  })
})

describe('② setUiPrefs 那两发写：面板常驻一句，写成功即收回', () => {
  const CONV = { id: 'c1', assistantId: 'a1', title: '会话', modelLabel: null } as unknown as ConversationRecord
  const PROVIDERS = [
    { id: 'p1', name: 'P', type: 'openai-compatible', enabled: true, models: ['m1'] }
  ] as unknown as ProviderRecord[]
  const ASSISTANTS = [
    { id: 'a1', name: 'a1', isBuiltin: false, isPinned: false },
    { id: 'a2', name: 'a2', isBuiltin: false, isPinned: false }
  ] as unknown as AssistantRecord[]

  type ChatImpl = (...a: any[]) => unknown
  const chatStubs = (over: Record<string, ChatImpl> = {}): Record<string, ChatImpl> => ({
    listProviders: () => [{ id: 'p1', name: 'P', type: 'openai-compatible', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[],
    listAssistants: () => ASSISTANTS,
    getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: () => [CONV],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    getConversation: () => null,
    listChildConversations: () => [],
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({}),
    getWebSearchConfig: () => ({}),
    getCalendarConfig: () => ({}),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {},
    ...over
  })

  const mountChat = () =>
    renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })

  it('写回失败（{ok:false}）⇒ hook 上那句带的是通道原文', async () => {
    stubPocketai(chatStubs({ setUiPrefs: () => ({ ok: false, error: 'PREF_BUSY:设置库被占用' }) }))
    const { result } = mountChat()
    await waitFor(() => expect(result.current.uiPrefsUnread).toBe('PREF_BUSY:设置库被占用'))
  })

  it('反向对照：写成功 ⇒ 那句是 null，一次都不许出现', async () => {
    stubPocketai(chatStubs())
    const { result } = mountChat()
    await waitFor(() => expect(result.current.assistantId).toBe('a1'))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(result.current.uiPrefsUnread).toBeNull()
  })

  it('当场换成另一个助手且这次写进去了 ⇒ 那句收回（不带着旧失败往下走）', async () => {
    let failing = true
    stubPocketai(chatStubs({
      setUiPrefs: (patch: Record<string, unknown>) =>
        failing ? { ok: false, error: 'PREF_BUSY:设置库被占用' } : { ok: true, data: patch }
    }))
    const { result } = mountChat()
    await waitFor(() => expect(result.current.uiPrefsUnread).toBe('PREF_BUSY:设置库被占用'))
    failing = false
    await act(async () => { result.current.setAssistantId('a2') })
    await waitFor(() => expect(result.current.uiPrefsUnread).toBeNull())
  })

  it('reject 面（Promise 被拒）⇒ 同一句，用的是抛出来的原文', async () => {
    stubPocketai(chatStubs({ setUiPrefs: () => Promise.reject(new Error('写偏好炸了')) }))
    const { result } = mountChat()
    await waitFor(() => expect(result.current.uiPrefsUnread).toBe('写偏好炸了'))
  })
})

describe('③ 接线计数：旧形状归零，新形状数得出', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n')
  const STEWARD = read('src/renderer/src/modules/steward/StewardModule.tsx')
  const WIZARD = read('src/renderer/src/modules/wizard/FirstRunWizard.tsx')
  const CHAT = read('src/renderer/src/modules/agent/hooks/useAgentChat.ts')
  const PANEL = read('src/renderer/src/modules/agent/chat/AgentPanel.tsx')
  const MAIN_SYS = read('src/main/ipc/handlers/system.ts')
  const MAIN_STEWARD = read('src/main/ipc/handlers/steward.ts')
  const PRELOAD = read('src/preload/index.ts')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('main 侧三发都包了信封，preload 三条签名都带 data', () => {
    expect(count(MAIN_SYS, /ok: true as const,\s*data: force \? refreshHardwareInfo\(\) : getHardwareInfo\(\)/g), '硬件画像包了信封').toBe(1)
    expect(count(MAIN_SYS, /ok: true as const, data: dbService\.integrityCheck\(\)/g), '完整性结论挪进 data').toBe(1)
    expect(count(MAIN_STEWARD, /ok: true as const, data: healthService\.report\(\)/g)).toBe(1)
    expect(count(PRELOAD, /data\?: HardwareInfo/g), 'preload 不再谎报裸值').toBe(1)
    expect(count(PRELOAD, /data\?: \{ ok: boolean; details: string \}/g)).toBe(1)
    expect(count(PRELOAD, /data\?: HealthReport/g)).toBe(1)
  })

  it('管家页：三处「判真值就当数据用」归零，成功支都从 data 取、失败支都留原因', () => {
    expect(count(STEWARD, /if \(hw\) setHardware|if \(integ\) setIntegrity|if \(healthReport\) setHealth/g), '旧形状必须一条不剩').toBe(0)
    expect(count(STEWARD, /setHardware\(hw\.data\)/g)).toBe(1)
    expect(count(STEWARD, /setIntegrity\(integ\.data\)/g)).toBe(1)
    expect(count(STEWARD, /setHealth\(healthReport\.data\)/g)).toBe(1)
    expect(count(STEWARD, /setHwFail\(ipcFailText\(hw, unknown\)\)/g)).toBe(1)
    expect(count(STEWARD, /setIntegFail\(ipcFailText\(integ, unknown\)\)/g)).toBe(1)
    expect(count(STEWARD, /setHealthFail\(ipcFailText\(healthReport, unknown\)\)/g)).toBe(1)
    // 顺带清理那两发也要走 data（不然又把旧快照当刚刷新的）
    expect(count(STEWARD, /setHealth\(report\.data\)/g), '清理后／VACUUM 后那两发').toBe(2)
  })

  it('向导：那句"失败只 return"的空子改成了留原因', () => {
    expect(count(WIZARD, /if \(hasIpcFailed\(hw\)\) return/g), '空子必须归零').toBe(0)
    expect(count(WIZARD, /setHwFail\(hw\)/g)).toBe(1)
    expect(count(WIZARD, /hwFail \? \(/g), '失败档排在读到与"加载中…"之间').toBe(1)
    expect(count(WIZARD, /msg=\{ipcFailText\(hwFail, t\('common\.unknownError'\)\)\}/g), '那句带的是通道原文').toBe(1)
  })

  it('面板：那句常驻挂在模型栏与工具栏之间，键走字典', () => {
    expect(count(PANEL, /chat\.uiPrefsUnread && \(/g)).toBe(1)
    expect(count(PANEL, /t\('agent\.prefsNotSaved', \{ msg: chat\.uiPrefsUnread \}\)/g)).toBe(1)
  })

  it('hook：两发写各有 resolve／reject 两面，且不再只进 console', () => {
    expect(count(CHAT, /setUiPrefsUnread\(ipcFailText\(r, t\('common\.unknownError'\)\)\)/g)).toBe(2)
    expect(count(CHAT, /setUiPrefsUnread\(errText\(e, t\('common\.unknownError'\)\)\)/g), 'reject 面').toBe(2)
    expect(count(CHAT, /setUiPrefsUnread\(null\)/g), '写成功即收回').toBe(2)
    expect(count(CHAT, /reportIpcError\('agent\.setUiPrefs'\)/g), '那条只进 console 的兜底已经换掉').toBe(0)
  })
})
