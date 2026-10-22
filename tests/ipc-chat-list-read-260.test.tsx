// V4-Iter-260：对话页那三发列表读（会话／归档／分组）——失败对象不再当数组用。
//
// 探针实测（临时用例，跑完即删）：`listConversations` 回 `{ok:false,error}` 时，
// `ConversationList` 渲染第一句 `conversations.filter` 就抛 `is not a function` ⇒ **整屏一个字都不剩**
// （真应用里由根层 AppErrorBoundary 接住＝整站崩溃屏）；ChatModule 里 `[...conversations, ...archivedConversations]`
// 那句同一形状，抛 `is not iterable`。
//
// 这一簇的落点从 ChatModule 抽成 `useConversationLists`：ChatModule 全仓没有挂载用例（整棵树代价不成比例，
// §250 起那几处只有源码级判据），抽出来才能用 renderHook 真跑到那三发。清空口径与 §259 同，
// 但这里三发是同一个函数拉的（切换助手与操作后刷新走同一条路），所以按**归属**判：
// 上一份属于别的助手 ⇒ 清空；上一份就是这个助手（刷新）⇒ 保持，只把那一发点名说读不到。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useConversationLists } from '../src/renderer/src/modules/chat/useConversationLists'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ConversationGroupRecord, ConversationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string => L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

const C1 = { id: 'c1', title: '会话一', assistantId: 'a1' } as unknown as ConversationRecord
const C2 = { id: 'c2', title: '会话二', assistantId: 'a1' } as unknown as ConversationRecord
const ARCH = { id: 'c9', title: '归档一', assistantId: 'a1' } as unknown as ConversationRecord
const GRP = { id: 'g1', name: '组一', assistantId: 'a1' } as unknown as ConversationGroupRecord

type Impl = (...a: any[]) => unknown
const okStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listConversations: (_aid: string, _isAgent: boolean, archivedOnly?: boolean) =>
    archivedOnly ? [ARCH] : [C1, C2],
  listConversationGroups: () => [GRP],
  ...over
})

/** 三发各自"属于哪个助手"由 ref 决定：切助手就是把 ref 改了再拉一次（ChatModule 里正是这个顺序） */
const setup = (over: Record<string, Impl> = {}) => {
  stubPocketai(okStubs(over))
  const assistantIdRef = { current: 'a1' }
  const currentConvRef = { current: null as string | null }
  const onAutoSelect = vi.fn()
  const { result } = renderHook(
    () => useConversationLists({ assistantIdRef, currentConvRef, onAutoSelect }),
    { wrapper: HookProviders }
  )
  return { result, assistantIdRef, currentConvRef, onAutoSelect }
}

