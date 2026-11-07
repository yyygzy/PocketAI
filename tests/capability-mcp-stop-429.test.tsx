// @vitest-environment jsdom
// V4-Iter-429：能力中心的「停止」按钮（复用既有 stopMcpServer 通道，不新造 IPC）。
//
// 三条判据就是需求里那三条：
//  ① 运行中才有停止键；停成功后运行态/工具清单/授权数一起退回「已配置未启动」，不许留着上一次的快照；
//  ② 停失败只写一张独立的 inline 脸，运行态一个字都不许改（更不许把 chip 改成已停）；
//  ③ 与启动共享同一条 onMcpStatus：停止之后再收到迟到事件，渲染端**重读主进程真实状态**，不按事件里的
//     status 直接翻牌。
// 注意：主进程 `McpManager.start()` 握手后若发现 entry 已 stopped 会 shutdown 而不再 emit running
// （manager.ts 的守卫）——那一条是代码推演，没有在真机上复现竞态，本文件只钉渲染端的重读行为。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { CapabilityCenter } from '../src/renderer/src/modules/skills/CapabilityCenter'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  AssistantRecord,
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent,
  ToolPolicySnapshot
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const SERVER = {
  id: 'm1',
  name: 'PROBE-MCP',
  transport: 'stdio',
  runtime: 'node',
  command: 'node',
  args: ['server.js'],
  env: {},
  url: null,
  headers: {},
  enabled: true,
  createdAt: 1,
  trustReadOnly: false,
  pythonPackages: []
} as unknown as McpServerRecord

const TOOL = {
  id: 'mcp:m1:probe_tool',
  name: 'probe_tool',
  source: 'mcp',
  mcpServerId: 'm1',
  permission: 'confirm',
  state: 'available',
  dynamic: false,
  reasons: []
}

const policy = (granted: boolean): ToolPolicySnapshot =>
  ({
    tools: [{ ...TOOL, granted }],
    shell: { enabled: false, policy: 'confirm', confirmReasons: [], denyReasons: [] },
    mcpStoppedServers: 0,
    // loadPolicy 的逐助手视角快照里带 `assistant`；授权人数只从这一支数
    assistant: { id: 'a1', name: 'PROBE-助手', icon: '⚡', tools: [{ ...TOOL, granted }] }
  }) as unknown as ToolPolicySnapshot

const A1 = { id: 'a1', name: 'PROBE-助手', skillIds: [], isBuiltin: false } as unknown as AssistantRecord

type Listener = (evt: McpServerStatusEvent) => void

function mount(over: Record<string, (...a: any[]) => unknown> = {}) {
  let statusListener: Listener | null = null
  stubPocketai({
    listSkills: () => [],
    listAssistants: () => [A1],
    listMcpServers: () => [SERVER],
    getMcpRuntimes: () => [RUNNING_RUNTIME],
    // 无参＝注册表全量；带 id＝该助手视角（这里只有 a1 且已授权这条工具）
    getToolPolicy: (assistantId?: string) => policy(assistantId === 'a1'),
    listProviders: () => [],
    onMcpStatus: (fn: Listener) => {
      statusListener = fn
      return () => {
        statusListener = null
      }
    },
    onMcpLog: () => () => {},
    stopMcpServer: () => ({ ok: true }),
    ...over
  })
  mountWithProviders(<CapabilityCenter onClose={() => {}} onChanged={async () => []} />)
  return {
    emitStatus: (evt: McpServerStatusEvent): void => {
      act(() => {
        statusListener?.(evt)
      })
    }
  }
}

const RUNNING_RUNTIME = {
  ...SERVER,
  status: 'running',
  tools: [{ name: 'probe_tool', description: '探针' }],
  lastError: null
} as unknown as McpServerRuntime

const STOPPED_RUNTIME = {
  ...SERVER,
  status: 'stopped',
  tools: [],
  lastError: null
} as unknown as McpServerRuntime

