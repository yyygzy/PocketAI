// V4-Iter-264：第五面第二簇——「判了、也只 return」的那六处，屏上留下的初值现在各有一句说法。
//
// §263 立闸时逐条回读点名的六条（登记表里写的是"待收"）：
//  · `UnlockPage` 的 `getAuthLockState`——读不到⇒`lockedUntil` 停在 0，主按钮写着「进入应用」＝替这次失败
//    报了"没锁"。§219 的注释自己就写着「『不阻断』不等于谎报没锁」，这是全名单里最该收的一条（安全面）。
//  · `useAgentChat` 的 `getLatestRunStats`／`getSessionStats`／运行后刷新那一发——读不到⇒「本次运行统计」
//    那块**整块不出现**，累计那行落到「分步明细」四个字。不摆 0（所以不是假数字），但也没说为什么没有。
//  · `ChatModule` 的 `getConversationDraft`——读不到⇒输入框是空的＝"这条没存过草稿"，而库里可能还有（📝 那行的凭据）。
//  · `FirstRunWizard` 的 `listAssistants`——读不到⇒那一格摆的是「加载中…」＝把没读到谎称成还在读（§222 同一条）。
//
// 收口的两条口径：① 不阻断照旧（解锁页仍能提交，主进程会拦），但**要说**，并按 §259 把降级说出来
//   （「下面按钮按未锁定显示」）——只说"读不到"不够，用户会以为按钮的措辞是可信的；
// ② 每一处都配一次重试（§257 那颗 `agent.retryRead` 的形状：这一发本来就能重拉，"读不到没有重试路径"
//   这句从本批起对这几处不再成立）。读到即收回（§256 陈旧谎报）。
//
// `ChatModule` 那一处**没有行为用例**（全仓不挂载 ChatModule，§250 起如此）——它的判据在闸门里是源码级，
// 这里不假装测过；其余四处都是真挂载。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { UnlockPage } from '../src/renderer/src/modules/unlock/UnlockPage'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ConversationRecord, MessageRecord, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string => L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''

beforeEach(() => localStorage.clear())

// ───────── ① 解锁页：锁状态那一读 ─────────

const LOCK_SENTENCE = (msg: string): string =>
  L('unlock.lockStateUnread').replace('{msg}', msg)

const mountUnlock = (lockImpl: () => unknown): void => {
  stubPocketai({
    getAuthLockState: lockImpl,
    unlockEncryption: () => ({ ok: false, error: '主密码不正确' }),
    setMasterPassword: () => ({ ok: true }),
    recoverWithCode: () => ({ ok: true }),
    saveRecoveryFile: () => ({ ok: true }),
    copySensitiveToClipboard: () => ({ ok: true })
  })
  mountWithProviders(<UnlockPage />)
}

describe('① 解锁页：读不到锁状态不许等于"现在可以试"', () => {
  it('回 {ok:false} ⇒ 那句带降级说明常驻，但提交按钮仍可点（不阻断这条没改）', async () => {
    mountUnlock(() => ({ ok: false, error: 'LOCK:锁定状态读不到' }))
    await waitFor(() => expect(bodyText()).toContain(LOCK_SENTENCE('LOCK:锁定状态读不到')))
    expect(alerts()).toHaveLength(1)
    expect(bodyText()).toContain('未锁定')
    // 不阻断＝按钮还是那句「进入应用」，没有变成禁用（那会是一个新的谎：假装知道没锁？）
    expect((screen.getByText(L('unlock.btn')) as HTMLButtonElement).disabled).toBe(false)
  })

  it('点「重试」读到 ⇒ 那句必须退场（陈旧谎报不能留着）', async () => {
    let fail = true
    mountUnlock(() => (fail ? { ok: false, error: 'LOCK:锁定状态读不到' } : { unlock: { retryAfterMs: 0 }, recover: { retryAfterMs: 0 } }))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    fail = false
    fireEvent.click(screen.getByText(L('agent.retryRead')))
    await waitFor(() => expect(alerts()).toEqual([]))
  })

  it('reject 面 ⇒ 同一句用抛出的原文（旧写法是空 catch：连一句"没读到"都没有）', async () => {
    mountUnlock(() => Promise.reject(new Error('锁定状态通道炸了')))
    await waitFor(() => expect(bodyText()).toContain(LOCK_SENTENCE('锁定状态通道炸了')))
  })

  it('反向对照：读到"确实锁着" ⇒ 倒计时照常，零 alert（不把读成功说成读不到）', async () => {
    mountUnlock(() => ({ unlock: { retryAfterMs: 3000 }, recover: { retryAfterMs: 0 } }))
    await waitFor(() => expect(bodyText()).toContain(L('unlock.tooManyAttempts').replace('{s}', '3')))
    expect(alerts()).toEqual([])
  })
})

