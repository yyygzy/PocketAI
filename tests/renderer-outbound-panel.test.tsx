// @vitest-environment jsdom
// 出网清单面板（2c-2 只读版）渲染契约
//
// 清单由主进程注册表下发；这里钉住四件事：
//  - 四列表头（类别 / 当前地址 / 固定还是可配置 / 用途）
//  - 固定/可配置/运行时输入/环回/子进程五类在屏上的明确标注
//  - 配置型当前地址来自 IPC（不是写死文案），读取失败单独显示
//  - v1 只读：没有按钮/跳转
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { OutboundPanel } from '../src/renderer/src/modules/settings/OutboundPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { OutboundEntryView } from '../src/shared/types'

const entries: OutboundEntryView[] = [
  {
    id: 'model-providers',
    labelKey: 'outbound.entry.modelProviders',
    purposeKey: 'outbound.purpose.modelProviders',
    kind: 'configurable',
    endpoints: [],
    transport: 'fetch',
    configSource: 'providers.base_url',
    addresses: [{ label: '本地网关', value: 'https://gateway.example.com/v1' }]
  },
  {
    id: 'weather',
    labelKey: 'outbound.entry.weather',
    purposeKey: 'outbound.purpose.weather',
    kind: 'fixed',
    endpoints: ['https://api.open-meteo.com'],
    transport: 'safeFetch',
    configSource: '无（固定端点）',
    addresses: [{ label: '', value: 'https://api.open-meteo.com' }]
  },
  {
    id: 'web-fetch',
    labelKey: 'outbound.entry.webFetch',
    purposeKey: 'outbound.purpose.webFetch',
    kind: 'runtime-url',
    endpoints: [],
    transport: 'safeFetch',
    configSource: '运行时 URL（模型/用户输入）',
    addresses: []
  },
  {
    id: 'ollama-local',
    labelKey: 'outbound.entry.ollamaLocal',
    purposeKey: 'outbound.purpose.ollamaLocal',
    kind: 'local-loopback',
    endpoints: ['http://127.0.0.1:11434'],
    transport: 'fetch',
    configSource: '固定环回 127.0.0.1:11434',
    addresses: [{ label: '', value: 'http://127.0.0.1:11434' }]
  },
  {
    id: 'mcp-python-deps',
    labelKey: 'outbound.entry.mcpPythonDeps',
    purposeKey: 'outbound.purpose.mcpPythonDeps',
    kind: 'configurable',
    endpoints: [],
    transport: 'child-process',
    configSource: 'python_pip_index_url',
    addresses: [],
    resolveError: '数据库未就绪'
  }
]

describe('OutboundPanel', () => {
  it('渲染四列表头与五个类别标注', async () => {
    stubPocketai({ getOutboundEntries: () => entries })
    mountWithProviders(<OutboundPanel />)

    expect(await screen.findByText(zh['outbound.entry.modelProviders'])).toBeTruthy()
    expect(screen.getByText(zh['outbound.col.category'])).toBeTruthy()
    expect(screen.getByText(zh['outbound.col.address'])).toBeTruthy()
    expect(screen.getByText(zh['outbound.col.kind'])).toBeTruthy()
    expect(screen.getByText(zh['outbound.col.purpose'])).toBeTruthy()

    expect(screen.getByText(zh['outbound.kind.fixed'])).toBeTruthy()
    expect(screen.getAllByText(zh['outbound.kind.configurable']).length).toBeGreaterThan(0)
    expect(screen.getByText(zh['outbound.kind.local-loopback'])).toBeTruthy()
    expect(screen.getAllByText(zh['outbound.kind.runtime-url']).length).toBeGreaterThan(0)
  })

  it('配置型显示 IPC 传来的真实地址；运行时输入明确标注不可枚举', async () => {
    stubPocketai({ getOutboundEntries: () => entries })
    mountWithProviders(<OutboundPanel />)

    expect(await screen.findByText(/gateway\.example\.com/)).toBeTruthy()
    expect(screen.getAllByText(zh['outbound.runtimeNotice']).length).toBeGreaterThan(0)
  })

  it('环回明确标「不出网」，子进程明确说明由子进程发起', async () => {
    stubPocketai({ getOutboundEntries: () => entries })
    mountWithProviders(<OutboundPanel />)

    expect(await screen.findByText(zh['outbound.localOnly'])).toBeTruthy()
    expect(screen.getByText(zh['outbound.childProcess'])).toBeTruthy()
  })

  it('读取当前地址失败不伪装成未配置', async () => {
    stubPocketai({ getOutboundEntries: () => entries })
    mountWithProviders(<OutboundPanel />)

    expect(await screen.findByText(/数据库未就绪/)).toBeTruthy()
  })

  it('v1 只读：面板里没有按钮（不提供跳转设置）', async () => {
    stubPocketai({ getOutboundEntries: () => entries })
    mountWithProviders(<OutboundPanel />)

    await screen.findByText(zh['outbound.entry.modelProviders'])
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('IPC 失败时显示失败原因，不渲染空表', async () => {
    stubPocketai({ getOutboundEntries: () => ({ ok: false, error: '主进程不可用' }) })
    mountWithProviders(<OutboundPanel />)

    expect(await screen.findByText(/主进程不可用/)).toBeTruthy()
    expect(screen.queryByText(zh['outbound.col.category'])).toBeNull()
  })
})
