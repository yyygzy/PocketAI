// 零调用提示的会话壳状态（P4 批次 0 迁移）：判定抽到 agent-shared 的
// `shouldShowZeroToolCallNotice`，展示复用 `ZeroToolCallNotice`——两处都是唯一实现。
// 本 hook 只管「这一轮的结果怎么落到提示上」：亮/灭、被挡下的 MCP 工具数、切会话/关闭时收场。
import { useCallback, useState } from 'react'
import { shouldShowZeroToolCallNotice } from '../../components/agent/agent-shared'

export interface ZeroToolCallNoticeState {
  visible: boolean
  mcpHeldBack: number
  /** DONE 事件到货：按本轮 `usedTools` 与会话是否已有工具卡决定亮灭 */
  applyDone: (usedTools: boolean | undefined, mcpHeldBack: number | undefined, hasToolHistory: boolean) => void
  /** 用户点 ✕（也用于兼容旧壳的 setNoToolCallNotice） */
  setVisible: (visible: boolean) => void
  /** 切会话：提示与计数一起收回 */
  clear: () => void
}

export function useZeroToolCallNotice(): ZeroToolCallNoticeState {
  const [visible, setVisible] = useState(false)
  const [mcpHeldBack, setMcpHeldBack] = useState(0)
  const applyDone = useCallback(
    (usedTools: boolean | undefined, heldBack: number | undefined, hasToolHistory: boolean): void => {
      setVisible(shouldShowZeroToolCallNotice(usedTools, hasToolHistory))
      setMcpHeldBack(heldBack ?? 0)
    },
    []
  )
  const clear = useCallback((): void => {
    setVisible(false)
    setMcpHeldBack(0)
  }, [])
  return { visible, mcpHeldBack, applyDone, setVisible, clear }
}