// ───────── ② Agent 页：那两发统计 ─────────

const glm: ProviderRecord = {
  id: 'glm', type: 'openai-compatible', name: 'GLM', baseUrl: 'https://api.example.invalid/v1',
  apiKeys: [], models: ['glm-4.6'], enabled: true, createdAt: 1
}
const PARENT: ConversationRecord = {
  id: 'c1', assistantId: 'a1', title: 'PROBE-会话', createdAt: 1, updatedAt: 1
} as unknown as ConversationRecord

const RUN_SENTENCE = (msg: string): string => NAMED(L('agent.runStatsBlock'), msg)
const SESSION_SENTENCE = (msg: string): string => NAMED(L('agent.sessionStatsBlock'), msg)

const agentStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [glm],
  listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
  getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
  setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
  listConversations: (_a: string, _agent: boolean, archivedOnly?: boolean) => (archivedOnly ? [] : [PARENT]),
  listMessages: (id: string) => [
    { id: `m-${id}`, conversationId: id, role: 'user', content: '跑一趟', createdAt: 1 }
  ] as MessageRecord[],
  getLatestRunStats: () => ({ stepCount: 2, totalDurationMs: 1200, totalTokens: 900 }),
  getSessionStats: () => ({ runCount: 1, totalDurationMs: 1200, totalTokens: 900 }),
  getLatestRunTraces: () => [],
  getAgentTextProtocol: () => [],
  getModelContextWindows: () => ({}),
  getFallbackTargets: () => ({}),
  setFallbackTarget: () => ({ targets: {} }),
  getConversation: (id: string) => (id === 'c1' ? PARENT : null),
  listChildConversations: () => [],
  getAgentWorkspaceDir: () => '',
  getShellConfig: () => ({}),
  getWebSearchConfig: () => ({}),
  getCalendarConfig: () => ({}),
  fetchModels: () => ({ ok: true }),
  sendMessage: () => ({ ok: true }),
  abortAgent: () => ({ ok: true }),
  onAgentStep: () => () => {},
  onAgentChunk: () => () => {},
  onAgentDone: () => () => {},
  onAgentError: () => () => {},
  onConversationTitle: () => () => {},
  ...over
})

describe('② Agent 页那两发统计：那块不出现时，句子顶上去（并给一次重试）', () => {
  it('两发都挂 ⇒ 两句各点各的名，屏上仍有内容（这块整块消失不等于"这轮没跑"）', async () => {
    stubPocketai(agentStubs({
      getLatestRunStats: () => ({ ok: false, error: 'STATS_RUN:运行统计读不到' }),
      getSessionStats: () => ({ ok: false, error: 'STATS_SESS:累计统计读不到' })
    }))
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(bodyText()).toContain(RUN_SENTENCE('STATS_RUN:运行统计读不到')))
    expect(bodyText()).toContain(SESSION_SENTENCE('STATS_SESS:累计统计读不到'))
    expect(alerts()).toHaveLength(2)
    // 那一块本来长什么样不许被"读不到"冒充：整块不出现（明细入口也没了），顶上来的只有那两句
    expect(screen.queryByTitle(L('agent.runStatsDetail'))).toBeNull()
    expect(bodyText().length).toBeGreaterThan(0)
  })

  it('只累计那发挂 ⇒ 本次那块照常出现、只有它那一句冒（逐发点名：一发挂不许把另一发说成不可信）', async () => {
    stubPocketai(agentStubs({
      getSessionStats: () => ({ ok: false, error: 'STATS_SESS:累计统计读不到' })
    }))
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(bodyText()).toContain(SESSION_SENTENCE('STATS_SESS:累计统计读不到')))
    expect(screen.getByTitle(L('agent.runStatsDetail'))).toBeTruthy()
    expect(bodyText()).not.toContain(RUN_SENTENCE('STATS_RUN'))
    expect(alerts()).toHaveLength(1)
  })

  it('reject 面（通道真抛，不是 `{ok:false}`）⇒ 两句同形，用抛出的原文（旧写法是 `.catch(reportIpcError(...))`＝只进 console）', async () => {
    stubPocketai(agentStubs({
      getLatestRunStats: () => Promise.reject(new Error('运行统计通道炸了')),
      getSessionStats: () => Promise.reject(new Error('累计统计通道炸了'))
    }))
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(bodyText()).toContain(RUN_SENTENCE('运行统计通道炸了')))
    expect(bodyText()).toContain(SESSION_SENTENCE('累计统计通道炸了'))
  })

  it('点「重试」读到 ⇒ 那句退场、那块统计回来', async () => {
    let fail = true
    stubPocketai(agentStubs({
      getLatestRunStats: () => (fail
        ? { ok: false, error: 'STATS_RUN:运行统计读不到' }
        : { stepCount: 3, totalDurationMs: 2400, totalTokens: 1200 })
    }))
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(bodyText()).toContain(RUN_SENTENCE('STATS_RUN:运行统计读不到')))
    fail = false
    fireEvent.click(screen.getByTestId('run-stats-retry'))
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.getByTitle(L('agent.runStatsDetail'))).toBeTruthy()
  })

  it('反向对照：两发都读到 ⇒ 零"读不到"，那块照常出现', async () => {
    stubPocketai(agentStubs())
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(screen.getByTitle(L('agent.runStatsDetail'))).toBeTruthy(), { timeout: 8000, interval: 50 })
    expect(bodyText()).not.toContain('读不到')
    expect(alerts()).toEqual([])
  })
})

