// memory_save 内置工具测试：LLM 主动记忆写入（去重 / 截断 / 入参校验）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMock = vi.fn(() => [] as Array<{ id: string; content: string; createdAt: number; updatedAt: number }>)
const addMock = vi.fn()

vi.mock('../src/main/db/repositories/user-memory.repo', () => ({
  userMemoryRepo: {
    list: (...args: unknown[]) => listMock(...(args as [])),
    add: (...args: unknown[]) => addMock(...(args as [string]))
  }
}))

import { memorySaveTool } from '../src/main/tools/memory-save'

describe('memory_save 工具', () => {
  beforeEach(() => {
    listMock.mockClear()
    addMock.mockClear()
    listMock.mockImplementation(() => [])
  })

  it('schema：名称/权限/参数定义正确', () => {
    expect(memorySaveTool.schema.name).toBe('memory_save')
    expect(memorySaveTool.schema.permission).toBe('auto')
    expect(memorySaveTool.schema.parameters.required).toEqual(['content'])
  })

  it('保存新记忆：调用 repo.add 并返回 ok', async () => {
    addMock.mockImplementation(() => ({ id: 'm1', content: '用户偏好简洁回复', createdAt: 1, updatedAt: 1 }))
    const out = JSON.parse(await memorySaveTool.execute({ content: '用户偏好简洁回复' }))
    expect(out.ok).toBe(true)
    expect(out.id).toBe('m1')
    expect(addMock).toHaveBeenCalledWith('用户偏好简洁回复')
  })

  it('完全重复的内容：跳过保存返回 duplicate', async () => {
    listMock.mockImplementation(() => [{ id: 'm1', content: '已有记忆', createdAt: 1, updatedAt: 1 }])
    const out = JSON.parse(await memorySaveTool.execute({ content: '已有记忆' }))
    expect(out.ok).toBe(true)
    expect(out.duplicate).toBe(true)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('空内容 / 纯空白 / 非字符串 → 抛错', async () => {
    await expect(memorySaveTool.execute({ content: '' })).rejects.toThrow()
    await expect(memorySaveTool.execute({ content: '   ' })).rejects.toThrow()
    await expect(memorySaveTool.execute({ content: 123 })).rejects.toThrow()
    await expect(memorySaveTool.execute({})).rejects.toThrow()
  })

  it('保存前 trim，首尾空白不落库', async () => {
    addMock.mockImplementation(() => ({ id: 'm2', content: 'X', createdAt: 1, updatedAt: 1 }))
    await memorySaveTool.execute({ content: '  X  ' })
    expect(addMock).toHaveBeenCalledWith('X')
  })

  it('超 500 字符截断到 500', async () => {
    addMock.mockImplementation(() => ({ id: 'm3', content: 'x', createdAt: 1, updatedAt: 1 }))
    await memorySaveTool.execute({ content: 'y'.repeat(600) })
    expect(addMock).toHaveBeenCalledWith('y'.repeat(500))
  })
})
