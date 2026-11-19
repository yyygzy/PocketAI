// 上下文超长自动恢复（v78 第 3 批）
//
// 为什么需要：窗口是按 token 估算裁出来的，估得再准也会遇到"服务端真实计数比估算大"
// 或"工具结果临时撑爆"的情况。云 API 对这类错误的回应是 400（context_length_exceeded），
// 而今天这条 400 不可重试 ⇒ 整轮直接失败。这里只做一件事：**识别 + 砍掉最早一轮再试一次**，
// 不做无限缩短（否则会把用户的问题本身也砍掉）。
import type { AdapterChatMessage } from '../providers/types'

/**
 * 各家云服务对"上下文超长"的报错文案（OpenAI / DeepSeek / Qwen / vLLM 系）。
 * 刻意不匹配裸的 "length"：那会撞上 `finish_reason=length` 之类的正常语义。
 */
export function isContextOverflowError(message: string): boolean {
  const m = String(message ?? '')
  return /context (?:length|window)|maximum context|prompt is too long|input (?:is )?too long|too many tokens|exceeds? the (?:model'?s )?(?:maximum|context)|reduce the length|token limit exceeded/i.test(
    m
  )
}

/**
 * 砍掉最早的一整轮对话（首个 user 起、到下一个 user 前）。
 * 返回是否真的砍了：只剩当前这一轮时返回 false——把用户的问题本身删掉等于没答。
 * 只切完整"轮"是为了不留下悬空的 assistant.tool_calls / tool 消息（端点会因此报 400）。
 * 直接原地修改数组：调用方正持有同一份 messages。
 */
export function trimOldestConversationTurn(messages: AdapterChatMessage[]): boolean {
  const firstUser = messages.findIndex((m) => m.role === 'user')
  if (firstUser < 0) return false
  const nextUser = messages.findIndex((m, i) => i > firstUser && m.role === 'user')
  if (nextUser < 0) return false
  messages.splice(firstUser, nextUser - firstUser)
  return true
}
