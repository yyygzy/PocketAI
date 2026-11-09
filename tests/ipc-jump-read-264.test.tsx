// V4-Iter-264：第五面第二簇——「判了、也只 return」的那几处，屏上留下的初值现在各有一句说法。
//
// §263 立闸时逐条回读点名的几条（登记表里写的是"待收"）：
//  · `UnlockPage` 的 `getAuthLockState`——读不到⇒`lockedUntil` 停在 0，主按钮写着「进入应用」＝替这次失败
//    报了"没锁"。§219 的注释自己就写着「『不阻断』不等于谎报没锁」，这是全名单里最该收的一条（安全面）。
//  · `ChatModule` 的 `getConversationDraft`——读不到⇒输入框是空的＝"这条没存过草稿"，而库里可能还有（📝 那行的凭据）。
//  · `FirstRunWizard` 的 `listAssistants`——读不到⇒那一格摆的是「加载中…」＝把没读到谎称成还在读（§222 同一条）。
//
// 收口的两条口径：① 不阻断照旧（解锁页仍能提交，主进程会拦），但**要说**，并按 §259 把降级说出来
//   （「下面按钮按未锁定显示」）——只说"读不到"不够，用户会以为按钮的措辞是可信的；
// ② 每一处都配一次重试（§257 那颗 `agent.retryRead` 的形状：这一发本来就能重拉，"读不到没有重试路径"
//   这句从本批起对这几处不再成立）。读到即收回（§256 陈旧谎报）。
//
// `ChatModule` 那一处**没有行为用例**（全仓不挂载 ChatModule，§250 起如此）——它的判据在闸门里是源码级，
// 这里不假装测过；其余两处都是真挂载。Agent 页那两发统计随 P4 批次 2 删壳退场。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { UnlockPage } from '../src/renderer/src/modules/unlock/UnlockPage'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { zh } from '../src/renderer/src/i18n/zh'

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

// ───────── ② 首启向导：助手清单那一读 ─────────

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
      masterPasswordVerified: false, kdfN: null, kdfAtCurrentTier: false
    }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [{
      id: 'p-ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1',
      apiKeys: [], models: ['m-a'], enabled: true, createdAt: 1
    }],
    listAssistants: () => [{ id: 'a-builtin', name: 'PROBE-内置助手', isBuiltin: true, toolPermissions: [], defaultProviderId: null }],
    listSkills: () => [],
    getOllamaStatus: () => ({ installed: false, liveness: 'down', models: [], version: '' }),
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

describe('② 向导 Step 1 的助手清单：读不到不许停在「加载中…」', () => {
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