describe('① 三发各判各的：失败对象绝不进 state', () => {
  it('三发都回 {ok:false} ⇒ 三份都还是空数组，三句各点各的名，返回值也是数组', async () => {
    const { result, onAutoSelect } = setup({
      listConversations: (_a: string, _x: boolean, archivedOnly?: boolean) =>
        ({ ok: false, error: archivedOnly ? 'CONV_ARCH:归档读不到' : 'CONV_ACTIVE:会话读不到' }),
      listConversationGroups: () => ({ ok: false, error: 'GROUP:分组读不到' })
    })
    let ret: unknown
    await act(async () => {
      ret = await result.current.reloadConversations(true)
    })
    expect(result.current.conversations).toEqual([])
    expect(result.current.archivedConversations).toEqual([])
    expect(result.current.groups).toEqual([])
    expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:会话读不到' })
    expect(result.current.archivedUnread).toEqual({ error: 'CONV_ARCH:归档读不到' })
    expect(result.current.groupsUnread).toEqual({ error: 'GROUP:分组读不到' })
    // 这一条就是本批的立项理由：以前这三个 state 里躺的是失败对象
    expect(Array.isArray(ret), '命令面板那条路拿到的返回值也必须是数组（否则 list.find 当场抛）').toBe(true)
    expect(ret).toEqual([])
    expect(onAutoSelect, '没读到就不自动选，不能凭空选一条不存在的会话').not.toHaveBeenCalled()
  })

  it('只有分组读不到 ⇒ 两份会话照常在，只点分组那一句（逐发点名）', async () => {
    const { result } = setup({ listConversationGroups: () => ({ ok: false, error: 'GROUP:分组读不到' }) })
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversations).toEqual([C1, C2])
    expect(result.current.archivedConversations).toEqual([ARCH])
    expect(result.current.groups).toEqual([])
    expect(result.current.conversationsUnread).toBeNull()
    expect(result.current.archivedUnread).toBeNull()
    expect(result.current.groupsUnread).toEqual({ error: 'GROUP:分组读不到' })
  })

  it('只有活跃那发读不到 ⇒ 归档与分组保住（一发失败不许带走另两发的成功读数），且不许自动选中', async () => {
    const { result, onAutoSelect } = setup({
      listConversations: (_a: string, _x: boolean, archivedOnly?: boolean) =>
        archivedOnly ? [ARCH] : { ok: false, error: 'CONV_ACTIVE:会话读不到' }
    })
    await act(async () => { await result.current.reloadConversations(true) })
    expect(result.current.archivedConversations).toEqual([ARCH])
    expect(result.current.groups).toEqual([GRP])
    expect(result.current.conversations).toEqual([])
    expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:会话读不到' })
    expect(result.current.archivedUnread).toBeNull()
    expect(result.current.groupsUnread).toBeNull()
    expect(onAutoSelect).not.toHaveBeenCalled()
  })

  it('反向对照：三发都读到 ⇒ 三句都是 null 且自动选中最近一条', async () => {
    const { result, onAutoSelect } = setup()
    await act(async () => { await result.current.reloadConversations(true) })
    expect(result.current.conversations).toEqual([C1, C2])
    expect(result.current.groups).toEqual([GRP])
    expect(result.current.conversationsUnread).toBeNull()
    expect(result.current.archivedUnread).toBeNull()
    expect(result.current.groupsUnread).toBeNull()
    expect(onAutoSelect).toHaveBeenCalledWith('c1')
  })

  it('已经有选中时不覆盖（autoSelect 只填「没选中」那一格）', async () => {
    const { result, currentConvRef, onAutoSelect } = setup()
    currentConvRef.current = 'c5'
    await act(async () => { await result.current.reloadConversations(true) })
    expect(onAutoSelect).not.toHaveBeenCalled()
  })

  it('读到了但不是数组（信封串位／旧形状）⇒ 按读不到处理，error 留空由界面兜底', async () => {
    const { result } = setup({
      listConversations: () => ({ ok: true, data: [C1] }) as unknown as ConversationRecord[]
    })
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversations, '形状不符也不许写进 state').toEqual([])
    expect(result.current.conversationsUnread).toEqual({ error: undefined })
  })

  it('reject 面（通道本身抛了）⇒ 三句都用抛出的原文，且不再拿旧助手的列表撑着', async () => {
    const { result } = setup({
      listConversations: () => Promise.reject(new Error('会话通道炸了')),
      listConversationGroups: () => Promise.reject(new Error('会话通道炸了'))
    })
    await act(async () => { await result.current.reloadConversations(true) })
    expect(result.current.conversationsUnread).toEqual({ error: '会话通道炸了' })
    expect(result.current.archivedUnread).toEqual({ error: '会话通道炸了' })
    expect(result.current.groupsUnread).toEqual({ error: '会话通道炸了' })
    expect(result.current.conversations).toEqual([])
  })
})

