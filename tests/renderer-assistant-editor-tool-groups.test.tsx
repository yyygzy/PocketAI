// @vitest-environment jsdom
// AssistantEditor 的工具权限区（V4-Iter-172，B51 对账时现查的零覆盖）
//
// `'*'` 只给内置这条**机制**在 registry 侧有 5 例，但编辑界面上那句
// 「全部内置不含 MCP 工具」与「MCP 那一组不再显示选中态、也不再被禁用」此前没人证过——
// 全仓没有任何测试挂载过 AssistantEditor。这里钉的就是用户看得见的那三个事实。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AssistantEditor } from '../src/renderer/src/modules/chat/AssistantEditor'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ToolSchema } from '../src/shared/types'

const TOOLS: ToolSchema[] = [
  { id: 'fs.read', name: 'fs_read', description: '读文件', parameters: {}, source: 'builtin' },
  { id: 'web.fetch', name: 'web_fetch', description: '取网页', parameters: {}, source: 'builtin' },
  { id: 'mcp:srv-a:search', name: 'search', description: 'MCP 搜索', parameters: {}, source: 'mcp', mcpServerId: 'srv-a' },
  { id: 'mcp:srv-a:fetch', name: 'fetch2', description: 'MCP 抓取', parameters: {}, source: 'mcp', mcpServerId: 'srv-a' }
]

/** chip 的选中态样式（与组件里的 chipCls 同源的那一段），用来判"点亮没点亮" */
const SELECTED = 'bg-[var(--color-accent-soft)]'

function mount(toolPermissions: string[]): void {
  stubPocketai({
    listKnowledgeBases: () => [],
    listAvailableTools: () => TOOLS,
    listSkills: () => [],
    saveAssistant: (a) => a
  })
  mountWithProviders(
    <AssistantEditor
      initial={{ name: '测试助手', toolPermissions }}
      providers={[]}
      onCancel={() => {}}
      onSaved={() => {}}
    />
  )
}

const chip = (title: string): HTMLButtonElement => screen.getByTitle(title) as HTMLButtonElement

describe('勾了「允许全部内置」时的 MCP 那一组', () => {
  it('MCP 组下面那句说明逐字在场（它存在的意义就是解释"为什么全亮了还调不到 MCP"）', async () => {
    mount(['*'])
    expect(await screen.findByText(zh['ae.mcpNotInAll'])).toBeTruthy()
  })

  it('MCP 的 chip 不被 allowAll 点亮，而内置的点亮——界面不许承诺一个已经不给的权限', async () => {
    mount(['*'])
    await screen.findByText(zh['ae.mcpNotInAll'])
    expect(chip('读文件').className).toContain(SELECTED)
    expect(chip('MCP 搜索').className).not.toContain(SELECTED)
  })

  it('MCP 的 chip 仍可点（内置那一组在 allowAll 下才是禁用的）', async () => {
    mount(['*'])
    await screen.findByText(zh['ae.mcpNotInAll'])
    expect(chip('读文件').disabled).toBe(true)
    expect(chip('MCP 搜索').disabled).toBe(false)
  })

  it('点一条 MCP ⇒ 它自己变选中，且不因为"允许全部"而被算成已勾', async () => {
    mount(['*'])
    await screen.findByText(zh['ae.mcpNotInAll'])
    fireEvent.click(chip('MCP 搜索'))
    await waitFor(() => expect(chip('MCP 搜索').className).toContain(SELECTED))
    expect(chip('MCP 抓取').className).not.toContain(SELECTED)
  })

  it('反向对照：一个 MCP 工具都没有时，不摆这句解释（更不摆空分组）', async () => {
    stubPocketai({
      listKnowledgeBases: () => [],
      listAvailableTools: () => TOOLS.filter((t) => t.source !== 'mcp'),
      listSkills: () => [],
      saveAssistant: (a) => a
    })
    mountWithProviders(
      <AssistantEditor initial={{ name: 'x', toolPermissions: ['*'] }} providers={[]} onCancel={() => {}} onSaved={() => {}} />
    )
    await screen.findByTitle('读文件')
    expect(screen.queryByText(zh['ae.mcpNotInAll'])).toBeNull()
  })

  it('没勾 allowAll 时逐条勾上的 MCP 显示为选中（收紧不是"永远不给"）', async () => {
    mount(['mcp:srv-a:search'])
    await screen.findByText(zh['ae.mcpNotInAll'])
    expect(chip('MCP 搜索').className).toContain(SELECTED)
    expect(chip('MCP 抓取').className).not.toContain(SELECTED)
    expect(chip('读文件').disabled).toBe(false)
  })
})
