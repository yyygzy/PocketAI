// @vitest-environment jsdom
// P1-5 第二刀：流程模板面板的导入确认与模板管理。
//
// 钉住的语义（都能真失败）：
//  · 导入后把用户带到确认清单：模板用过的工具逐项列出，本机没有的标"缺失"；
//  · 一条授权都没确认时套用被拦，且**不产生任何写操作**；
//  · 缺失引用在点套用之前就列出来（不是失败后才说）；
//  · 逐项勾选后确认结果落到模板的授权字段，套用才放行；
//  · 改名空名不落库、重名先给一次可理解的确认。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { RunbookPanel } from '../src/renderer/src/modules/chat/RunbookPanel'
import type { RunbookRecord } from '../src/shared/runbook'
import type { ToolPolicyEntry, ToolPolicySnapshot } from '../src/shared/types'

const tool = (over: Partial<ToolPolicyEntry>): ToolPolicyEntry => ({
  id: 'shell.exec',
  name: 'shell_exec',
  source: 'builtin',
  permission: 'auto',
  state: 'available',
  dynamic: false,
  reasons: [],
  granted: true,
  ...over
})

/** 本机注册表：只有 shell.exec / kb.search；`mcp:old:gone` 不存在（模拟跨机导入） */
const policy = (over: Partial<ToolPolicySnapshot> = {}): ToolPolicySnapshot => ({
  tools: [tool({}), tool({ id: 'kb.search', name: 'kb_search' })],
  shell: { enabled: false, policy: 'confirm', confirmReasons: [], denyReasons: [] },
  assistant: {
    id: 'asst-1',
    name: '默认助手',
    isBuiltin: true,
    permissions: ['*'],
    emptyPermissions: false,
    loadSkillAvailable: true,
    tools: [tool({}), tool({ id: 'kb.search', name: 'kb_search' })]
  },
  mcpStoppedServers: 0,
  ...over
})

const rec = (over: Partial<RunbookRecord> = {}): RunbookRecord => ({
  id: 'rb-1',
  name: '每周巡检',
  promptSummary: '检查昨天的构建日志并汇总失败项',
  steps: [
    { toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] },
    { toolName: 'kb_search', toolId: 'kb.search', argKeys: ['query'] }
  ],
  refs: [],
  toolPermissions: [],
  createdAt: 1,
  updatedAt: 2,
  ...over
})

const openPanel = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId('runbook-entry'))
  await waitFor(() => expect(screen.getByTestId('runbook-panel')).toBeTruthy())
}