async function openMcpDetail(): Promise<void> {
  const card = await screen.findByText(SERVER.name, {}, MOUNT_BUDGET)
  fireEvent.click(card.closest('button')!)
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('429 能力中心：停止按钮', () => {
  it('运行中才出现停止键；停成功后运行态/工具清单/授权数一起退回「已配置未启动」', async () => {
    let running = true
    mount({
      stopMcpServer: () => {
        running = false
        return { ok: true }
      },
      getMcpRuntimes: () => [running ? RUNNING_RUNTIME : STOPPED_RUNTIME]
    })
    await openMcpDetail()
    expect(screen.getByTestId('capability-mcp-stop')).toBeTruthy()
    expect(bodyText()).toContain(L('cap.mcp.toolsTitle'))
    expect(bodyText()).toContain(L('cap.state.mcp.authorized').replace('{n}', '1'))
    expect(bodyText()).toContain('probe_tool')

    fireEvent.click(screen.getByTestId('capability-mcp-stop'))
    await waitFor(() => expect(screen.getByTestId('capability-mcp-start')).toBeTruthy(), MOUNT_BUDGET)

    expect(pocketaiCalls().filter((c) => c.fn === 'stopMcpServer').map((c) => c.args[0])).toEqual(['m1'])
    // 运行中的三样一起退场：chip、工具块、授权 chip 与授权区
    expect(screen.getByText(L('cap.state.mcp.stopped'), { exact: true })).toBeTruthy()
    expect(screen.queryByText(L('cap.state.mcp.running'), { exact: true })).toBeNull()
    expect(bodyText(), '工具清单不许留着上一次的快照').not.toContain(L('cap.mcp.toolsTitle'))
    expect(bodyText()).not.toContain('probe_tool')
    expect(bodyText(), '授权数也不许留着').not.toContain(
      L('cap.state.mcp.authorized').replace('{n}', '1')
    )
    expect(screen.queryByTestId('capability-mcp-stop')).toBeNull()
    expect(screen.queryByTestId('capability-mcp-stop-error')).toBeNull()
  })

  it('停失败 ⇒ 独立 inline 文案，且运行态一个字都不改（chip/工具/授权都还在，键还在可重试）', async () => {
    const running = true
    mount({
      stopMcpServer: () => ({ ok: false }),
      getMcpRuntimes: () => [running ? RUNNING_RUNTIME : STOPPED_RUNTIME]
    })
    await openMcpDetail()
    fireEvent.click(screen.getByTestId('capability-mcp-stop'))
    const line = await screen.findByTestId('capability-mcp-stop-error', {}, MOUNT_BUDGET)
    expect(line.textContent).toBe(
      L('cap.mcp.stopFailed').replace('{msg}', L('common.unknownError'))
    )
    // 失败不许改状态：仍是运行中，三样都还在
    expect(screen.getByText(L('cap.state.mcp.running'), { exact: true })).toBeTruthy()
    expect(bodyText()).toContain(L('cap.mcp.toolsTitle'))
    expect(bodyText()).toContain(L('cap.state.mcp.authorized').replace('{n}', '1'))
    expect(screen.getByTestId('capability-mcp-stop'), '失败后那颗键留着，直接重试').toBeTruthy()
    expect(screen.queryByTestId('capability-mcp-start')).toBeNull()
    // 反向钉：失败脸与启动失败脸是两张，别把停止失败写成启动失败
    expect(screen.queryByTestId('capability-mcp-start-error')).toBeNull()
  })

  it('停止后收到迟到的状态事件 ⇒ 渲染端重读真实状态，不按事件里的 running 翻回运行中', async () => {
    let running = true
    const h = mount({
      stopMcpServer: () => {
        running = false
        return { ok: true }
      },
      getMcpRuntimes: () => [running ? RUNNING_RUNTIME : STOPPED_RUNTIME]
    })
    await openMcpDetail()
    fireEvent.click(screen.getByTestId('capability-mcp-stop'))
    await waitFor(() => expect(screen.getByTestId('capability-mcp-start')).toBeTruthy(), MOUNT_BUDGET)

    // 迟到事件自称 running（主进程若真 emit 了这样的迟到事件，渲染端此时重读会读到 stopped）
    h.emitStatus({ serverId: 'm1', status: 'running', tools: [] })
    await waitFor(
      () => expect(screen.getByText(L('cap.state.mcp.stopped'), { exact: true })).toBeTruthy(),
      MOUNT_BUDGET
    )
    expect(screen.queryByText(L('cap.state.mcp.running'), { exact: true }), '迟到的 running 不许把 chip 翻回去').toBeNull()
    expect(bodyText()).not.toContain(L('cap.mcp.toolsTitle'))
    expect(screen.getByTestId('capability-mcp-start')).toBeTruthy()
  })
})
