// @vitest-environment jsdom
// V4-Iter-415（策划书 P0-2a＝"纯文案与空态"那一档）：三处界面上说的话，各自钉住
//
// 现场（现查）：
//  ① 单价表默认是空的（`pricing-config.ts` 无配置 ⇒ `prices:{}`），而 `fmtCost(0)` 返回**空串**——
//     于是用量屏的预算那两行画成「¥ / ¥50」：左半是裸货币符号，整行读起来像"今天一分没花"，
//     实情是"算不出"。同形还有两处：费用趋势柱的 tooltip、明细表底部那格合计。
//  ② Linux 取不到系统选中文本这件事只写在 `src/main/popup.ts` 的一行注释里；设置屏那颗开关照常能开，
//     按下只会打开快捷问答窗（`grabSelectedText` 首行 return '' ⇒ `text?'selection':'quick'`）。
//  ③ 提醒／维护任务／渠道网关都依赖"应用开着"，屏上却只有备份那一栏说过（`bk.scheduleHint`）。
//     三句各按各自的真行为写：提醒＝退出期间到点的标已错过、**不补发**；维护任务＝下次启动后**补跑**；
//     渠道＝退出后没人代答，重启才恢复。
import { describe, it, expect, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { PopupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { MessageBubble } from '../src/renderer/src/modules/chat/MessageBubble'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { ChannelsPanel } from '../src/renderer/src/modules/agent/channels/ChannelsPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ChannelConfig, ChannelType, DataHealthReport, ReminderRecord, UsageBudgetStatus, UsageDetailItem, UsagePricing, UsageStats, UsageSummary } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const FAIL = { ok: false, error: 'PROBE:单价读不到' }

const summary = (cost: number): UsageSummary => ({
  days: 30,
  totals: { requests: 3, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, cost },
  daily: [],
  byProvider: [],
  byModel: [],
  sideCalls: []
})
const budget = (over: Partial<UsageBudgetStatus> = {}): UsageBudgetStatus => ({
  daily: 50, monthly: null, todayCost: 0, monthCost: 0, hardBlock: false, warn: true, ...over
})
const EMPTY_PRICES: UsagePricing = { currency: 'CNY', prices: {} }
const ONE_PRICE: UsagePricing = { currency: 'CNY', prices: { 'p1|m1': { input: 1, output: 2 } } }

/** 渠道配置桩：形状照 `renderer-channel-b3.test.tsx` 那份抄，缺字段会把受控 input 变成非受控（React 会警告） */
const fakeCfg = (type: ChannelType): ChannelConfig => ({
  type, enabled: false, hasPrimarySecret: false, hasSecondarySecret: false,
  appId: '', whitelist: '', assistantId: '', providerId: '', model: '', agentMode: false
})

/** 预算那一卡里某一行的整行容器：标签 → 内层那圈 → 再往上＝`BudgetRow` 自己那一格（条与金额都在它里面） */
const budgetRowEl = (label: string): HTMLElement => {
  let el: HTMLElement | null = screen.getByText(label, { selector: '*' })
  while (el && (el.textContent ?? '').trim() === label) el = el.parentElement
  const outer = el?.parentElement
  expect(outer, `「${label}」那一行找不到`).not.toBeNull()
  return outer as HTMLElement
}
/** 那一行的整行文本（进度条那颗 div 没有文字，所以取到的仍是「金额＋超支那句」） */
const budgetRowText = (label: string): string => (budgetRowEl(label).textContent ?? '').trim()
/** 那一行里画了几根超额进度条 */
const barsOf = (label: string): number => budgetRowEl(label).querySelectorAll('[data-testid="usage-budget-bar"]').length

async function mountUsage(pricing: UsagePricing | typeof FAIL, bud: UsageBudgetStatus | UsagePricing): Promise<void> {
  stubPocketai({
    getUsageSummary: () => summary((bud as UsageBudgetStatus).todayCost ?? 0),
    getUsageConversations: () => [],
    getUsageAssistants: () => [],
    getUsageBudget: () => bud,
    getUsagePricing: () => pricing
  })
  mountWithProviders(<UsagePanel />)
  await screen.findByText(L('usage.budget'), {}, MOUNT_BUDGET)
}

describe('① 用量屏预算那两行：没配单价该说"算不出"，不是裸货币符号', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('空价表 ⇒ 那句在、金额那半留白、不画超额进度条', async () => {
    await mountUsage(EMPTY_PRICES, budget({ todayCost: 0 }))
    const hint = await screen.findByTestId('usage-budget-no-price', {}, MOUNT_BUDGET)
    expect(hint.textContent).toBe(L('usage.budgetNoPrice'))
    const row = budgetRowText(L('usage.budgetDaily'))
    expect(row, '算不出不许画成 ¥0').toContain('— / ¥50')
    expect(row).not.toContain('¥0')
  })

  it('反向对照：配了单价且确实没花 ⇒ 那句不在，金额老老实实写 ¥0', async () => {
    await mountUsage(ONE_PRICE, budget({ todayCost: 0 }))
    await waitFor(() => expect(screen.getByText(L('usage.budget'))).toBeTruthy(), MOUNT_BUDGET)
    expect(screen.queryByTestId('usage-budget-no-price'), '配过单价就不许说"未配置"').toBeNull()
    expect(budgetRowText(L('usage.budgetDaily'))).toContain('¥0 / ¥50')
  })

  it('正向对照：算得出 ⇒ 金额照写', async () => {
    await mountUsage(ONE_PRICE, budget({ todayCost: 1.23 }))
    await waitFor(() => expect(budgetRowText(L('usage.budgetDaily')).includes('¥1.23')).toBe(true), MOUNT_BUDGET)
    expect(screen.queryByTestId('usage-budget-no-price')).toBeNull()
  })

  it('单价那一发读不到 ⇒ 不许宣称"未配置单价"，金额那半留白', async () => {
    await mountUsage(FAIL, budget())
    await waitFor(() => expect(screen.getByText(L('usage.budget'))).toBeTruthy(), MOUNT_BUDGET)
    expect(screen.queryByTestId('usage-budget-no-price'), '还在飞／读不到 ≠ 没配过').toBeNull()
    expect(budgetRowText(L('usage.budgetDaily'))).toContain('— / ¥50')
  })

  it('空价表但历史那笔已超上限 ⇒ 不说超支、不画那根条', async () => {
    // 曾配过单价→留下非 0 的记录→再清空价表：`todayCost` 取自历史记录，可能是非 0 的
    await mountUsage(EMPTY_PRICES, budget({ todayCost: 80 }))
    await screen.findByTestId('usage-budget-no-price', {}, MOUNT_BUDGET)
    const row = budgetRowText(L('usage.budgetDaily'))
    expect(row, '算不出不许判超额').not.toContain(L('usage.budgetExceeded').replace('{scope}', L('usage.budgetDaily')))
    expect(barsOf(L('usage.budgetDaily')), '算不出不画进度条').toBe(0)
  })

  it('正向对照：配了单价且真的超 ⇒ 那句不在、每日那行有根条、说超支', async () => {
    await mountUsage(ONE_PRICE, budget({ todayCost: 80 }))
    await waitFor(() => expect(budgetRowText(L('usage.budgetDaily')).includes('¥80.00')).toBe(true), MOUNT_BUDGET)
    expect(screen.queryByTestId('usage-budget-no-price')).toBeNull()
    expect(barsOf(L('usage.budgetDaily')), '设了上限那一行该有条').toBe(1)
    expect(budgetRowText(L('usage.budgetDaily'))).toContain(L('usage.budgetExceeded').replace('{scope}', L('usage.budgetDaily')))
  })

  it('上限填 0 ⇒ 两半都写 ¥0，不许留裸货币符号', async () => {
    await mountUsage(ONE_PRICE, budget({ todayCost: 0, daily: 0 }))
    await waitFor(() => expect(screen.getByText(L('usage.budget'))).toBeTruthy(), MOUNT_BUDGET)
    const row = budgetRowText(L('usage.budgetDaily'))
    expect(row).toContain('¥0 / ¥0')
    expect(row).not.toMatch(/¥\s*\//)
  })

  it('费用趋势柱：没花钱那天那格的 title 只说 token，不许留裸货币符号', async () => {
    stubPocketai({
      getUsageSummary: () => ({
        ...summary(0.5),
        daily: [
          { date: '2026-11-01', totalTokens: 100, cost: 0 },
          { date: '2026-11-02', totalTokens: 200, cost: 0.5 }
        ]
      }),
      getUsageConversations: () => [],
      getUsageAssistants: () => [],
      getUsageBudget: () => budget(),
      getUsagePricing: () => ONE_PRICE
    })
    const { container } = mountWithProviders(<UsagePanel />)
    // 正向对照＝有花钱那天那格确实带着费用；负向句读的是零花费那一格
    await waitFor(() => expect(Array.from(container.querySelectorAll('[title]'))
      .some((el) => (el.getAttribute('title') ?? '').includes('¥0.50'))).toBe(true), MOUNT_BUDGET)
    const zero = Array.from(container.querySelectorAll('[title]'))
      .filter((el) => (el.getAttribute('title') ?? '').startsWith('2026-11-01 ·'))
    expect(zero.length, '零花费那一天的那根柱找不到').toBeGreaterThan(0)
    for (const el of zero) {
      const title = el.getAttribute('title') ?? ''
      expect(title, '算不出／没花钱不许画成裸 ¥：' + title).not.toMatch(/¥\s*$/)
      expect(title).toBe('2026-11-01 · 100')
    }
  })

  it('明细弹窗合计格：全是算不出 ⇒ 留白，不画裸货币符号', async () => {
    const item = (cost: number): UsageDetailItem => ({
      createdAt: 1, kind: 'chat', messageId: 'm1', conversationId: 'c1', conversationTitle: 'PROBE-会话',
      assistantId: null, assistantName: null, provider: 'p1', model: 'm1',
      promptTokens: 10, completionTokens: 5, cachedTokens: 0, totalTokens: 15, cost
    })
    stubPocketai({
      getUsageSummary: () => summary(0),
      getUsageConversations: () => [
        { conversationId: 'c1', title: 'PROBE-会话一', requests: 1, totalTokens: 15, cost: 0, lastUsedAt: 1 },
        { conversationId: 'c2', title: 'PROBE-会话二', requests: 1, totalTokens: 15, cost: 0.4, lastUsedAt: 1 }
      ],
      getUsageAssistants: () => [],
      getUsageBudget: () => budget(),
      getUsagePricing: () => ONE_PRICE,
      getUsageDetail: (_days: unknown, _limit: unknown, id: string) =>
        ({ items: [item(id === 'c1' ? 0 : 0.4)], truncated: false })
    })
    mountWithProviders(<UsagePanel />)
    // 走到明细弹窗：先等两张排行到货，再点会话那一行的那颗眼睛
    await waitFor(() => expect(screen.getAllByTitle(L('usage.viewDetail')).length).toBe(2), MOUNT_BUDGET)
    const eyes = screen.getAllByTitle(L('usage.viewDetail'))
    fireEvent.click(eyes[0] as HTMLElement)
    // 「合计」那串在表头也出现一次 ⇒ 只读 tfoot 最后一格
    const cell = (): string => {
      const rows = document.querySelectorAll('tfoot tr')
      const last = rows[rows.length - 1]?.lastElementChild
      return (last?.textContent ?? '').trim()
    }
    // 正向对照＝另一行（0.4）那格确实写着 ¥0.4000（`fmtCost` 对 <1 走四位）；这里先把当前这一格读到 '—'
    await waitFor(() => expect(cell()).toBe('—'), MOUNT_BUDGET)
    fireEvent.click(eyes[1] as HTMLElement)
    await waitFor(() => expect(cell()).toBe('¥0.4000'), MOUNT_BUDGET)
  })
})

const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform') ??
  Object.getOwnPropertyDescriptor(window.navigator, 'platform')
const setPlatform = (value: string): void => {
  Object.defineProperty(window.navigator, 'platform', { value, configurable: true })
}

describe('② 选区助手：Linux 上那句要说，其它平台不许凭空多一句', () => {
  afterEach(() => {
    if (realPlatform && realPlatform.set) {
      Object.defineProperty(window.navigator, 'platform', realPlatform)
    }
    document.body.innerHTML = ''
  })

  it('Linux ⇒ 那颗开关下面一句"取不到选中文本，按下只打开快捷问答窗"', async () => {
    setPlatform('Linux x86_64')
    stubPocketai({ getPopupConfig: () => ({ quickEnabled: true, selectionEnabled: true, quickAccelerator: 'CommandOrControl+Shift+Space', selectionAccelerator: 'CommandOrControl+Shift+E' }) })
    mountWithProviders(<PopupPanel />)
    const hint = await screen.findByTestId('set-popup-linux-hint', {}, MOUNT_BUDGET)
    expect(hint.textContent).toContain(L('popup.selectionLinuxHint').slice(0, 12))
    // 快捷问答那一行不许被牵连（它不依赖取词）
    expect(document.querySelectorAll('[data-testid="set-popup-linux-hint"]').length).toBe(1)
  })

  it('反向对照：Windows ⇒ 那句不在', async () => {
    setPlatform('Win32')
    stubPocketai({ getPopupConfig: () => ({ quickEnabled: true, selectionEnabled: true, quickAccelerator: 'CommandOrControl+Shift+Space', selectionAccelerator: 'CommandOrControl+Shift+E' }) })
    mountWithProviders(<PopupPanel />)
    await screen.findByText(L('popup.selectionTitle'), {}, MOUNT_BUDGET)
    expect(screen.queryByTestId('set-popup-linux-hint')).toBeNull()
  })
})

describe('③ 三句"要应用开着才会做"，各按各自的真行为说', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const rec = (over: Partial<ReminderRecord>): ReminderRecord => ({
    id: 'r-1',
    text: '交周报',
    fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(),
    status: 'pending',
    conversationId: null,
    createdAt: new Date(2026, 9, 10, 8, 0, 0).getTime(),
    ...over
  })

  it('提醒中心 ⇒ 说"退出期间到点的记为已错过、不补发"', async () => {
    stubPocketai({
      listReminders: () => [rec({})],
      onReminderFired: () => () => {},
      cancelReminder: () => ({ ok: true }),
      rescheduleNextReminder: () => ({ ok: true }),
      updateReminder: () => ({ ok: true })
    })
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    const hint = await screen.findByTestId('reminder-center-run-hint', {}, MOUNT_BUDGET)
    expect(hint.textContent).toBe(L('reminder.center.runHint'))
  })

  it('数据健康屏维护任务那一栏 ⇒ 说"下次启动后补跑"（不是丢掉）', async () => {
    const report: DataHealthReport = {
      sizes: {
        userDataBytes: 1024, dbBytes: 1024, attachmentsBytes: 0, extensionsBytes: 0, logsBytes: 0,
        coldOffloadBytes: 0, coldOffloadFiles: 0, coldSnapshotBytes: 0, coldSnapshotFiles: 0,
        otherBytes: 0, browserCacheBytes: 0, browserCacheFiles: 0
      },
      approvals: { rows: 0, writeFailures: 0 },
      kb: {
        total: 0, errorDocs: [],
        integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
        vectorIndex: { count: 0, dims: [] }
      },
      backup: { configured: false, passwordUndecryptable: false, configUnreadable: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
      tasks: { kbHealthCheckLastRunAt: null, kbHealthCheckLastOk: null, backupVerifyLastRunAt: null, backupVerifyLastOk: null }
    }
    stubPocketai({
      getDataHealth: () => report,
      openDataFolder: () => ({ ok: true }),
      clearBrowserCache: () => ({ ok: true, beforeBytes: 0, afterBytes: 0 }),
      cleanKbOrphans: () => ({ removedVectors: 0, removedChunks: 0 }),
      reindexKbDocs: () => ({ enqueued: 0 }),
      deduplicateKbDocs: () => ({ removed: 0 })
    })
    mountWithProviders(<DataHealthPanel />)
    const hint = await screen.findByTestId('dh-tasks-run-hint', {}, MOUNT_BUDGET)
    expect(hint.textContent).toBe(L('dh.tasksRunHint'))
  })

  it('渠道页 ⇒ 说"退出后没人代答，重启才恢复"', async () => {
    stubPocketai({
      listProviders: () => [],
      listAssistants: () => [],
      onChannelStatus: () => () => {},
      listChannelStatus: () => [],
      getChannelConfig: (type: unknown) => fakeCfg(type as ChannelType)
    })
    mountWithProviders(<ChannelsPanel />)
    const hint = await screen.findByTestId('channel-run-hint', {}, MOUNT_BUDGET)
    expect(hint.textContent).toBe(L('channel.runHint'))
  })
})

describe('④ 气泡用量详情弹窗那一格：免费（0 元）要写 ¥0，不是裸 ¥', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })
  const usage: UsageStats = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cachedTokens: 0 }

  const mountBubble = (prices: UsagePricing['prices']): void => {
    stubPocketai({ speakText: () => undefined, stopSpeak: () => undefined, copyToClipboard: () => undefined })
    mountWithProviders(
      <MessageBubble
        role="assistant"
        content="答案正文"
        messageId="a1"
        streaming={false}
        usage={usage}
        provider="free"
        model="m1"
        pricing={{ currency: 'CNY', prices } as UsagePricing}
      />
    )
  }

  it('单价填 0 ⇒ 费用那格是 ¥0', async () => {
    mountBubble({ 'free::m1': { input: 0, output: 0 } })
    fireEvent.click(screen.getByText(/tokens/))
    const cell = await screen.findByText(L('usage.cost'), {}, MOUNT_BUDGET)
    const row = cell.closest('div') as HTMLElement
    expect((row.lastElementChild?.textContent ?? '').trim()).toBe('¥0')
  })

  it('反向对照：单价非 0 时那一格照写金额', async () => {
    mountBubble({ 'free::m1': { input: 2000, output: 8000 } })
    fireEvent.click(screen.getByText(/tokens/))
    const cell = await screen.findByText(L('usage.cost'), {}, MOUNT_BUDGET)
    const row = cell.closest('div') as HTMLElement
    expect((row.lastElementChild?.textContent ?? '').trim()).toBe('¥3.60')
  })
})
