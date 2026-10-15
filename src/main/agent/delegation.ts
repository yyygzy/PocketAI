// 建子会话 + 组装子 run 的 payload（V4-Iter-144）
//
// 纯规则（角色枚举、预算、工具面裁剪、参数校验）都在 `shared/delegation-rules.ts`，
// 这里只留**必须碰库**的那一步。分家的理由写在那份文件的开头（工具注册表也被迫拉起 electron 链）。
//
// 本模块**不许 import agentEngine**：engine 要 import 这里，会成环；真正跑子 run 的是 engine。
import { randomUUID } from 'node:crypto'
import { conversationRepo } from '../db/repositories/conversation.repo'
import type { ChatTarget, SendMessagePayload } from '../../shared/types'
import { ROLE_BRIEF, type DelegateRole } from '../../shared/delegation-rules'

export interface ChildRunPlan {
  childConversationId: string
  payload: SendMessagePayload
}

/**
 * 建子会话 + 组装子 run 的 payload。
 * 同模型换帽子（144 只做顺序形态）：`target` 沿用父的那一个 provider+model，
 * 跨模型角色要等 145 的容量判据（`rolesMayUseDistinctModels`）放行。
 */
export function planChildRun(input: {
  parentConversationId: string
  assistantId: string | null
  role: DelegateRole
  task: string
  target: ChatTarget
}): ChildRunPlan {
  const child = conversationRepo.create({
    assistantId: input.assistantId,
    title: `子代理 · ${input.role}`,
    modelLabel: `agent:${input.target.providerId}:${input.target.model}`,
    parentConversationId: input.parentConversationId,
    roleKey: input.role
  })
  const payload: SendMessagePayload = {
    requestId: randomUUID(),
    conversationId: child.id,
    assistantId: input.assistantId,
    content: `${ROLE_BRIEF[input.role]}\n\n任务：${input.task}`,
    targets: [input.target],
    agentMode: true,
    // 无人值守是第二道保险：confirm 类已经在 childToolSurface 里被摘掉了，万一模型凭空调一个，
    // 让它明确失败，而不是挂起等一个永远不会来的弹窗。
    unattended: true
  }
  return { childConversationId: child.id, payload }
}
