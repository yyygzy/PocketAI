// 用户记忆设置面板（V4 记忆可追溯第二轮）：
//   · 每条显示来源与写入时间，Agent 条目能找到会话才显示「来自会话」；
//   · 已删除视图可恢复，恢复失败（含达上限）留在面板内；
//   · 批量物理清理必须二次确认并说明不可撤回；
//   · 接近/达到 1000 条时显示当前数量与上限，达到后输入与添加不可用。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { UserMemoryPanel } from '../src/renderer/src/modules/settings/UserMemoryPanel'
import { MEMORY_MAX_ROWS } from '../src/shared/schemas/memory'
import { zh } from '../src/renderer/src/i18n/zh'
import type { UserMemoryRecord } from '../src/shared/types'

// 上限规则本身在共享 schema；组件用例把上限压到 10，避免为了验证禁用态渲染 1000 个节点
vi.mock('../src/shared/schemas/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/schemas/memory')>()
  return { ...actual, MEMORY_MAX_ROWS: 10 }
})

const BASE_TS = 1760000000000

const rec = (over: Partial<UserMemoryRecord> = {}): UserMemoryRecord => ({
  id: 'm1',
  content: '一条记忆',
  source: 'user',
  conversationId: null,
  deletedAt: null,
  createdAt: BASE_TS,
  updatedAt: BASE_TS,
  ...over
})

const many = (n: number): UserMemoryRecord[] =>
  Array.from({ length: n }, (_, i) => rec({ id: `m${i}`, content: `记忆 ${i}` }))

describe('来源、写入时间与会话指向', () => {
  it('三种来源与写入时间都显示；能读到会话时给出来源会话', async () => {
    stubPocketai({
      listMemories: () => [
        rec({ id: 'a', content: 'Agent 记下的偏好', source: 'agent', conversationId: 'c1' }),
        rec({ id: 'l', content: '迁移前的记忆', source: 'legacy' }),
        rec({ id: 'u', content: '我手写的记忆', source: 'user' })
      ],
      listDeletedMemories: () => [],
      listConversations: (_assistantId?: unknown, _isAgent?: unknown, archivedOnly?: boolean) =>
        archivedOnly ? [] : [{ id: 'c1', title: '规划会话' }]
    })
    mountWithProviders(<UserMemoryPanel />)

    expect(await screen.findByText(zh['set.memorySource.agent'])).toBeTruthy()
    expect(screen.getByText(zh['set.memorySource.legacy'])).toBeTruthy()
    expect(screen.getByText(zh['set.memorySource.user'])).toBeTruthy()
    expect(await screen.findByText(zh['set.memoryFromConversation'].replace('{title}', '规划会话'))).toBeTruthy()
    expect(screen.getAllByText(/写入于 /)).toHaveLength(3)
  })

  it('会话读不到时不显示指向，也不造「无来源」空态', async () => {
    stubPocketai({
      listMemories: () => [
        rec({ id: 'a', content: 'Agent 记下的偏好', source: 'agent', conversationId: 'missing' })
      ],
      listDeletedMemories: () => [],
      listConversations: () => []
    })
    mountWithProviders(<UserMemoryPanel />)

    expect(await screen.findByText(zh['set.memorySource.agent'])).toBeTruthy()
    await waitFor(() => expect(pocketaiCalls().filter((c) => c.fn === 'listConversations')).toHaveLength(2))
    expect(screen.queryByText(/来自会话/)).toBeNull()
  })
})

