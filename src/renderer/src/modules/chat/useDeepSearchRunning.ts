// 「深度检索中…」判定（V4-Iter-461 批次 2 删壳后恢复）
//
// 原先 `isDeepSearchRunning` 长在 `agent/agent-shared.ts`，唯一传参宿主是已删除的 Agent 壳。
// 恢复时落在 `chat/` 而不是回填 `agent-shared.ts`：现在唯一的宿主与消费者都是对话壳，
// 判定还要受 `agentMode` 约束并读联网搜索配置；回填进 agent 目录会制造「Agent 壳还在用」的错觉，
// 也会把一个只有对话壳调的 hook 塞进已无入口的模块。`agent-shared.ts` 只留仍被复用组件的纯工具。
//
// 三档语义与删壳前同构（`WebSearchConfig.depth`）：
//   deep  → 亮
//   quick → 灭
//   auto  → 看末步 `deepSearch`（= 模型给 web_search 传了 depth:"deep"）
import { useEffect, useState } from 'react'
import type { WebSearchDepthSetting } from '../../../../shared/types'
import type { LiveStep } from '../agent/agent-shared'
import { logIpcError } from '../../utils/ipc'

/** 纯判定：单一实现，ChatView 只负责把结果传给 `AgentLiveStepStrip.deepSearchRunning` */
export function judgeDeepSearchRunning(
  running: boolean,
  step: LiveStep | undefined,
  depth: WebSearchDepthSetting
): boolean {
  if (!running || !step || step.type !== 'tool_call' || step.toolName !== 'web_search') return false
  if (depth === 'deep') return true
  if (depth === 'quick') return false
  return step.deepSearch === true
}

/**
 * 对话壳用的判定 hook：只在「Agent 模式 + 运行中 + 末步是 web_search」时才读配置，
 * 其余场景一律 false 且不发 IPC（普通对话不碰联网搜索配置）。
 */
export function useDeepSearchRunning(args: {
  agentMode: boolean
  running: boolean
  steps: LiveStep[] | undefined
}): boolean {
  const { agentMode, running, steps } = args
  const last = steps && steps.length > 0 ? steps[steps.length - 1] : undefined
  const candidate =
    agentMode && running && last?.type === 'tool_call' && last.toolName === 'web_search'
  const [depth, setDepth] = useState<WebSearchDepthSetting | null>(null)

  useEffect(() => {
    if (!candidate) return
    let alive = true
    window.pocketai
      .getWebSearchConfig()
      .then((cfg) => {
        if (alive) setDepth(cfg.depth)
      })
      .catch((e) => {
        // 读不到就按 auto：不阻断运行提示，也不假装 deep
        logIpcError('chat.deepSearch.websearchConfig', e)
        if (alive) setDepth('auto')
      })
    return () => {
      alive = false
    }
  }, [candidate, last?.stepIndex])

  if (!candidate) return false
  // 配置还没回来时先按 auto（此时通常也还没到 deep 档的可见时机）
  return judgeDeepSearchRunning(running, last, depth ?? 'auto')
}
