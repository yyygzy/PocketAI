// V4-Iter-257：Agent 那两个 hook 上的六处「判了不接管」——四发工具配置读 ＋ 文本协议清单 ＋ 分步明细读。
//
// 这一簇的谎法只有一种，但落点六个：**读失败 ⇒ 屏上摆的是各自的默认字面量**，看着就像读数。
//  · `workspaceDir` 空串 ⇒ 📁 那颗写「未设置」（还顺手把终端命令整块置灰，悬停教用户"你先没选目录"）；
//  · 三个开关的默认值全是 `enabled:false` ⇒ 三条都显示"关着"，而真实库里可能开着；
//  · `textProtocolModels` 空 ⇒ 徽标写「文本协议」（＝没走），而 §221 早就注明这条通道失败也回 `{ok:false}`；
//  · `latestTraces` 保持 null ⇒ 屏上是「暂无分步明细」。
// 收口形状抄的是本仓既有那两张脸：徽标第三态＝§234 那颗窗口徽标；开关那一族＝§226 的
// `ShowingDefaultsNotice`（**必须点名是哪一发**，因为一个面板里可能只有部分数据来自失败的那一发）。
// 两条"陈旧谎报"用例是 §256 的课：当场读到／当场改成功之后，那句"读不到"必须自己收回。
//
// 桩按 preload 的真实签名（`src/preload/index.ts:729/733/739/746/757/763`：这几发成功回**裸值**，
// 失败才是 safeHandle 的 `{ok:false}` 信封），配置对象一律按类型写死，缺字段编译期就红。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { useAgentToolConfigs } from '../src/renderer/src/modules/agent/hooks/useAgentToolConfigs'
import { AgentToolBars } from '../src/renderer/src/modules/agent/components/AgentToolBars'
import { AgentModelBar } from '../src/renderer/src/modules/agent/components/AgentModelBar'
import { zh } from '../src/renderer/src/i18n/zh'
import type { CalendarConfig, ProviderRecord, ShellConfig, WebSearchConfig } from '../src/shared/types'
import type { AssistantRecord, ConversationRecord } from '../src/shared/types'

const T = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const defaultsLine = (what: string, msg: string): string =>
  T('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)

const SHELL_ON: ShellConfig = { enabled: true, policy: 'auto-safe' }
const WS_ON: WebSearchConfig = { enabled: true, provider: 'tavily', apiKey: '', hasKey: true }
const CAL_ON: CalendarConfig = { enabled: true, paths: ['C:/cal.ics'] }

const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-P', baseUrl: 'https://example.invalid/v1',
  apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as ProviderRecord

/** 真 hook ＋ 真组件：这一屏要证的正是"读失败时界面上摆的到底是什么" */
const Harness = (): JSX.Element => {
  const tools = useAgentToolConfigs()
  return <AgentToolBars tools={tools} />
}

/** 工具配置默认是收起的：收起态只有那三条「读不到」，控件要点了 ▸ 才出现 */
const expandBars = (): void => {
  const toggle = document.querySelector('button')
  if (!toggle) throw new Error('AgentToolBars 没渲染出展开按钮')
  fireEvent.click(toggle)
}

const READ_FAILS = (over: Record<string, (...a: unknown[]) => unknown> = {}): Record<string, (...a: unknown[]) => unknown> => ({
  getAgentWorkspaceDir: () => ({ ok: false, error: 'WS_DIR:读不到' }),
  getShellConfig: () => ({ ok: false, error: 'SHELL:读不到' }),
  getWebSearchConfig: () => ({ ok: false, error: 'WS:读不到' }),
  getCalendarConfig: () => ({ ok: false, error: 'CAL:读不到' }),
  ...over
})

/**
 * ⓪ 真挂 useAgentChat 的那两发读（文本协议清单 / 分步明细）。
 * 上面②那组断的是徽标拿到原因之后怎么说；这一组断的是**原因真从通道走到 hook 的 state**，
 * 否则把 props 写死也能让②全绿（§215 同一分工）。
 */
const CHAT_PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai-compatible', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const CHAT_ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
const CONV = { id: 'c1', assistantId: 'a1', title: '会话', modelLabel: null } as unknown as ConversationRecord

type Impl = (...a: any[]) => unknown
const chatStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
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
  sendMessage: () => ({ ok: true }),
  abortAgent: () => ({ ok: true }),
  onAgentStep: () => () => {},
  onAgentChunk: () => () => {},
  onAgentDone: () => () => {},
  onAgentError: () => () => {},
  onConversationTitle: () => () => {},
  ...over
})

