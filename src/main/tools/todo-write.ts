// todo_write 内置工具：LLM 在多步任务中维护一份完整任务清单（每次调用提交全量列表）。
// 事件流：emit AgentStepEvent(type='todo', todos) → 渲染端步骤化 checklist 卡片实时更新。
// 清单为运行级临时状态（不持久化 DB），工具本身无副作用，permission=auto。
import { IPC } from '../../shared/types'
import type { TodoItem } from '../../shared/types'
import type { BuiltinTool, ToolExecuteContext } from './builtin'

const MAX_TODOS = 50
const STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** 解析并规范化 LLM 提交的 todos：非法条目丢弃、非法 status 归一为 pending */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) throw new Error('todos 必须是数组，每项为 { content, status }')
  const out: TodoItem[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { content, status } = item as { content?: unknown; status?: unknown }
    if (typeof content !== 'string' || !content.trim()) continue
    out.push({
      content: content.trim().slice(0, 500),
      status: typeof status === 'string' && STATUSES.has(status) ? (status as TodoItem['status']) : 'pending'
    })
  }
  return out
}

export const todoWriteTool: BuiltinTool = {
  schema: {
    id: 'todo.write',
    name: 'todo_write',
    description:
      '维护任务清单（步骤化待办），用于向用户展示多步任务的执行进度。每次调用提交「完整列表」覆盖上一版。参数：todos (数组，每项 { content: string, status: "pending" | "in_progress" | "completed" })。建议在复杂任务开始时建立清单，每完成一步就更新对应项状态。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整任务列表，每项 { content, status }；status 取 pending/in_progress/completed',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务内容（一句话）' },
              status: { type: 'string', description: '状态：pending / in_progress / completed' }
            },
            required: ['content', 'status'],
            additionalProperties: false
          }
        }
      },
      required: ['todos'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 3_000 // 纯内存操作 + 本地事件
  },
  async execute(args, ctx?: ToolExecuteContext) {
    const todos = normalizeTodos(args?.todos)
    if (todos.length === 0) throw new Error('todos 不能为空（每项需含非空 content）')
    if (todos.length > MAX_TODOS) throw new Error(`任务数量超过上限 ${MAX_TODOS}`)

    if (ctx?.agent) {
      const { requestId, conversationId, emit, stepIndex } = ctx.agent
      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex: stepIndex ?? 0,
        type: 'todo',
        todos
      })
    }

    const completed = todos.filter((t) => t.status === 'completed').length
    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    return JSON.stringify({
      ok: true,
      total: todos.length,
      completed,
      inProgress,
      pending: todos.length - completed - inProgress
    })
  }
}
