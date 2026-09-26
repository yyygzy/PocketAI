// Agent 对话消息流 reducer：把 SSE 风格的 step/chunk 事件归并进不可变消息数组
import type { AgentStepEvent } from '../../../../../shared/types'
import type { AgentMessage } from '../agent-shared'

export type MessagesAction =
  | { type: 'load'; messages: AgentMessage[] }
  | { type: 'clear' }
  | { type: 'append'; message: AgentMessage }
  | { type: 'delete'; id: string }
  | { type: 'truncateFrom'; id: string }
  | { type: 'step'; event: AgentStepEvent; unknownErrorText: string }
  | { type: 'chunk'; messageId: string; delta: string; reasoning?: boolean }
  | { type: 'setSources'; messageId: string; sources: AgentMessage['sources'] }

export function messagesReducer(prev: AgentMessage[], action: MessagesAction): AgentMessage[] {
  switch (action.type) {
    case 'load':
      return action.messages
    case 'clear':
      return []
    case 'append':
      return [...prev, action.message]
    case 'delete': {
      // 删除单条消息：tool_call/tool_result 同源卡片按 dbId 或 toolCallId 配对一起删
      const target = prev.find((m) => m.id === action.id)
      if (!target) return prev
      const dbId = target.dbId
      const tcId = target.toolResult?.toolCallId ?? target.toolCall?.id
      return prev.filter((m) => {
        if (m.id === action.id) return false
        if (dbId && m.dbId === dbId) return false
        if (tcId && (m.toolCall?.id === tcId || m.toolResult?.toolCallId === tcId)) return false
        return true
      })
    }
    case 'truncateFrom': {
      // 截断重跑：保留目标消息之前的内容，目标及其后所有卡片移除（消息按时间有序）
      const idx = prev.findIndex((m) => m.id === action.id)
      return idx === -1 ? prev : prev.slice(0, idx)
    }
    case 'step': {
      const e = action.event
      // 用户消息已持久化：回填最近一条本地占位用户卡的 dbId（供删除单条消息）
      if (e.type === 'user' && e.messageId) {
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i]!
          if (m.role === 'user' && !m.dbId) {
            return prev.map((x, j) => (j === i ? { ...x, dbId: e.messageId } : x))
          }
        }
        return prev
      }
      if (e.type === 'thought' || e.type === 'final') {
        const idx = prev.findIndex((m) => m.id === e.messageId)
        if (idx !== -1) {
          // 已有占位消息：不可变更新文本与 isFinal 标记
          // text 更新场景：占位清理（错误/中止提示）、空响应重试提示、流式结束完整文本
          const cur = prev[idx]!
          const updated: AgentMessage = {
            ...cur,
            text: e.text ?? cur.text,
            isFinal: e.type === 'final' || cur.isFinal,
            dbId: e.messageId ?? cur.dbId
          }
          return prev.map((m, i) => (i === idx ? updated : m))
        }
        if (e.messageId) {
          return [...prev, {
            id: e.messageId,
            role: 'assistant',
            text: e.text ?? '',
            stepIndex: e.stepIndex,
            isFinal: e.type === 'final',
            dbId: e.messageId
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
          stepIndex: e.stepIndex,
          dbId: e.messageId
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
        stepIndex: e.stepIndex,
        dbId: e.messageId
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
    case 'setSources': {
      const idx = prev.findIndex((m) => m.id === action.messageId)
      if (idx === -1) return prev
      return prev.map((m, i) => (i === idx ? { ...m, sources: action.sources } : m))
    }
  }
}
