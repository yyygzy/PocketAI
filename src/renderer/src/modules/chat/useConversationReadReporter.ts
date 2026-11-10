// B-4：会话读态上报。
//
// D3 口径里「读」是一个合取条件：窗口聚焦 && 该会话可见 && 未锁屏。渲染端只负责如实上报前两项
// （`document.hasFocus()` / `!document.hidden`），锁屏由主进程用 lockService 再判一次——
// 多窗口（主窗、独立对话窗）各自上报自己的，主进程只要有一扇窗真在读就算已读。
//
// 触发点：会话切换、窗口 focus/blur、页面可见性变化、锁屏状态变化（解锁后要重新上报，
// 否则「锁屏期间不消」会变成「解锁后永远不消」）。卸载/切走时报 conversationId=null，别占着读态。
import { useEffect } from 'react'
import { useConversationRuntimeStore } from '../../store/conversation-runtime-store'
import { hasIpcFailed, logIpcError, reportIpcError } from '../../utils/ipc'

export function useConversationReadReporter(conversationId: string | null): void {
  useEffect(() => {
    let disposed = false
    const send = (id: string | null): void => {
      if (disposed) return
      window.pocketai
        .reportConversationReadState({
          conversationId: id,
          focused: document.hasFocus(),
          visible: !document.hidden
        })
        .then((r) => {
          if (hasIpcFailed(r)) {
            logIpcError('chat.reportReadState', r.error)
            return
          }
          // 主进程回的才是真相（锁屏时它给 null＝问不到，保持现状）；
          // 拿它对齐本地镜像，避免和「聚焦时取快照」那一发赛跑留下过期圆点。
          if (!id || typeof r.unread !== 'boolean') return
          useConversationRuntimeStore.getState().apply({
            kind: 'unread',
            conversationId: id,
            unread: r.unread,
            at: Date.now()
          })
        })
        .catch(reportIpcError('chat.reportReadState'))
    }

    send(conversationId)
    const onFocus = (): void => send(conversationId)
    const onBlur = (): void => send(conversationId)
    const onVisibility = (): void => send(conversationId)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    // 解锁后重新上报：主进程在锁屏期间拒绝清读，不给它这一次事件就永远等不到「聚焦才清」
    const offLock = window.pocketai.onLockStateChange(() => send(conversationId))

    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      offLock()
      // 切走/模块卸载：告诉主进程「这扇窗没有会话可见了」，别让它继续按已读对待
      window.pocketai
        .reportConversationReadState({ conversationId: null, focused: false, visible: false })
        .then((r) => {
          if (hasIpcFailed(r)) logIpcError('chat.reportReadState', r.error)
        })
        .catch(reportIpcError('chat.reportReadState'))
    }
  }, [conversationId])
}
