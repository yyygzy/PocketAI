// 会话列表那三份读（活跃／归档／分组）——从 ChatModule 抽出，形状与 useStreamSession 同（V4-Iter-260）。
//
// 为什么要单独成文件：这三发过去写成
//   Promise.all([listConversations(aid,false,false), listConversations(aid,false,true), listConversationGroups(aid)])
//     .then(([list, archived, groupList]) => { setConversations(list); … })
// 而 safeHandle 的失败是 **resolve 的 `{ok:false}`**（§196），那句 `.catch` 永远接不到 ⇒ 失败对象被当列表写进 state。
// 探针实测（§260）：`ConversationList` 渲染第一句 `conversations.filter` 当场抛 `is not a function`，整屏一个字都不剩
// （真应用里由根层 AppErrorBoundary 接住＝整站崩溃屏）；`[...conversations, ...archivedConversations]`（ChatModule）
// 同形状抛 `is not iterable`。抽出来还有一层用意：ChatModule 没有挂载用例（整棵树代价不成比例），
// 这份 hook 却能用 renderHook 真跑到那三发。
import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ConversationGroupRecord, ConversationRecord } from '../../../../shared/types'
import { errText } from '../../utils/error'
import { hasIpcFailed, reportIpcError } from '../../utils/ipc'

/** 哪一发没读到：`error` 为空＝拿到了但不是数组（形状不符也按读不到处理，绝不写进列表） */
export type ListUnread = { error?: string } | null

export interface UseConversationListsOptions {
  /** 读哪个助手的列表：切换助手时由父级先行改写，所以取 ref 而不是值（值会把 callback 绑死在旧助手上） */
  assistantIdRef: MutableRefObject<string>
  /** 当前选中会话：只用于「没选中才自动挑最近一条」 */
  currentConvRef: MutableRefObject<string | null>
  /** 自动选中时回调（父级的 setCurrentConvId） */
  onAutoSelect: (id: string) => void
}

export function useConversationLists({
  assistantIdRef,
  currentConvRef,
  onAutoSelect
}: UseConversationListsOptions): {
  conversations: ConversationRecord[]
  archivedConversations: ConversationRecord[]
  groups: ConversationGroupRecord[]
  conversationsUnread: ListUnread
  archivedUnread: ListUnread
  groupsUnread: ListUnread
  reloadConversations: (autoSelect?: boolean) => Promise<ConversationRecord[]>
  // 三份列表的**本地先行**更新仍由 ChatModule 持有（改名／置顶／归档／拖进分组那一族）：
  // 这里只把 setter 交出去，读取失败的处理不经由它们（写进 state 的必须是数组这一条由 reload 保证）
  setConversations: (updater: (prev: ConversationRecord[]) => ConversationRecord[]) => void
  setArchivedConversations: (updater: (prev: ConversationRecord[]) => ConversationRecord[]) => void
  setGroups: (updater: (prev: ConversationGroupRecord[]) => ConversationGroupRecord[]) => void
} {
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [archivedConversations, setArchivedConversations] = useState<ConversationRecord[]>([])
  const [groups, setGroups] = useState<ConversationGroupRecord[]>([])
  const [conversationsUnread, setConversationsUnread] = useState<ListUnread>(null)
  const [archivedUnread, setArchivedUnread] = useState<ListUnread>(null)
  const [groupsUnread, setGroupsUnread] = useState<ListUnread>(null)
  // 三份各自「最后一次成功读到」属于哪个助手。§259 那条口径在这里的落地方式：
  // 刷新失败而上一份就是同一个助手的 ⇒ 保持（清空会把「刚归档完这一条」演成「整列消失」）；
  // 上一份属于别的助手 ⇒ 必须清空（留着会把别的助手的会话演成「这个助手本来就没有会话」）。
  const ownerRef = useRef<{ list: string | null; archived: string | null; groups: string | null }>({
    list: null,
    archived: null,
    groups: null
  })

  const reloadConversations = useCallback(
    (autoSelect = false): Promise<ConversationRecord[]> => {
      const aid = assistantIdRef.current
      // 这一发是"哪个助手的"就到此为止：切助手与流式收尾撞上时，旧助手那次的响应会晚到，
      // 而它要写的 state 现在属于新助手（§259 那条 `cancelled` 在同一族的真链路上撞过）
      const stale = (): boolean => assistantIdRef.current !== aid
      return Promise.all([
        window.pocketai.listConversations(aid, false, false),
        window.pocketai.listConversations(aid, false, true),
        window.pocketai.listConversationGroups(aid)
      ])
        .then(([list, archived, groupList]) => {
          if (stale()) return Array.isArray(list) ? list : []
          // 逐发判、逐发说（§257／§259 的口径）：一发读不到不许把另两发读到的那份一起扔了，
          // 也不许合并成一句「整列不可信」
          if (hasIpcFailed(list) || !Array.isArray(list)) {
            if (ownerRef.current.list !== aid) setConversations([])
            setConversationsUnread({ error: hasIpcFailed(list) ? list.error : undefined })
          } else {
            ownerRef.current.list = aid
            setConversationsUnread(null)
            setConversations(list)
          }
          if (hasIpcFailed(archived) || !Array.isArray(archived)) {
            if (ownerRef.current.archived !== aid) setArchivedConversations([])
            setArchivedUnread({ error: hasIpcFailed(archived) ? archived.error : undefined })
          } else {
            ownerRef.current.archived = aid
            setArchivedUnread(null)
            setArchivedConversations(archived)
          }
          if (hasIpcFailed(groupList) || !Array.isArray(groupList)) {
            if (ownerRef.current.groups !== aid) setGroups([])
            setGroupsUnread({ error: hasIpcFailed(groupList) ? groupList.error : undefined })
          } else {
            ownerRef.current.groups = aid
            setGroupsUnread(null)
            setGroups(groupList)
          }
          // 没读到就不自动挑：拿失败对象去 `list[0]` 是 undefined，选中的会话会凭空变成一条不存在的
          if (autoSelect && Array.isArray(list) && list.length > 0 && !currentConvRef.current) {
            onAutoSelect(list[0]!.id)
          }
          // 返回值给命令面板那条路用（`.then((list) => list.find(...)`），没读到就是空数组
          return Array.isArray(list) ? list : []
        })
        .catch((e: unknown) => {
          // reject 面（通道本身抛了）：三份都算没读到，清空仍按归属判
          reportIpcError('chat.listConversations')(e)
          if (stale()) return []
          const error = errText(e, '')
          if (ownerRef.current.list !== aid) setConversations([])
          setConversationsUnread({ error })
          if (ownerRef.current.archived !== aid) setArchivedConversations([])
          setArchivedUnread({ error })
          if (ownerRef.current.groups !== aid) setGroups([])
          setGroupsUnread({ error })
          return []
        })
    },
    [assistantIdRef, currentConvRef, onAutoSelect]
  )

  return {
    conversations,
    archivedConversations,
    groups,
    conversationsUnread,
    archivedUnread,
    groupsUnread,
    reloadConversations,
    setConversations,
    setArchivedConversations,
    setGroups
  }
}
