// @vitest-environment jsdom
// MCP 的两条"批量入口"挂到界面上（V4-Iter-172，B19 对账现查的零覆盖）
//
// 解析/实例化早有 CI（mcp-import.test / mcp-templates.test），但**用户看到的结果计数**没人证：
// ① 导入时闸门拒了其中一条 ⇒ 成功数不能虚增、被拒那条要出现在警告里；
// ② 模板创建失败 ⇒ 那张卡不许标成"已创建"（否则用户以为有了，实际没有）。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { McpImportModal } from '../src/renderer/src/modules/agent/mcp/McpImportModal'
import { McpTemplatesModal } from '../src/renderer/src/modules/agent/mcp/McpTemplatesModal'
import { zh } from '../src/renderer/src/i18n/zh'

const saveCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'saveMcpServer').length

describe('① 批量导入：闸门拒绝的那条计入警告，成功数不虚增', () => {
  const JSON_TWO = JSON.stringify({
    mcpServers: {
      'plain-one': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      'secret-two': { command: 'node', args: ['x.js'], env: { API_KEY: 'sk-keep' } }
    }
  })

  function mount(save: (rec: unknown) => unknown): void {
    stubPocketai({ saveMcpServer: save })
    mountWithProviders(<McpImportModal onClose={() => {}} onImported={async () => {}} />)
  }

  it('一条被闸门挡下 ⇒ toast 说"成功导入 1 个"，并把被拒那条连原因一起列出来', async () => {
    mount((rec) => {
      const name = (rec as { name: string }).name
      return name === 'secret-two'
        ? { ok: false, error: '未设置主密码，新密钥不会被保存' }
        : { id: 'srv-1', name, transport: 'stdio', enabled: true }
    })
    fireEvent.change(screen.getByPlaceholderText(zh['agent.importPh']), { target: { value: JSON_TWO } })
    fireEvent.click(screen.getByText(zh['agent.importParse']))
    expect(await screen.findByText(zh['agent.importOk'].replace('{n}', '2'))).toBeTruthy()
    fireEvent.click(screen.getByText(zh['agent.importConfirm']))
    // 关键断言：成功的只有 1 个（改前这里是"导入 2 个"，第二条其实被主进程挡了）
    expect(await screen.findByText(zh['agent.importSuccess'].replace('{n}', '1'))).toBeTruthy()
    expect(screen.getByText(/未设置主密码/)).toBeTruthy().toBeTruthy()
    expect(saveCalls()).toBe(2)
  })

  it('反向对照：全部成功时不出现警告条，成功数等于条数', async () => {
    mount((rec) => ({ id: 'srv-ok', name: (rec as { name: string }).name, transport: 'stdio', enabled: true }))
    fireEvent.change(screen.getByPlaceholderText(zh['agent.importPh']), { target: { value: JSON_TWO } })
    fireEvent.click(screen.getByText(zh['agent.importParse']))
    fireEvent.click(await screen.findByText(zh['agent.importConfirm']))
    expect(await screen.findByText(zh['agent.importSuccess'].replace('{n}', '2'))).toBeTruthy()
    expect(screen.queryByText(/未设置主密码/)).toBeNull()
  })

  it('一条都没有时「导入」按钮不可点（不让人对着空列表按下去等一个不会来的结果）', async () => {
    mount((rec) => rec)
    fireEvent.change(screen.getByPlaceholderText(zh['agent.importPh']), { target: { value: '{' } })
    fireEvent.click(screen.getByText(zh['agent.importParse']))
    const btn = (await screen.findByText(zh['agent.importConfirm'])).closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(saveCalls()).toBe(0)
  })
})
describe('② 模板创建：闸门拒绝不许标「已创建」，成功才标（V4-Iter-172）', () => {
  /** 免密钥、无占位符的那张卡 ⇒ 点「创建」就直接发 saveMcpServer */
  function createBtnOf(tplId: string): HTMLButtonElement {
    const card = screen.getByText(tplId).closest('div[class*="rounded"]') as HTMLElement
    const btn = Array.from(card.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === zh['agent.tplCreate']
    )
    if (!btn) throw new Error('卡片 ' + tplId + " 上找不到「创建」按钮")
    return btn as HTMLButtonElement
  }

  function mount(save: (rec: unknown) => unknown): void {
    stubPocketai({ saveMcpServer: save })
    mountWithProviders(<McpTemplatesModal onClose={() => {}} onCreated={async () => {}} />)
  }

  it('占位符没填就点创建 ⇒ 就地提示"请填写「…」"，一次 saveMcpServer 都不发', async () => {
    mount((rec) => rec)
    const btn = createBtnOf('filesystem')
    fireEvent.click(btn)
    expect(await screen.findByText(/请填写「/)).toBeTruthy()
    expect(saveCalls()).toBe(0)
    expect(btn.disabled).toBe(false)
  })

  it('主进程闸门拒绝 ⇒ 弹错误、卡片上不许出现「已创建」（那是"用户以为已经有了"）', async () => {
    mount(() => ({ ok: false, error: '未设置主密码，新密钥不会被保存' }))
    const btn = createBtnOf('memory')
    fireEvent.click(btn)
    await waitFor(() => expect(saveCalls()).toBe(1))
    expect(await screen.findByText(/未设置主密码/)).toBeTruthy()
    expect(screen.queryByText(zh['agent.tplCreated'])).toBeNull()
    expect(createBtnOf('memory').disabled).toBe(false)
  })

  it('同屏正向对照：真存下来时才打「已创建」——上一条的"没有"不是因为徽标根本不渲染', async () => {
    const rec = { id: 'srv-mem', name: 'memory', transport: 'stdio', enabled: true }
    mount(() => rec)
    fireEvent.click(createBtnOf('memory'))
    await waitFor(() => expect(screen.getByText(zh['agent.tplCreated'])).toBeTruthy())
    expect(saveCalls()).toBe(1)
  })
})
