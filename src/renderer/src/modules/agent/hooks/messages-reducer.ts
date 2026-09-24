// Agent 对话消息流 reducer：把 SSE 风格的 step/chunk 事件归并进不可变消息数组
import type { AgentStepEvent } from '../../../../../shared/types'
import type { AgentMessage } from '../agent-shared'

export type MessagesAction =
  | { type: 'load'; messages: AgentMessage[] }
  | { type: 'clear' }
  | { type: 'append'; message: AgentMessage }
  | { type: 'step'; event: AgentStepEvent; unknownErrorText: string }
  | { type: 'chunk'; messageId: string; delta: string; reasoning?: boolean }

export function messagesReducer(prev: AgentMessage[], action: MessagesAction): AgentMessage[] {
  switch (action.type) {
    case 'load':
      return action.messages
    case 'clear':
      return []
    case 'append':
      return [...prev, action.message]
    case 'step': {
      const e = action.event
      if (e.type === 'thought' || e.type === 'final') {
        const idx = prev.findIndex((m) => m.id === e.messageId)
        if (idx !== -1) {
          // 已有占位消息：不可变更新 isFinal 标记
          const cur = prev[idx]!
          const updated: AgentMessage = { ...cur, isFinal: e.type === 'final' || cur.isFinal }
          return prev.map((m, i) => (i === idx ? updated : m))
        }
        if (e.messageId) {
          return [...prev, {
            id: e.messageId,
            role: 'assistant',
            text: e.text ?? '',
            stepIndex: e.stepIndex,
            isFinal: e.type === 'final'
          }]
        }
        return prev
      }
      if (e.type === 'tool_call') {
        return [...prev, {
          id: `step-${e.stepIndex}-call-${e.toolCall?.id}`,
          role: 'tool',
          text: '',
          toolCall: e.toolCall,
          stepIndex: e.stepIndex
        }]
      }
      if (e.type === 'tool_result') {
        return [...prev, {
          id: `step-${e.stepIndex}-res-${e.toolResult?.toolCallId}`,
          role: 'tool',
          text: e.toolResult?.content ?? '',
          toolResult: e.toolResult,
          isError: e.toolResult?.isError,
          stepIndex: e.stepIndex
        }]
      }
      if (e.type === 'todo' && e.todos) {
        // 任务清单：同一次运行内复用同一张卡片，每次 todo_write 整卡替换
        const id = `todos-${e.requestId}`
        const idx = prev.findIndex((m) => m.id === id)
        if (idx !== -1) {
          const updated: AgentMessage = { ...prev[idx]!, todos: e.todos }
          return prev.map((m, i) => (i === idx ? updated : m))
        }
        return [...prev, { id, role: 'assistant', text: '', todos: e.todos, stepIndex: e.stepIndex }]
      }
      if (e.type === 'replan') {
        // 重规划提示：纯文本提示条（无 DB 消息），渲染端按普通 assistant 文本显示
        return [...prev, {
          id: `replan-${e.requestId}-${e.stepIndex}`,
          role: 'assistant',
          text: `💡 ${e.text ?? ''}`,
          stepIndex: e.stepIndex
        }]
      }
      // error
      return [...prev, {
        id: `step-${e.stepIndex}-err`,
        role: 'assistant',
        text: `⚠️ ${e.error ?? action.unknownErrorText}`,
        isError: true,
        stepIndex: e.stepIndex
      }]
    }
    case 'chunk': {
      const idx = prev.findIndex((m) => m.id === action.messageId)
      if (idx === -1) return prev
      const cur = prev[idx]!
      const updated: AgentMessage = action.reasoning
        ? { ...cur, reasoning: (cur.reasoning ?? '') + action.delta }
        : { ...cur, text: (cur.text ?? '') + action.delta }
      return prev.map((m, i) => (i === idx ? updated : m))
    }
  }
}