describe('导入后的授权确认', () => {
  it('导入后列出模板用过的工具、标出本机缺失，未确认时套用被拦且不写库', async () => {
    const imported = rec({
      steps: [
        { toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] },
        { toolName: 'mcp_old_gone', toolId: 'mcp:old:gone', argKeys: [] }
      ]
    })
    let stored: RunbookRecord[] = []
    const updateRunbook = vi.fn()
    const onApply = vi.fn()
    stubPocketai({
      listRunbooks: () => stored,
      importRunbooks: () => ({
        ok: true,
        imported: 1,
        skipped: 0,
        droppedTools: 2,
        droppedRefs: 0,
        ids: [imported.id]
      }),
      getToolPolicy: () => policy(),
      checkRunbook: () => ({ missingRefs: [] }),
      updateRunbook
    })
    mountWithProviders(<RunbookPanel onApply={onApply} assistantId="asst-1" />)
    await openPanel()

    fireEvent.click(screen.getByTestId('runbook-import'))
    stored = [imported]
    // 导入后重新 list 才能看到新模板：第一次读发生在上面的 openPanel
    await waitFor(() => expect(screen.getByTestId('runbook-import-guide')).toBeTruthy())

    expect(screen.getByTestId('runbook-import-guide').textContent).toContain('1')
    expect(screen.getByTestId('runbook-item-pending')).toBeTruthy()

    const boxes = screen.getAllByTestId('runbook-tool')
    expect(boxes).toHaveLength(2)
    // 本机没有的工具：标缺失、复选框不可点
    const missingBox = boxes.find((b) => b.getAttribute('data-tool-id') === 'mcp:old:gone')!
    expect(missingBox.getAttribute('data-available')).toBe('0')
    expect((missingBox as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('runbook-tool-missing').textContent).toContain('缺失')

    fireEvent.click(screen.getByTestId('runbook-apply'))
    await waitFor(() => expect(screen.getByTestId('runbook-blocked')).toBeTruthy())
    expect(onApply).not.toHaveBeenCalled()
    expect(updateRunbook).not.toHaveBeenCalled()
  })

  it('逐项勾选后确认结果落到模板授权字段，套用才放行', async () => {
    let stored = rec()
    const updateRunbook = vi.fn((patch: { id: string; toolPermissions: string[] }) => {
      stored = { ...stored, toolPermissions: [...patch.toolPermissions] }
      return stored
    })
    const onApply = vi.fn()
    stubPocketai({
      listRunbooks: () => [stored],
      getToolPolicy: () => policy(),
      checkRunbook: () => ({ missingRefs: [] }),
      updateRunbook
    })
    mountWithProviders(<RunbookPanel onApply={onApply} assistantId="asst-1" />)
    await openPanel()

    // 未确认：拦下，且没有写操作
    fireEvent.click(screen.getByTestId('runbook-apply'))
    await waitFor(() => expect(screen.getByTestId('runbook-blocked')).toBeTruthy())
    expect(onApply).not.toHaveBeenCalled()
    expect(pocketaiCalls().map((c) => c.fn)).not.toContain('updateRunbook')

    // 逐项勾选：每一勾都落库（先落库再在本地生效）
    const boxes = screen.getAllByTestId('runbook-tool')
    fireEvent.click(boxes[0]!)
    await waitFor(() =>
      expect(updateRunbook).toHaveBeenLastCalledWith({ id: 'rb-1', toolPermissions: ['shell.exec'] })
    )
    fireEvent.click(boxes[1]!)
    await waitFor(() =>
      expect(updateRunbook).toHaveBeenLastCalledWith({
        id: 'rb-1',
        toolPermissions: ['shell.exec', 'kb.search']
      })
    )

    fireEvent.click(screen.getByTestId('runbook-apply'))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith('检查昨天的构建日志并汇总失败项', undefined))
  })

  it('开关打开：套用交出"本机可用且已勾选"的本轮授权（缺失工具不进 grant）', async () => {
    const stored = rec({
      steps: [
        { toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] },
        { toolName: 'mcp_old_gone', toolId: 'mcp:old:gone', argKeys: [] }
      ],
      toolPermissions: ['shell.exec']
    })
    const onApply = vi.fn()
    stubPocketai({
      listRunbooks: () => [stored],
      getToolPolicy: () => policy({ perRunGrantEnabled: true }),
      checkRunbook: () => ({ missingRefs: [] })
    })
    mountWithProviders(<RunbookPanel onApply={onApply} assistantId="asst-1" />)
    await openPanel()

    // 提示必须可见：这一轮只启用勾选的工具
    expect(screen.getByTestId('runbook-grant-hint').textContent).toContain('勾选')

    fireEvent.click(screen.getByTestId('runbook-apply'))
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(stored.promptSummary, {
        runbookId: 'rb-1',
        toolIds: ['shell.exec']
      })
    )
  })

  it('缺失引用在点套用之前就列清单（不用等失败）', async () => {
    const onApply = vi.fn()
    stubPocketai({
      listRunbooks: () => [rec({ toolPermissions: ['shell.exec', 'kb.search'] })],
      getToolPolicy: () => policy(),
      checkRunbook: () => ({
        missingRefs: [{ kind: 'mcp', id: 'srv-9', label: '另一台机器的 CI 服务' }]
      })
    })
    mountWithProviders(<RunbookPanel onApply={onApply} assistantId="asst-1" />)
    await openPanel()

    await waitFor(() => expect(screen.getByTestId('runbook-missing')).toBeTruthy())
    expect(screen.getByTestId('runbook-missing').textContent).toContain('另一台机器的 CI 服务')

    fireEvent.click(screen.getByTestId('runbook-apply'))
    await waitFor(() => expect(screen.getByTestId('runbook-blocked')).toBeTruthy())
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('模板管理：重命名', () => {
  it('空名不落库；重名先确认，确认后才写', async () => {
    const first = rec({ id: 'rb-1', name: '甲' })
    const second = rec({ id: 'rb-2', name: '乙' })
    const updateRunbook = vi.fn((patch: { id: string; name?: string }) => ({
      ...(patch.id === 'rb-1' ? first : second),
      ...patch
    }))
    stubPocketai({
      listRunbooks: () => [first, second],
      getToolPolicy: () => policy(),
      checkRunbook: () => ({ missingRefs: [] }),
      updateRunbook
    })
    mountWithProviders(<RunbookPanel onApply={vi.fn()} assistantId="asst-1" />)
    await openPanel()

    fireEvent.click(screen.getByTestId('runbook-rename'))
    const input = screen.getByTestId('runbook-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('runbook-rename-save'))
    expect(updateRunbook).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('模板名称不能为空')).toBeTruthy())

    fireEvent.change(input, { target: { value: '乙' } })
    fireEvent.click(screen.getByTestId('runbook-rename-save'))
    await waitFor(() => expect(screen.getByText(/已有同名模板/)).toBeTruthy())
    expect(updateRunbook).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(updateRunbook).toHaveBeenCalledWith({ id: 'rb-1', name: '乙' }))
  })

  it('名称超过上限：给出上限与当前长度，且不落库', async () => {
    const first = rec({ id: 'rb-1', name: '甲' })
    const updateRunbook = vi.fn((patch: { id: string; name?: string }) => ({ ...first, ...patch }))
    stubPocketai({
      listRunbooks: () => [first],
      getToolPolicy: () => policy(),
      checkRunbook: () => ({ missingRefs: [] }),
      updateRunbook
    })
    mountWithProviders(<RunbookPanel onApply={vi.fn()} assistantId="asst-1" />)
    await openPanel()

    fireEvent.click(screen.getByTestId('runbook-rename'))
    const input = screen.getByTestId('runbook-rename-input') as HTMLInputElement
    // 常驻提示写清上限，不靠 maxLength 让人自己撞墙
    expect(screen.getByTestId('runbook-name-limit').textContent).toContain('100')

    const tooLong = 'x'.repeat(101)
    fireEvent.change(input, { target: { value: tooLong } })
    const line = screen.getByTestId('runbook-name-too-long')
    expect(line.textContent).toContain('100')
    expect(line.textContent).toContain('101')

    fireEvent.click(screen.getByTestId('runbook-rename-save'))
    await waitFor(() => expect(screen.getByText(/名称超长/)).toBeTruthy())
    expect(updateRunbook).not.toHaveBeenCalled()

    // 收到上限以内：提示消失、保存放行
    fireEvent.change(input, { target: { value: 'x'.repeat(100) } })
    expect(screen.queryByTestId('runbook-name-too-long')).toBeNull()
    fireEvent.click(screen.getByTestId('runbook-rename-save'))
    await waitFor(() =>
      expect(updateRunbook).toHaveBeenCalledWith({ id: 'rb-1', name: 'x'.repeat(100) })
    )
  })
})

