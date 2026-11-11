// @vitest-environment jsdom
// P3 / V4-Iter-460：MCP 与 Channels 在设置页的第二入口（P4 批次 2 已删 Agent 壳，设置页这一份保留）
//
// 钉三件事：
// ① 设置页两个分区挂的确实是两份真面板（不是标题占位），且都经共享组件挂载；
// ② Agent 壳文件已删除，设置页不再引用 AgentModule，共享面板仍挂两处；
// ③ 新增文案四语都在（键集合对等由 i18n-parity 守，这里钉"别只写中文"）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { screen } from '@testing-library/react'
import type { ChannelConfig, ChannelType } from '../src/shared/types'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { CapabilitySettingsPanel, ConnectionSettingsPanel } from '../src/renderer/src/modules/settings/EmbeddedAgentPanels'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const ROOT = process.cwd()
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const SETTINGS = 'src/renderer/src/modules/settings/SettingsModule.tsx'
const EMBEDDED = 'src/renderer/src/modules/settings/EmbeddedAgentPanels.tsx'
const AGENT_MODULE = 'src/renderer/src/modules/agent/AgentModule.tsx'

function stubMcp(): void {
  stubPocketai({
    listMcpServers: () => [],
    getMcpRuntimes: () => [],
    listMcpCallLogs: () => ({ ok: true, logs: [] }),
    onMcpStatus: () => () => {},
    onMcpLog: () => () => {},
    onPythonEnvEvent: () => () => {},
    getPythonPipSource: () => ({ ok: true, source: 'official' }),
    getAgentToolSurface: () => 'grouped'
  })
}

function fakeCfg(type: ChannelType): ChannelConfig {
  return {
    type,
    enabled: false,
    hasPrimarySecret: false,
    hasSecondarySecret: false,
    appId: '',
    whitelist: '',
    assistantId: '',
    providerId: '',
    model: '',
    agentMode: false
  }
}

function stubChannels(): void {
  stubPocketai({
    listProviders: () => [],
    listAssistants: () => [],
    getChannelConfig: (type: unknown) => fakeCfg(type as ChannelType),
    listChannelStatus: () => ({}),
    onChannelStatus: () => () => {}
  })
}

describe('① 设置页两个分区挂的是真面板', () => {
  it('能力（MCP）：面板真的挂载并发出 listMcpServers，空态文案可见', async () => {
    stubMcp()
    mountWithProviders(<CapabilitySettingsPanel />)
    const wrap = screen.getByTestId('settings-mcp-panel')
    expect(wrap.style.height).toBe('min(70vh, 640px)')
    expect(await screen.findByText(zh['agent.noServers'])).toBeTruthy()
    expect(pocketaiCalls().some((c) => c.fn === 'listMcpServers')).toBe(true)
  })

  it('连接（IM 网关）：面板真的挂载并发出 getChannelConfig / listChannelStatus', async () => {
    stubChannels()
    mountWithProviders(<ConnectionSettingsPanel />)
    expect(screen.getByTestId('settings-channels-panel')).toBeTruthy()
    expect(await screen.findByTestId('channel-run-hint')).toBeTruthy()
    expect(pocketaiCalls().some((c) => c.fn === 'getChannelConfig')).toBe(true)
    expect(pocketaiCalls().some((c) => c.fn === 'listChannelStatus')).toBe(true)
  })
})

describe('② 设置页经共享组件挂两个面板，且不再引用 AgentModule', () => {
  it('两个面板只在 EmbeddedAgentPanels 里挂一次，SettingsModule 不各留一份', () => {
    const embedded = read(EMBEDDED)
    expect(embedded).toContain("from '../agent/mcp/McpPanel'")
    expect(embedded).toContain("from '../agent/channels/ChannelsPanel'")
    const settings = read(SETTINGS)
    expect(settings).toContain('<CapabilitySettingsPanel />')
    expect(settings).toContain('<ConnectionSettingsPanel />')
    // 直接 import 面板 = 又长出一份挂载实现；设置页只允许经共享组件挂
    expect(settings).not.toContain("from '../agent/mcp/McpPanel'")
    expect(settings).not.toContain("from '../agent/channels/ChannelsPanel'")
  })

  it('Agent 壳已删除：设置页不再引用 AgentModule，共享组件仍挂两个面板', () => {
    expect(fs.existsSync(path.join(ROOT, AGENT_MODULE)), 'P4 批次 2 应已删除 Agent 壳').toBe(false)
    const settings = read(SETTINGS)
    expect(settings).not.toContain('modules/agent/AgentModule')
    const embedded = read(EMBEDDED)
    expect(embedded).toContain('<McpPanel />')
    expect(embedded).toContain('<ChannelsPanel />')
  })
})

describe('③ 新增文案四语齐', () => {
  const KEYS = [
    'set.capability',
    'set.capabilityHint',
    'set.connection',
    'set.connectionHint'
  ] as const

  it.each(KEYS)('%s 四本字典都非空', (key) => {
    for (const dict of [zh, en, ja, ko]) {
      expect((dict as Record<string, string>)[key]?.trim()).toBeTruthy()
    }
  })
})
