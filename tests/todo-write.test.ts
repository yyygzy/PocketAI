// todo_write 内置工具测试
// 覆盖：normalizeTodos 规范化、事件 emit、统计返回、边界与异常
import { describe, it, expect, vi } from 'vitest'
import { todoWriteTool, normalizeTodos } from '../src/main/tools/todo-write'
import { IPC } from '../src/shared/types'
import type { AgentStepEvent } from '../src/shared/types'

function makeCtx() {
  const emit = vi.fn()
  return {
    emit,
    agent: { requestId: 'req1', conversationId: 'conv1', emit, stepIndex: 3 }
  }
}

describe('normalizeTodos — 清单规范化', () => {
  it('有效条目保留，status 白名单校验', () => {
    expect(
      normalizeTodos([
        { content: '读文件', status: 'completed' },
        { content: '写报告', status: 'in_progress' },
        { content: '复查', status: 'pending' }
      ])
    ).toEqual([
      { content: '读文件', status: 'completed' },
      { content: '写报告', status: 'in_progress' },
      { content: '复查', status: 'pending' }
    ])
  })

  it('非法/缺失 status 归一为 pending，大写也归一为 pending', () => {
    expect(
      normalizeTodos([
        { content: 'a', status: 'COMPLETED' },
        { content: 'b', status: 'nonsense' },
        { content: 'c' }
      ])
    ).toEqual([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' }
    ])
  })

  it('空白 content、非对象条目被丢弃，content trim 并截断 500 字符', () => {
    const long = 'x'.repeat(600)
    const out = normalizeTodos([
      { content: '   ', status: 'pending' },
      '不是对象',
      null,
      { content: long, status: 'pending' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('x'.repeat(500))
  })

  it('非数组输入 → 抛错', () => {
    expect(() => normalizeTodos('todos')).toThrow('todos 必须是数组')
    expect(() => normalizeTodos(null)).toThrow('todos 必须是数组')
  })
})

describe('todo_write 工具 execute', () => {
  it('正常执行：emit todo 步骤事件并返回统计 JSON', async () => {
    const { emit, agent } = makeCtx()
    const out = await todoWriteTool.execute(
      { todos: [{ content: '检索资料', status: 'completed' }, { content: '撰写答案', status: 'in_progress' }] },
      { agent }
    )
    expect(JSON.parse(out)).toEqual({ ok: true, total: 2, completed: 1, inProgress: 1, pending: 0 })
    expect(emit).toHaveBeenCalledTimes(1)
    const [channel, payload] = emit.mock.calls[0]! as unknown as [string, AgentStepEvent]
    expect(payload).toMatchObject({
      requestId: 'req1',
      conversationId: 'conv1',
      stepIndex: 3,
      type: 'todo'
    })
    expect(payload.todos).toEqual([
      { content: '检索资料', status: 'completed' },
      { content: '撰写答案', status: 'in_progress' }
    ])
    // 确认走的是 Agent 步骤事件通道
    expect(channel).toBe(IPC.AGENT_STEP_EVENT)
  })

  it('无 agent 上下文（防御路径）→ 不 emit，仍返回统计', async () => {
    const out = await todoWriteTool.execute({ todos: [{ content: 'a', status: 'pending' }] })
    expect(JSON.parse(out)).toEqual({ ok: true, total: 1, completed: 0, inProgress: 0, pending: 1 })
  })

  it('空 todos / 过滤后为空 → 抛错', async () => {
    await expect(todoWriteTool.execute({ todos: [] }, makeCtx())).rejects.toThrow('todos 不能为空')
    await expect(
      todoWriteTool.execute({ todos: [{ content: '  ' }] }, makeCtx())
    ).rejects.toThrow('todos 不能为空')
  })

  it('超过 50 条 → 抛错', async () => {
    const todos = Array.from({ length: 51 }, (_, i) => ({ content: `t${i}`, status: 'pending' }))
    await expect(todoWriteTool.execute({ todos }, makeCtx())).rejects.toThrow('超过上限 50')
  })

  it('todos 缺失 → 抛错', async () => {
    await expect(todoWriteTool.execute({}, makeCtx())).rejects.toThrow()
  })
})
