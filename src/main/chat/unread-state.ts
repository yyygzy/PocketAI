// 会话未读（B-4 / D3）。
//
// 事实源只有一处：`conversations.unread`（v61）。本模块只做两件事——
//   1) 助手一轮正常结束时，按 D3 口径决定要不要把它标成未读；
//   2) 接收渲染端的「读态上报」，在「窗口聚焦 + 会话可见 + 未锁屏」时清未读。
// 事件是这一列的投影，走 `CHAT_RUNTIME_STATE_EVENT` 同一条订阅（不另开通道），
// 因此渲染端不需要自己再推一遍「未读 = 最后一条是不是助手」。
//
// D3 口径落点：
// - 只有助手消息算未读：唯一触发点是 run 正常结束（markRunFinished 'done'）；
//   用户自己发消息不经过这里，失败/中止/中断由既有角标表达，不重复记未读。
// - 打开会话不算已读：清读只认渲染端上报的 focused && visible（且主进程再验一次未锁屏）。
// - 锁屏期间不算已读：clear 前查 lockService；锁着时即便窗口还「聚焦」也不清。
// - 子会话不参与侧栏未读：父会话非空一律不标记（侧栏本来也过滤子会话）。
import { conversationRepo } from '../db/repositories/conversation.repo'
import { lockService } from '../lock/lock'
import { createLogger } from '../logger'
import { publishConversationState } from './runtime-registry'
import type { ChatReadStateReport, ChatUnreadEvent } from '../../shared/types'

const logger = createLogger('unread')

interface ReaderState {
  conversationId: string | null
  focused: boolean
  visible: boolean
}

/** webContentsId → 该窗口当前显示的会话与焦点/可见性（由渲染端上报） */
const readers = new Map<number, ReaderState>()

function isLocked(): boolean {
  return lockService.getStatus().state === 'locked'
}

/** 有没有任何一扇窗「真正在读」这个会话：聚焦 + 可见 + 未锁屏 */
export function isConversationBeingRead(conversationId: string): boolean {
  if (isLocked()) return false
  for (const r of readers.values()) {
    if (r.conversationId === conversationId && r.focused && r.visible) return true
  }
  return false
}

/**
 * 收下渲染端的读态上报。只有同时满足「有会话 + 聚焦 + 可见 + 未锁屏」才尝试清未读；
 * `clearUnread` 自带 `unread=1` 守卫，所以重复聚焦不会产生写放大，也不会重复广播。
 * @returns 该会话在本次上报后的未读真相；null＝此刻问不到（锁屏时库是关的，渲染端跳过对齐）
 */
export function reportReadState(webContentsId: number, report: ChatReadStateReport): boolean | null {
  readers.set(webContentsId, {
    conversationId: report.conversationId,
    focused: report.focused,
    visible: report.visible
  })
  const conversationId = report.conversationId
  if (!conversationId) return null
  // 锁屏期间库已关闭，不去碰它；也不清未读（D3：锁屏不算已读）
  if (isLocked()) return null
  try {
    if (report.focused && report.visible && conversationRepo.clearUnread(conversationId)) {
      publishConversationState({
        kind: 'unread',
        conversationId,
        unread: false,
        at: Date.now()
      })
    }
    return conversationRepo.isUnread(conversationId)
  } catch (e) {
    logger.warn(`读态上报失败 ${conversationId}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** 窗口销毁/卸载时丢掉它的读态，避免已关闭的窗口一直「占着」已读身份 */
export function forgetReadState(webContentsId: number): void {
  readers.delete(webContentsId)
}

/** 快照里的未读部分（重启后从这里恢复：列还在，未读就还在）。
 *  锁屏时库是关的：取不到就返回空表（这次快照不含未读，解锁后的聚焦会重新对齐）。 */
export function listUnreadEvents(): ChatUnreadEvent[] {
  const at = Date.now()
  try {
    return conversationRepo.listUnreadIds().map((conversationId) => ({
      kind: 'unread' as const,
      conversationId,
      unread: true,
      at
    }))
  } catch (e) {
    logger.warn(`读取未读快照失败: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/**
 * 助手一轮正常结束：按 D3 标记未读。
 * - 子会话不参与侧栏未读，直接跳过；
 * - 该会话正在被某扇聚焦且可见的窗口读着 → 不标（避免未读圆点闪一下再被清）；
 * - 未读是旁路：写库失败只记日志，不能影响运行收尾。
 */
export function markConversationUnread(conversationId: string): void {
  try {
    const conv = conversationRepo.get(conversationId)
    if (!conv || conv.parentConversationId) return
    if (isConversationBeingRead(conversationId)) return
    if (!conversationRepo.markUnread(conversationId)) return
    publishConversationState({
      kind: 'unread',
      conversationId,
      unread: true,
      at: Date.now()
    })
  } catch (e) {
    logger.warn(`标记会话未读失败 ${conversationId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 测试用：清空读态表 */
export function resetUnreadStateForTest(): void {
  readers.clear()
}