describe('② 清空还是保持：按「上一份属于哪个助手」判', () => {
  it('旧助手那次的响应晚到 ⇒ 不许盖掉新助手已经在屏上的列表', async () => {
    // 真机顺序：切助手（先改 assistantIdRef 再拉）与流式收尾的那次刷新撞上 ⇒ 旧的那发会晚到货
    const resolvers: Array<(v: unknown) => void> = []
    const stubs: Record<string, Impl> = {
      listConversations: (aid: string, _x: boolean, archivedOnly?: boolean) => {
        if (aid === 'a1') return new Promise((res) => { resolvers.push(res) })
        return archivedOnly ? [] : [{ id: 'c-a2', title: 'a2' } as unknown as ConversationRecord]
      },
      listConversationGroups: (aid: string) => (aid === 'a1' ? new Promise((res) => { resolvers.push(res) }) : [])
    }
    const { result, assistantIdRef } = setup(stubs)
    const first = result.current.reloadConversations(false)
    assistantIdRef.current = 'a2'
    await act(async () => { await result.current.reloadConversations(true) })
    expect(result.current.conversations).toEqual([{ id: 'c-a2', title: 'a2' }])
    await act(async () => {
      resolvers.forEach((res) => res([{ id: 'c-a1', title: 'a1' } as unknown as ConversationRecord]))
      await first
    })
    expect(result.current.conversations, '迟到那次写的是 a1 的列表，落屏就是把 a1 的会话演成 a2 的').toEqual([
      { id: 'c-a2', title: 'a2' }
    ])
    expect(result.current.conversationsUnread, '迟到那发也不许留下"读不到"').toBeNull()
  })

  it('旧助手那次是 reject 且晚到 ⇒ 也不许在新助手屏上留一句"读不到"', async () => {
    const rejectors: Array<(e: unknown) => void> = []
    const { result, assistantIdRef } = setup({
      listConversations: (aid: string, _x: boolean, archivedOnly?: boolean) => {
        if (aid === 'a1') return new Promise((_res, rej) => { rejectors.push(rej) })
        return archivedOnly ? [] : [{ id: 'c-a2', title: 'a2' } as unknown as ConversationRecord]
      },
      listConversationGroups: (aid: string) =>
        aid === 'a1' ? new Promise((_res, rej) => { rejectors.push(rej) }) : []
    })
    const first = result.current.reloadConversations(false)
    assistantIdRef.current = 'a2'
    await act(async () => { await result.current.reloadConversations(true) })
    await act(async () => {
      rejectors.forEach((rej) => rej(new Error('a1 那发通道炸了')))
      await first
    })
    expect(result.current.conversations).toEqual([{ id: 'c-a2', title: 'a2' }])
    expect(result.current.conversationsUnread, '迟到那次的报错不该说成新助手读不到').toBeNull()
    expect(result.current.groupsUnread).toBeNull()
  })

  it('同一助手的刷新失败 ⇒ 保持上一份＋点名，恢复后那句自己收回', async () => {
    let failing = false
    const { result } = setup({
      listConversations: (_a: string, _x: boolean, archivedOnly?: boolean) =>
        failing ? { ok: false, error: `CONV_${archivedOnly ? 'ARCH' : 'ACTIVE'}:刷新挂了` }
          : archivedOnly ? [ARCH] : [C1, C2],
      listConversationGroups: () => (failing ? { ok: false, error: 'GROUP:刷新挂了' } : [GRP])
    })
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversations).toEqual([C1, C2])
    failing = true
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversations, '清空会把「刚归档完这一条」演成「整列消失」').toEqual([C1, C2])
    expect(result.current.groups).toEqual([GRP])
    expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:刷新挂了' })
    expect(result.current.groupsUnread).toEqual({ error: 'GROUP:刷新挂了' })

    failing = false
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversationsUnread).toBeNull()
    expect(result.current.groupsUnread).toBeNull()
  })

  it('切到另一个助手而这一发失败 ⇒ 必须清空（上一份是别的助手的，留着更会骗人）', async () => {
    let failing = false
    const { result, assistantIdRef } = setup({
      listConversations: (aid: string, _x: boolean, archivedOnly?: boolean) => {
        if (failing) return { ok: false, error: `CONV_${archivedOnly ? 'ARCH' : 'ACTIVE'}:${aid} 读不到` }
        return archivedOnly ? [] : [{ id: `c-${aid}`, title: aid } as unknown as ConversationRecord]
      },
      listConversationGroups: () => []
    })
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversations).toEqual([{ id: 'c-a1', title: 'a1' }])

    // ChatModule 的顺序：先改 assistantIdRef，再拉这一助手的列表
    assistantIdRef.current = 'a2'
    failing = true
    await act(async () => { await result.current.reloadConversations(true) })
    expect(result.current.conversations, '上一份属于 a1 ⇒ a2 读不到时不能接着摆').toEqual([])
    expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:a2 读不到' })
    expect(result.current.groups, '分组空但读到了 ⇒ 归属改到 a2').toEqual([])

    // 归属已易主之后再失败一次：这次上一份（空数组）就是 a2 的 ⇒ 保持，不再清空
    failing = true
    await act(async () => { await result.current.reloadConversations() })
    expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:a2 读不到' })

    failing = false
    await act(async () => { await result.current.reloadConversations(true) })
    expect(result.current.conversations).toEqual([{ id: 'c-a2', title: 'a2' }])
    expect(result.current.conversationsUnread).toBeNull()
  })
})

