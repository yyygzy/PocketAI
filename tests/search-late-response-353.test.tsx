// @vitest-environment jsdom
// V4-Iter-353（旧四条之④）：两条侧栏的全文搜索补上"哪一轮"的归属判据。
//
// 缺陷形状＝§309／§311／§348 那一族的又一种到货方式：**debounce 合不掉在飞那发**。
// 200ms 只把"同一串字还没打完"的请求合并掉，用户打字跨过这个间隔就会有两发同名通道在飞；
// 先派发那条晚回来时，它把当前关键词的整屏结果换成**旧关键词那一页**（`setResults(r)` 无判据），
// 随后「加载更多」拿的是当前关键词的第 N＋1 页 ⇒ 两份关键词的行拼在同一屏里，而屏上零提示。
// 与 §340 那条"键盘提交守卫只写在鼠标那条上"同形：那颗「加载更多」按钮有 `disabled={loadingMore}`
// ＋`if (loadingMore …) return`，**按钮管得住的路径挡住了，打字这条路径没挡**。
//
// 每屏两条判据：①迟到那发一个字都不写（旧结果不许盖新结果）；②正向对照——只有一发时结果照上屏
// （证明守卫不是恒关）。ConversationList 再多钉一条：「加载更多」迟到那一页不接进新关键词的结果，
// 而且**在飞标志必须照常清掉**——守卫若把 `setLoadingMore(false)` 也挡住，那颗按钮会永远卡在禁用（§348
// 那条"新守卫自己造失效模式"在这里是可执行的，所以写成断言而不是注释）。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { SessionRail } from '../src/renderer/src/modules/agent/components/SessionRail'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, ConversationRecord, MessageSearchResult } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const SETTLE = 260 // debounce 是 200ms，留一点余量（不靠假定时器，避免与 waitFor 打架）

interface Inflight {
  resolve: (v: unknown) => void
  query: string
  offset: number
}
let inflight: Inflight[]

/** 一次交互可以打两发同名通道 ⇒ 队列里每一发都要能单独放行（单槽会被后到的顶掉，§330 同课） */
const queueSearch = (query: unknown, _a?: unknown, _d?: unknown, offset?: unknown): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    inflight.push({ resolve, query: String(query), offset: Number(offset ?? 0) })
  })
const dispatches = (query: string): number => inflight.filter((i) => i.query === query).length
const settleMs = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const answer = (query: string, offset: number, rows: MessageSearchResult[]): void => {
  const one = inflight.find((i) => i.query === query && i.offset === offset)
  if (!one) throw new Error(`没有这一发在飞：${query}@${offset}（现存 ${inflight.map((i) => `${i.query}@${i.offset}`).join('，')}）`)
  one.resolve(rows)
}
const hit = (snippet: string): MessageSearchResult =>
  ({ messageId: `m-${snippet}`, conversationId: 'c1', conversationTitle: '会话一', role: 'user', snippet, createdAt: 1 }) as MessageSearchResult
const PAGE = 50
const FULL_PAGE = (tag: string): MessageSearchResult[] => Array.from({ length: PAGE }, (_, i) => hit(`${tag}-${i}`))

const conv = (id: string): ConversationRecord => ({ id, title: `会话${id}`, assistantId: 'a1' }) as unknown as ConversationRecord
const asst = (): AssistantRecord[] => [{ id: 'a1', name: '写作助手', avatar: '🤖', description: '', builtin: false } as unknown as AssistantRecord]

beforeEach(() => {
  inflight = []
})