describe('行数上限在界面上可知', () => {
  it('接近上限显示当前数量与上限，仍可继续添加', async () => {
    stubPocketai({ listMemories: () => many(Math.ceil(MEMORY_MAX_ROWS * 0.8)), listDeletedMemories: () => [] })
    mountWithProviders(<UserMemoryPanel />)

    const limit = await screen.findByTestId('user-memory-limit')
    expect(limit.textContent).toContain(String(Math.ceil(MEMORY_MAX_ROWS * 0.8)))
    expect(limit.textContent).toContain(String(MEMORY_MAX_ROWS))
    expect((screen.getByPlaceholderText(zh['set.memoryPlaceholder']) as HTMLInputElement).disabled).toBe(false)
  })

  it('达到上限时输入与添加都不可用', async () => {
    stubPocketai({ listMemories: () => many(MEMORY_MAX_ROWS), listDeletedMemories: () => [] })
    mountWithProviders(<UserMemoryPanel />)

    const limit = await screen.findByTestId('user-memory-limit')
    expect(limit.textContent).toContain(String(MEMORY_MAX_ROWS))
    expect((screen.getByPlaceholderText(zh['set.memoryPlaceholder']) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh['common.add'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('已删除视图：恢复与失败原因', () => {
  it('达到上限时不调用恢复，并在面板内说明原因', async () => {
    stubPocketai({
      listMemories: () => many(MEMORY_MAX_ROWS),
      listDeletedMemories: () => [rec({ id: 'd1', content: '删掉的记忆', deletedAt: BASE_TS + 1 })]
    })
    mountWithProviders(<UserMemoryPanel />)

    fireEvent.click(await screen.findByTestId('user-memory-tab-deleted'))
    fireEvent.click(await screen.findByRole('button', { name: zh['set.memoryRestore'] }))

    await waitFor(() =>
      expect(screen.getByTestId('user-memory-action-error').textContent).toContain(
        zh['set.memoryRestoreAtLimit'].replace('{max}', String(MEMORY_MAX_ROWS))
      )
    )
    expect(pocketaiCalls().some((c) => c.fn === 'restoreMemory')).toBe(false)
  })

  it('恢复失败的原因落在面板内（不是几秒就消失的提示）', async () => {
    stubPocketai({
      listMemories: () => [rec()],
      listDeletedMemories: () => [rec({ id: 'd1', content: '删掉的记忆', deletedAt: BASE_TS + 1 })],
      restoreMemory: () => ({ ok: false, error: '记忆条目不存在或未被删除' })
    })
    mountWithProviders(<UserMemoryPanel />)

    fireEvent.click(await screen.findByTestId('user-memory-tab-deleted'))
    fireEvent.click(await screen.findByRole('button', { name: zh['set.memoryRestore'] }))

    await waitFor(() =>
      expect(screen.getByTestId('user-memory-action-error').textContent).toContain(
        zh['set.memoryRestoreFailed'].replace('{msg}', '记忆条目不存在或未被删除')
      )
    )
  })
})

describe('批量清理：二次确认与不可撤回', () => {
  it('选中后先出确认，确认才发物理删除且带全部 id', async () => {
    stubPocketai({
      listMemories: () => [],
      listDeletedMemories: () => [
        rec({ id: 'd1', content: '删掉一', deletedAt: BASE_TS + 1 }),
        rec({ id: 'd2', content: '删掉二', deletedAt: BASE_TS + 2 })
      ],
      purgeMemories: () => ({ ok: true, deleted: 2 })
    })
    mountWithProviders(<UserMemoryPanel />)

    fireEvent.click(await screen.findByTestId('user-memory-tab-deleted'))
    await screen.findByText(zh['set.memorySelectAll'])
    // 第一颗是「全选」，后面两颗是条目复选框
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    const purge = await screen.findByTestId('user-memory-purge')
    expect(purge.textContent).toContain('2')
    fireEvent.click(purge)

    expect(
      await screen.findByText(zh['set.memoryPurgeConfirm'].replace('{count}', '2'))
    ).toBeTruthy()
    expect(pocketaiCalls().some((c) => c.fn === 'purgeMemories')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: zh['set.memoryPurgeConfirmAction'] }))
    await waitFor(() =>
      expect(pocketaiCalls().find((c) => c.fn === 'purgeMemories')?.args[0]).toEqual(['d1', 'd2'])
    )
  })
})