describe('③ ConversationList：三句各点各的名，空态让位', () => {
  const mount = (props: Record<string, unknown> = {}) => {
    // 这三句的数据全走 props 进来；挂载只需要 i18n 那句 setAppLanguage（harness 会兜默认实现）
    stubPocketai({})
    return mountWithProviders(
      <ConversationList
        conversations={[]}
        currentId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        assistants={[]}
        {...props}
      />
    )
  }

  it('三份都读不到 ⇒ 三句逐发点名，且「该助手下暂无对话」让位', async () => {
    mount({
      conversationsUnread: { error: 'CONV_ACTIVE:会话读不到' },
      archivedUnread: { error: 'CONV_ARCH:归档读不到' },
      groupsUnread: { error: 'GROUP:分组读不到' }
    })
    await waitFor(() => expect(alerts()).toEqual([
      NAMED('会话列表', 'CONV_ACTIVE:会话读不到'),
      NAMED('归档会话', 'CONV_ARCH:归档读不到'),
      NAMED('会话分组', 'GROUP:分组读不到')
    ]))
    expect(screen.queryByText(L('chat.noConversations'))).toBeNull()
  })

  it('只有分组读不到 ⇒ 另两句不许冒，会话照常列出', async () => {
    mount({ conversations: [C1, C2], groupsUnread: { error: 'GROUP:分组读不到' } })
    await waitFor(() => expect(alerts()).toEqual([NAMED('会话分组', 'GROUP:分组读不到')]))
    expect(screen.getByText('会话一')).toBeTruthy()
    expect(screen.queryByText(L('chat.noConversations'))).toBeNull()
  })

  it('读到了但为空 ⇒ 仍是那句「该助手下暂无对话」，屏上没有「读不到」', async () => {
    mount()
    expect(screen.getByText(L('chat.noConversations'))).toBeTruthy()
    expect(alerts()).toEqual([])
  })
})

describe('④ 接线计数', () => {
  // 注释里的"接管"不算数（与 §250 那道闸门同一条纪律）：本批的 hook 文件头就把旧写法整句抄在注释里
  const blankComments = (code: string): string =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1}${' '.repeat(_m.length - p1.length - 1)}`)
  const read = (rel: string): string =>
    blankComments(fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n'))
  const HOOK = read('src/renderer/src/modules/chat/useConversationLists.ts')
  const CHAT = read('src/renderer/src/modules/chat/ChatModule.tsx')
  const LIST = read('src/renderer/src/modules/chat/ConversationList.tsx')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('ChatModule 那三行"拿到就写进 state"必须归零（探针撞到的形状）', () => {
    expect(count(CHAT, /setConversations\(list\)\n\s*setArchivedConversations\(archived\)\n\s*setGroups\(groupList\)/g),
      '三发不许再挨着裸写').toBe(0)
    expect(count(CHAT, /list\.length > 0/g), '不许再拿返回值裸判长度').toBe(0)
    expect(count(CHAT, /window\.pocketai\.listConversations\(aid/g), '这三发已不在 ChatModule 里').toBe(0)
  })

  it('hook 里三发各判一次，成功支各写一次', () => {
    expect(count(HOOK, /if \(hasIpcFailed\(list\) \|\| !Array\.isArray\(list\)\)/g)).toBe(1)
    expect(count(HOOK, /if \(hasIpcFailed\(archived\) \|\| !Array\.isArray\(archived\)\)/g)).toBe(1)
    expect(count(HOOK, /if \(hasIpcFailed\(groupList\) \|\| !Array\.isArray\(groupList\)\)/g)).toBe(1)
    expect(count(HOOK, /setConversations\(list\)/g), '成功支没被顺手删').toBe(1)
    expect(count(HOOK, /setArchivedConversations\(archived\)/g)).toBe(1)
    expect(count(HOOK, /setGroups\(groupList\)/g)).toBe(1)
    expect(count(HOOK, /setConversationsUnread\(null\)/g), '成功即收回：then 一处＋没有别的裸写').toBe(1)
    expect(count(HOOK, /if \(stale\(\)\) return/g), '迟到的那一发：then 与 catch 两处都不许写 state').toBe(2)
  })

  it('那三句要真传到 ConversationList，且空态被让位判据挡住', () => {
    expect(count(CHAT, /conversationsUnread=\{conversationsUnread\}/g)).toBe(1)
    expect(count(CHAT, /archivedUnread=\{archivedUnread\}/g)).toBe(1)
    expect(count(CHAT, /groupsUnread=\{groupsUnread\}/g)).toBe(1)
    expect(count(LIST, /<LoadFailNotice/g), '三句各一块').toBe(3)
    expect(count(LIST, /!conversationsUnread && filteredConversations\.length === 0/g)).toBe(1)
    expect(count(LIST, /!conversationsUnread && topConversations\.length === 0/g)).toBe(1)
  })
})