describe('批量导入后的逐条确认引导', () => {
  it('落到第一条待确认；确认一条自动跳下一条；全部确认后引导消失', async () => {
    const a = rec({
      id: 'rb-a',
      name: '甲',
      steps: [{ toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] }]
    })
    const b = rec({
      id: 'rb-b',
      name: '乙',
      steps: [{ toolName: 'kb_search', toolId: 'kb.search', argKeys: ['query'] }]
    })
    const c = rec({ id: 'rb-c', name: '丙' })
    let stored: RunbookRecord[] = []
    const updateRunbook = vi.fn((patch: { id: string; toolPermissions?: string[] }) => {
      const cur = stored.find((x) => x.id === patch.id)!
      const next = { ...cur, toolPermissions: [...(patch.toolPermissions ?? [])] }
      stored = stored.map((x) => (x.id === patch.id ? next : x))
      return next
    })
    stubPocketai({
      listRunbooks: () => stored,
      importRunbooks: () => {
        stored = [a, b, c]
        return { ok: true, imported: 3, skipped: 0, droppedTools: 0, droppedRefs: 0, ids: ['rb-a', 'rb-b', 'rb-c'] }
      },
      getToolPolicy: () => policy(),
      checkRunbook: () => ({ missingRefs: [] }),
      updateRunbook
    })
    mountWithProviders(<RunbookPanel onApply={vi.fn()} assistantId="asst-1" />)
    await openPanel()

    fireEvent.click(screen.getByTestId('runbook-import'))
    await waitFor(() => expect(screen.getByTestId('runbook-import-guide')).toBeTruthy())
    expect(screen.getByTestId('runbook-import-pending').textContent).toContain('3')

    // 第一条：甲，只有 shell.exec 一个工具
    expect(screen.getAllByTestId('runbook-tool').map((x) => x.getAttribute('data-tool-id'))).toEqual([
      'shell.exec'
    ])
    fireEvent.click(screen.getAllByTestId('runbook-tool')[0]!)
    await waitFor(() => expect(updateRunbook).toHaveBeenLastCalledWith({ id: 'rb-a', toolPermissions: ['shell.exec'] }))

    // 自动跳下一条：乙，只剩 kb.search；进度 3 → 2
    await waitFor(() =>
      expect(screen.getAllByTestId('runbook-tool').map((x) => x.getAttribute('data-tool-id'))).toEqual([
        'kb.search'
      ])
    )
    expect(screen.getByTestId('runbook-import-pending').textContent).toContain('2')

    fireEvent.click(screen.getAllByTestId('runbook-tool')[0]!)
    await waitFor(() => expect(updateRunbook).toHaveBeenLastCalledWith({ id: 'rb-b', toolPermissions: ['kb.search'] }))

    // 再跳丙：两个工具都在，进度 1
    await waitFor(() =>
      expect(screen.getAllByTestId('runbook-tool').map((x) => x.getAttribute('data-tool-id'))).toEqual([
        'shell.exec',
        'kb.search'
      ])
    )
    expect(screen.getByTestId('runbook-import-pending').textContent).toContain('1')

    fireEvent.click(screen.getAllByTestId('runbook-tool')[0]!)
    await waitFor(() => expect(updateRunbook).toHaveBeenLastCalledWith({ id: 'rb-c', toolPermissions: ['shell.exec'] }))
    // 最后一条确认完：引导与进度整块消失（列表徽标另算）
    await waitFor(() => expect(screen.queryByTestId('runbook-import-guide')).toBeNull())
  })
})