async function mountChat(over: Record<string, Impl> = {}) {
  stubPocketai(chatStubs(over))
  const { result } = renderHook(() => useAgentChat(CHAT_PROVIDERS, CHAT_ASSISTANTS), { wrapper: HookProviders })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return result
}

describe('⓪ 真挂 useAgentChat：这两发读的失败面真从通道走到 state', () => {
  it('文本协议清单回 {ok:false} ⇒ textProtocolUnread 是那句原因，且没被演成空清单之外的任何东西', async () => {
    const result = await mountChat({ getAgentTextProtocol: () => ({ ok: false, error: 'TP:清单取不到' }) })
    await waitFor(() => expect(result.current.textProtocolUnread).toBe('TP:清单取不到'))
    expect(result.current.textProtocolForced).toBe(false)
  })

  it('反向对照：读到清单里点名了当前这台 ⇒ unread 为空、徽标该是"已启用"那个值', async () => {
    const result = await mountChat({ getAgentTextProtocol: () => ['p1::m1'] })
    await act(async () => {
      result.current.changeProvider('p1')
      result.current.setModel('m1')
    })
    await waitFor(() => expect(result.current.textProtocolForced).toBe(true))
    expect(result.current.textProtocolUnread, '读到就是读到了，不许留着上一句"取不到"').toBeNull()
  })

  it('挂载时取不到、但用户当场点开关写成功 ⇒ 那句「取不到」作废且徽标按新值走（不靠接线计数钉）', async () => {
    const result = await mountChat({
      getAgentTextProtocol: () => ({ ok: false, error: 'TP:清单取不到' }),
      setAgentTextProtocol: () => ['p1::m1']
    })
    await waitFor(() => expect(result.current.textProtocolUnread).toBe('TP:清单取不到'))
    await act(async () => {
      result.current.changeProvider('p1')
      result.current.setModel('m1')
    })
    await act(async () => {
      await result.current.setTextProtocol(true)
    })
    expect(result.current.textProtocolUnread, 'set 通道回传的就是最新清单，那句"取不到"到此作废').toBeNull()
    expect(result.current.textProtocolForced).toBe(true)
  })

  it('分步明细回 {ok:false} ⇒ latestTracesUnread 给原因、traces 仍是没有；重试读到之后那句收回', async () => {
    let n = 0
    const result = await mountChat({
      getLatestRunTraces: () => {
        n += 1
        return n === 1 ? { ok: false, error: 'TRACE:库被占用' } : []
      }
    })
    await act(async () => {
      result.current.loadLatestTraces()
    })
    await waitFor(() => expect(result.current.latestTracesUnread).toBe('TRACE:库被占用'))
    expect(result.current.latestTraces).toBeNull()
    await act(async () => {
      result.current.loadLatestTraces()
    })
    await waitFor(() => expect(result.current.latestTracesUnread).toBeNull())
    expect(result.current.latestTraces).toEqual([])
    expect(n).toBeGreaterThanOrEqual(2)
  })
})