// ───────── ③ 首启向导：助手清单那一读 ─────────

const wizardHardware = {
  os: { platform: 'win32', release: '10.0' },
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}

const mountWizard = (over: Record<string, (...a: any[]) => unknown>): void => {
  stubPocketai({
    getHardwareInfo: () => ({ ok: true, data: wizardHardware }),
    getEncryptionStatus: () => ({
      mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: null, kdfAtCurrentTier: true
    }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [{
      id: 'p-ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1',
      apiKeys: [], models: ['m-a'], enabled: true, createdAt: 1
    }],
    listAssistants: () => [{ id: 'a-builtin', name: 'PROBE-内置助手', isBuiltin: true, toolPermissions: [], defaultProviderId: null }],
    listSkills: () => [],
    getOllamaStatus: () => ({ installed: false, running: false, models: [], version: '' }),
    getOllamaMirror: () => ({ mirror: '' }),
    probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: null }),
    onOllamaPullEvent: () => () => {},
    onOllamaInstallEvent: () => () => {},
    ...over
  })
  mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
}

/**
 * 助手清单在**第 2 步**，而第 2 步要先选中一家 provider 才现身（第 1 次「下一步」是加密页，
 * 第 2 次才进快速配置）⇒ 三步都得走，不能假装那一格在场。probe 实测过这条路。
 */
async function toAssistantStep(): Promise<void> {
  fireEvent.click(await screen.findByText(L('wizard.next')))
  fireEvent.click(screen.getByText(L('wizard.next')))
  fireEvent.click(screen.getAllByText(/Ollama/)[0]!)
  await waitFor(() => expect(screen.queryByText(L('wizard.assistantLabel'))).toBeTruthy())
}

describe('③ 向导 Step 1 的助手清单：读不到不许停在「加载中…」', () => {
  it('回 {ok:false} ⇒ 那句顶掉「加载中…」，旁边一颗重试', async () => {
    mountWizard({ listAssistants: () => ({ ok: false, error: 'ASST:助手读不到' }) })
    await toAssistantStep()
    await waitFor(() => expect(bodyText()).toContain(NAMED(L('common.assistantsList'), 'ASST:助手读不到')))
    expect(alerts()).toHaveLength(1)
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })

  it('点「重试」读到 ⇒ 那句退场、清单回来（替用户挑内置助手这一步也照做）', async () => {
    let fail = true
    mountWizard({
      listAssistants: () => (fail
        ? { ok: false, error: 'ASST:助手读不到' }
        : [{ id: 'a-builtin', name: 'PROBE-内置助手', isBuiltin: true, toolPermissions: [], defaultProviderId: null }])
    })
    await toAssistantStep()
    await waitFor(() => expect(bodyText()).toContain(NAMED(L('common.assistantsList'), 'ASST:助手读不到')))
    fail = false
    fireEvent.click(screen.getByText(L('agent.retryRead')))
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(bodyText()).toContain('PROBE-内置助手')
  })

  it('反向对照：读到 ⇒ 零 alert，「加载中…」也不许多留（清单直接摆出来）', async () => {
    mountWizard({})
    await toAssistantStep()
    await waitFor(() => expect(bodyText()).toContain('PROBE-内置助手'))
    expect(alerts()).toEqual([])
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })
})