describe('对话页侧栏（ConversationList）', () => {
  const mount = (): void => {
    stubPocketai({
      listConversationGroups: () => [],
      searchMessages: queueSearch,
      getDraft: () => '',
      setDraft: () => ({ ok: true })
    })
    mountWithProviders(
      <ConversationList
        conversations={[conv('c1')]}
        currentId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        assistants={asst()}
      />
    )
  }
  const box = (): HTMLElement => document.querySelector('[data-chat-search-input]') as HTMLElement

  it('正向对照：只有一发在飞时，结果照旧上屏（守卫不是恒关）', async () => {
    mount()
    fireEvent.change(box(), { target: { value: '甲' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲')).toBe(1))
    answer('甲', 0, [hit('命中-甲')])
    await settleMs(0)
    expect(screen.getByText('命中-甲')).toBeTruthy()
  })

  it('两发在飞：旧关键词那份晚到，一个字都不许写进屏', async () => {
    mount()
    fireEvent.change(box(), { target: { value: '甲' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲')).toBe(1))
    // 用户接着打字：debounce 把第二发放出去了，第一发还在飞
    fireEvent.change(box(), { target: { value: '甲乙' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲乙')).toBe(1))

    answer('甲乙', 0, [hit('命中-甲乙')])
    await settleMs(0)
    expect(screen.getByText('命中-甲乙')).toBeTruthy()

    answer('甲', 0, [hit('命中-甲-迟到')])
    await settleMs(0)
    expect(screen.queryByText('命中-甲-迟到'), '迟到那发把当前关键词的结果盖掉了').toBeNull()
    expect(screen.getByText('命中-甲乙')).toBeTruthy()
  })

  it('迟到那发也不许把「搜索中」清掉（finally 里那句判据的牙）', async () => {
    mount()
    fireEvent.change(box(), { target: { value: '甲' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲')).toBe(1))
    fireEvent.change(box(), { target: { value: '甲乙' } })
    await settleMs(SETTLE)
    // §364：dispatch 计数不等于「搜索中」已上屏（要先看见在飞态那一格，迟一帧就会假红）
    await waitFor(() => {
      expect(dispatches('甲乙')).toBe(1)
      expect(screen.getByText(L('chat.searching'))).toBeTruthy()
    })

    // 旧那发先落地：它一个字都不该写——**包括在飞标志**（清了就等于宣称"这一串搜完了"，
    // 而屏上既没有结果也等不到结果，下一发还在飞）
    answer('甲', 0, [hit('命中-甲-迟到')])
    await settleMs(0)
    expect(screen.queryByText('命中-甲-迟到')).toBeNull()
    expect(screen.getByText(L('chat.searching')), '迟到那发把「搜索中」清了，屏上会换成"没有找到"').toBeTruthy()

    answer('甲乙', 0, [hit('命中-甲乙')])
    await settleMs(0)
    expect(screen.getByText('命中-甲乙')).toBeTruthy()
    expect(screen.queryByText(L('chat.searching'))).toBeNull()
  })

  it('「加载更多」那一页属于点下去那一刻的关键词：换了关键词后晚到不许接进结果，也不许把按钮卡在禁用', async () => {
    // 那颗按钮在 hasMore 为假时根本不渲染 ⇒ 两页都给整页（50 行），它才一直挂在屏上，
    // "在飞标志有没有被清"才是可断言的（守卫若把 setLoadingMore(false) 也挡住，它就永远停在禁用）
    const moreBtn = (): HTMLButtonElement | undefined =>
      [...document.querySelectorAll('button')].find(
        (b) => b.textContent === L('chat.searchLoadMore') || b.textContent === L('chat.searchLoading')
      )
    mount()
    fireEvent.change(box(), { target: { value: '甲' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲')).toBe(1))
    answer('甲', 0, FULL_PAGE('页一'))
    await settleMs(0)

    fireEvent.click(moreBtn()!)
    await waitFor(() => expect(dispatches('甲')).toBe(2))
    // 在飞那一页还没回，用户改了关键词 ⇒ 首页那发领了新的关联号
    fireEvent.change(box(), { target: { value: '乙' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('乙')).toBe(1))
    answer('乙', 0, FULL_PAGE('新页'))
    await settleMs(0)
    // 此刻旧那发仍在飞：按钮显示「加载中」是**对的**（这一发确实还没落定）
    expect(moreBtn()!.textContent).toBe(L('chat.searchLoading'))

    answer('甲', PAGE, FULL_PAGE('旧页'))
    await settleMs(0)
    expect(screen.queryByText('旧页-0'), '旧关键词那一页被接进了新关键词的结果里').toBeNull()
    expect(screen.getByText('新页-0')).toBeTruthy()
    const btn = moreBtn()
    expect(btn, '那颗按钮不该消失（新关键词那页仍是整页，还有下一页）').toBeTruthy()
    expect(btn!.disabled, '在飞标志没被清 ⇒ 守卫把 setLoadingMore(false) 也挡住了').toBe(false)
    expect(btn!.textContent).toBe(L('chat.searchLoadMore'))
  })
})

describe('Agent 页侧栏（SessionRail）', () => {
  const mount = (): void => {
    stubPocketai({
      listConversationGroups: () => [],
      searchMessages: queueSearch
    })
    mountWithProviders(
      <SessionRail
        assistants={asst()}
        assistantId="a1"
        onAssistantChange={() => {}}
        conversations={[conv('c1'), conv('c2')]}
        conversationId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />
    )
  }
  const box = (): HTMLElement => screen.getByPlaceholderText(L('chat.searchPlaceholder')) as HTMLElement

  it('正向对照：只有一发在飞时结果上屏', async () => {
    mount()
    fireEvent.change(box(), { target: { value: '甲' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲')).toBe(1))
    answer('甲', 0, [hit('栏-命中-甲')])
    await settleMs(0)
    expect(screen.getByText('栏-命中-甲')).toBeTruthy()
  })

  it('两发在飞：旧关键词那份晚到，结果与「搜索中」都不许动（与对话页同一份规矩、各自钉一遍）', async () => {
    mount()
    fireEvent.change(box(), { target: { value: '甲' } })
    await settleMs(SETTLE)
    await waitFor(() => expect(dispatches('甲')).toBe(1))
    fireEvent.change(box(), { target: { value: '甲乙' } })
    await settleMs(SETTLE)
    // §364：dispatch 计数不等于「搜索中」已上屏（要先看见在飞态那一格，迟一帧就会假红）
    await waitFor(() => {
      expect(dispatches('甲乙')).toBe(1)
      expect(screen.getByText(L('chat.searching'))).toBeTruthy()
    })

    // 迟到的那一发先落地：一个字都不该写，也不该把「搜索中」清掉
    answer('甲', 0, [hit('栏-命中-甲-迟到')])
    await settleMs(0)
    expect(screen.queryByText('栏-命中-甲-迟到'), 'Agent 侧栏的迟到那发把当前结果盖掉了').toBeNull()
    expect(screen.getByText(L('chat.searching')), '迟到那发清了在飞标志，屏上会换成"没有找到"').toBeTruthy()

    answer('甲乙', 0, [hit('栏-命中-甲乙')])
    await settleMs(0)
    expect(screen.getByText('栏-命中-甲乙')).toBeTruthy()
    expect(screen.queryByText(L('chat.searching'))).toBeNull()
  })
})