describe('① 四发工具配置读：读不到要点名说，且不许藏在收起态后面', () => {
  it('shell／联网搜索／日历三发都读不到 ⇒ 三条「{名字}读不到：原因（当前显示的是默认值）」逐字在场', async () => {
    stubPocketai(READ_FAILS())
    mountWithProviders(<Harness />)
    await waitFor(() => expect(screen.getByText(defaultsLine(T('agent.shell.enable'), 'SHELL:读不到'))).toBeTruthy())
    expect(screen.getByText(defaultsLine(T('agent.websearch.title'), 'WS:读不到'))).toBeTruthy()
    expect(screen.getByText(defaultsLine(T('agent.calendar.title'), 'CAL:读不到'))).toBeTruthy()
  })

  it('reject 面（真抛错）也算读到过失败：三条里日历那一句用的是 Error 的原文', async () => {
    stubPocketai(READ_FAILS({ getCalendarConfig: () => Promise.reject(new Error('CAL_REJECT:通道炸了')) }))
    mountWithProviders(<Harness />)
    await waitFor(() => expect(screen.getByText(defaultsLine(T('agent.calendar.title'), 'CAL_REJECT:通道炸了'))).toBeTruthy())
  })

  it('反向对照：四发都读到 ⇒ 一句「读不到」都不许有，而屏上摆的是库里那份（终端是开的）', async () => {
    stubPocketai({
      getAgentWorkspaceDir: () => 'C:/workspace',
      getShellConfig: () => SHELL_ON,
      getWebSearchConfig: () => WS_ON,
      getCalendarConfig: () => CAL_ON,
      setWebSearchConfig: () => WS_ON
    })
    mountWithProviders(<Harness />)
    expandBars()
    await waitFor(() => expect(screen.getByText(T('agent.shell.hintOn'))).toBeTruthy())
    expect(screen.queryByText(/读不到/)).toBeNull()
  })

  it('那句「读不到」在**收起态**也在场（§235 的口径：藏在折叠后面等于没说）', async () => {
    stubPocketai(READ_FAILS())
    mountWithProviders(<Harness />)
    // 一次都不点展开
    await waitFor(() => expect(screen.getByText(defaultsLine(T('agent.shell.enable'), 'SHELL:读不到'))).toBeTruthy())
    expect(screen.queryByText(T('agent.shell.hintOn'))).toBeNull()
  })

  it('当场把联网搜索打开且写成功 ⇒ 那句「读不到」必须自己收回（它已经不再是"没读到"）', async () => {
    stubPocketai(READ_FAILS({ setWebSearchConfig: () => WS_ON }))
    mountWithProviders(<Harness />)
    await waitFor(() => expect(screen.getByText(defaultsLine(T('agent.websearch.title'), 'WS:读不到'))).toBeTruthy())
    expandBars()
    // 第二颗 checkbox＝联网搜索那一行（第一颗是终端命令）；点 label 文本在 jsdom 里不可靠，直接点控件
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    await waitFor(() => expect(screen.queryByText(defaultsLine(T('agent.websearch.title'), 'WS:读不到'))).toBeNull())
  })
})

