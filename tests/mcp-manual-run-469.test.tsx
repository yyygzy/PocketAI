// V4-Iter-469：MCP 面板手工试运行的加固（二次确认 / 示例值 / 结果耗时）
//
// 关键口径：
//  · 只有 forceConfirm（主进程 mcpToolForceConfirm 的落点）才多问一次；
//    permission==='auto' 与普通 confirm 都不重复问——用户点「试运行」本身就是显式动作。
//  · 示例值只来自 default / examples[0] / enum[0]，不展示完整 schema、不做校验。
//  · 结果行内展示，带耗时与复制入口；超时仍是错误文本，但耗时同样可见。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { McpPanel } from '../src/renderer/src/modules/agent/mcp/McpPanel'
import { buildExampleArgs } from '../src/renderer/src/modules/agent/mcp/tool-args-example'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const RECORD = {
  id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node',
  args: [], env: {}, headers: {}, enabled: true, readOnly: false, url: ''
}

const TOOL_BASE = { source: 'mcp' as const, mcpServerId: 'srv1', permission: 'confirm' as const }

const TOOLS = [
  {
    ...TOOL_BASE,
    id: 'mcp:srv1:delete_item',
    name: 'delete_item',
    description: '',
    forceConfirm: true,
    parameters: { type: 'object', properties: { id: { type: 'string', default: '42' } } }
  },
  {
    ...TOOL_BASE,
    id: 'mcp:srv1:fetch',
    name: 'fetch',
    description: '',
    forceConfirm: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', examples: ['https://example.com'] },
        mode: { type: 'string', enum: ['fast', 'full'] },
        limit: { type: 'number', default: 10 },
        note: { type: 'string' }
      }
    }
  }
]

const RUNTIME = [{
  id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node',
  args: [], env: {}, status: 'running', tools: TOOLS, lastError: null
}]

type Impl = (...a: any[]) => unknown
const stubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listMcpServers: () => [RECORD],
  getMcpRuntimes: () => RUNTIME,
  listMcpCallLogs: () => ({ ok: true, logs: [] }),
  onMcpStatus: () => () => { /* 订阅卸载 */ },
  onMcpLog: () => () => { /* 订阅卸载 */ },
  onPythonEnvEvent: () => () => { /* 订阅卸载 */ },
  getPythonPipSource: () => ({ ok: true, source: 'default', url: '' }),
  getAgentToolSurface: () => 'grouped',
  ...over
})

function toolBox(name: string): HTMLElement {
  const el = screen.getByText(name).closest('div[class*="rounded"]')
  if (!el) throw new Error(`找不到工具 ${name} 的卡片`)
  return el as HTMLElement
}

const makeCall = () =>
  vi.fn(async (_serverId: string, _toolName: string, _argsJson: string) => ({
    ok: true,
    content: 'done',
    isError: false
  }))

function buttonIn(root: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === label)
  if (!btn) throw new Error(`卡片里找不到按钮：${label}`)
  return btn
}

async function expandTools(): Promise<void> {
  await waitFor(() => expect(screen.getByText(/个工具/)).toBeTruthy())
  fireEvent.click(screen.getByText(/个工具/))
  await waitFor(() => expect(screen.getByText('delete_item')).toBeTruthy())
}

describe('buildExampleArgs — 只取 default / examples[0] / enum[0]', () => {
  it('三类来源各取一个，没有样本的键不猜', () => {
    expect(buildExampleArgs(TOOLS[1]!.parameters)).toEqual({
      url: 'https://example.com',
      mode: 'fast',
      limit: 10
    })
  })

  it('非对象 / 无 properties → 空对象', () => {
    expect(buildExampleArgs(null)).toEqual({})
    expect(buildExampleArgs({ type: 'object' })).toEqual({})
    expect(buildExampleArgs([])).toEqual({})
  })
})

describe('手工试运行的安全与体验', () => {
  it('forceConfirm 工具先二次确认：取消不调用，确认后才发 IPC', async () => {
    const call = makeCall()
    stubPocketai(stubs({ callMcpServerTool: call }))
    mountWithProviders(<McpPanel />)
    await expandTools()

    fireEvent.click(buttonIn(toolBox('delete_item'), L('agent.toolRun')))
    await waitFor(() => expect(screen.getByText(L('agent.toolRunForceTitle'))).toBeTruthy())
    expect(call).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: L('common.confirm') }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]![0]).toBe('srv1')
    expect(call.mock.calls[0]![1]).toBe('delete_item')
  })

  it('取消二次确认后按钮恢复可用，工具没有被真实执行', async () => {
    const call = makeCall()
    stubPocketai(stubs({ callMcpServerTool: call }))
    mountWithProviders(<McpPanel />)
    await expandTools()

    fireEvent.click(buttonIn(toolBox('delete_item'), L('agent.toolRun')))
    await waitFor(() => expect(screen.getByText(L('agent.toolRunForceTitle'))).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: L('common.cancel') }))
    // 取消失败路径不需要再等一帧：fireEvent 内的 act 已把弹窗状态刷掉
    expect(screen.queryByText(L('agent.toolRunForceTitle'))).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(buttonIn(toolBox('delete_item'), L('agent.toolRun')).disabled).toBe(false)
  })

  it('普通 confirm 工具不再重复问：点试运行直接调用', async () => {
    const call = makeCall()
    stubPocketai(stubs({ callMcpServerTool: call }))
    mountWithProviders(<McpPanel />)
    await expandTools()

    fireEvent.click(buttonIn(toolBox('fetch'), L('agent.toolRun')))
    // 普通 confirm 不弹二次确认：点下去这一帧就不该出现弹窗，再等 IPC 落地
    expect(screen.queryByText(L('agent.toolRunForceTitle'))).toBeNull()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  })

  it('填入示例值：按 schema 生成并写进参数框', async () => {
    stubPocketai(stubs({ callMcpServerTool: makeCall() }))
    mountWithProviders(<McpPanel />)
    await expandTools()

    const box = toolBox('fetch')
    fireEvent.click(buttonIn(box, L('agent.toolArgsFillExample')))
    const textarea = box.querySelector('textarea') as HTMLTextAreaElement
    await waitFor(() => expect(JSON.parse(textarea.value)).toEqual({
      url: 'https://example.com',
      mode: 'fast',
      limit: 10
    }))
  })

  it('结果行内展示：带复制按钮与耗时（超时同样走这条）', async () => {
    stubPocketai(stubs({ callMcpServerTool: makeCall() }))
    mountWithProviders(<McpPanel />)
    await expandTools()

    fireEvent.click(buttonIn(toolBox('fetch'), L('agent.toolRun')))
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy())
    expect(screen.getByText(/\d+ms/)).toBeTruthy()
    expect(buttonIn(toolBox('fetch'), L('common.copy'))).toBeTruthy()
  })
})