describe('② AgentModelBar 两颗徽标的第三态', () => {
  const bar = (over: Record<string, unknown> = {}): void => {
    stubPocketai({ setUiPrefs: () => ({ ok: true }) })
    mountWithProviders(
      <AgentModelBar
        providers={[PROVIDER]}
        providerId="p1"
        model="m1"
        onProviderChange={() => {}}
        onModelChange={() => {}}
        selectedProvider={PROVIDER}
        fetchingModels={false}
        onFetchModels={() => {}}
        workspaceDir=""
        onPickWorkspace={vi.fn()}
        onToggleTextProtocol={() => {}}
        {...over}
      />
    )
  }

  it('工作目录读不到 ⇒ 📁 那颗写「工作目录取不到」，不写「未设置」；悬停带着原因', async () => {
    bar({ workspaceUnread: 'WS_DIR:读不到' })
    const chip = await screen.findByText(/工作目录取不到/)
    expect(chip.textContent).toContain('📁')
    expect(screen.queryByText(T('agent.workspaceNone'))).toBeNull()
    expect(chip.closest('button')?.getAttribute('title')).toContain('WS_DIR:读不到')
  })

  it('反向对照：读到空串才是「未设置」（两件事两种脸）', async () => {
    bar()
    await screen.findByText(/未设置/)
    expect(screen.queryByText(T('agent.workspaceReadFail'))).toBeNull()
  })

  it('文本协议清单读不到 ⇒ 徽标第三态，既不是「文本协议」也不是「文本协议已启用」', async () => {
    bar({ textProtocolUnread: 'TP:清单取不到' })
    const badge = await screen.findByText(T('agent.textProtocolReadFail'))
    expect(badge.getAttribute('title')).toContain('TP:清单取不到')
    expect(screen.queryByText(T('agent.textProtocol'))).toBeNull()
    expect(screen.queryByText(T('agent.textProtocolOn'))).toBeNull()
  })

  it('反向对照：读到清单里点名了这台 ⇒ 徽标是「文本协议已启用」；没点名 ⇒「文本协议」', async () => {
    bar({ textProtocolForced: true })
    await screen.findByText(T('agent.textProtocolOn'))
    expect(screen.queryByText(T('agent.textProtocolReadFail'))).toBeNull()
  })
})

describe('③ 接线计数：旧写法归零，六处的新落点逐条数得出', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../src/renderer/src', rel), 'utf-8').replace(/\r\n/g, '\n')
  const CFG = read('modules/agent/hooks/useAgentToolConfigs.ts')
  const CHAT = read('modules/agent/hooks/useAgentChat.ts')
  const BAR = read('modules/agent/components/AgentModelBar.tsx')
  const BARS = read('modules/agent/components/AgentToolBars.tsx')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('配置 hook：一发读三个落点（失败／清位／reject），加四处"当场改成功也清位"', () => {
    expect(count(CFG, /markUnread\(/g), '16 = 4 发 × (失败＋读到清位＋reject) 再加 4 个 handler 成功清位').toBe(16)
    expect(count(CFG, /if \(!hasIpcFailed\(v\)\) set/g), '旧写法归零').toBe(0)
    expect(count(CFG, /toolUnread/g), '状态定义＋return 里带出去').toBeGreaterThanOrEqual(2)
  })

  it('chat hook：文本协议与分步明细各"失败／清位／reject"，旧写法一条不剩', () => {
    expect(count(CHAT, /setTextProtocolUnread\(/g)).toBe(4)
    expect(count(CHAT, /setLatestTracesUnread\(/g)).toBe(5)
    expect(count(CHAT, /if \(!hasIpcFailed\(list\)\) setTextProtocolModels/g)).toBe(0)
    expect(count(CHAT, /if \(!hasIpcFailed\(traces\)\) setLatestTraces/g)).toBe(0)
  })

  it('渲染层：两颗徽标各自第三态在场，那三条 notice 在收起态与展开态都渲染', () => {
    expect(count(BAR, /workspaceUnread/g), '📁 那颗的三态（props 声明＋解构＋title＋文本）').toBe(6)
    expect(count(BAR, /textProtocolUnread/g), '文本协议那颗的三态').toBe(6)
    expect(count(BARS, /unreadBars/g), '定义一处＋两个分支各渲染一次').toBe(3)
    expect(count(BARS, /ShowingDefaultsNotice/g), '三条点名（终端命令／联网搜索／日历）').toBe(5)
  })

  it('四条新文案在四本字典都有，且界面里真在用（不是死键）', () => {
    for (const key of ['agent.workspaceReadFail', 'agent.workspaceUnread', 'agent.textProtocolReadFail', 'agent.textProtocolUnread']) {
      expect(T(key), `${key} 该在 zh 里`).toBeTruthy()
      const used = count(BAR, new RegExp(`'${key}'`, 'g')) + count(BARS, new RegExp(`'${key}'`, 'g'))
      expect(used, `${key} 必须有渲染点`).toBeGreaterThan(0)
    }
  })
})
