// @vitest-environment jsdom
// B：MCP 站点级出网限制卡片（渲染层）
//
// 钉三件事：① 读回即如实上屏（收紧态 + 清单）；② 保存时把"勾选→allowOtherHosts"翻对、
// 空行不当条目；③ 保存失败要常驻点名，不能"点了保存什么都没发生"。
import { describe, it, expect, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import { stubPocketai, pocketaiCalls, mountWithProviders } from './helpers/renderer'
import { McpSitePolicyCard } from '../src/renderer/src/modules/agent/mcp/McpSitePolicyCard'

async function mountCard(over: Record<string, (...a: any[]) => unknown> = {}) {
  stubPocketai({
    getMcpSitePolicy: () => ({ allowedHosts: [], allowOtherHosts: true }),
    ...over
  })
  const notify = vi.fn()
  const r = mountWithProviders(<McpSitePolicyCard notify={notify} />)
  await act(async () => {})
  return { ...r, notify }
}

describe('McpSitePolicyCard', () => {
  it('读回严格策略：勾选态与域名清单如实上屏，并说明 stdio 拦不到', async () => {
    await mountCard({
      getMcpSitePolicy: () => ({ allowedHosts: ['api.example.com', 'localhost'], allowOtherHosts: false })
    })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('mcp-site-policy-hosts') as HTMLTextAreaElement).value).toBe(
      'api.example.com\nlocalhost'
    )
    expect(screen.getByText(/stdio 子进程/)).toBeTruthy()
  })

  it('保存：勾选=只允许清单内，空行被剔除，成功后提示并回填归一化结果', async () => {
    const setCalls: unknown[] = []
    const { notify } = await mountCard({
      setMcpSitePolicy: (policy: unknown) => {
        setCalls.push(policy)
        return { allowedHosts: ['api.example.com'], allowOtherHosts: false }
      }
    })
    const box = screen.getByRole('checkbox') as HTMLInputElement
    await act(async () => {
      box.click()
    })
    await act(async () => {
      const ta = screen.getByTestId('mcp-site-policy-hosts') as HTMLTextAreaElement
      // 直接改受控值：两行域名 + 一个空行
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, 'API.example.com\n\n')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      screen.getByRole('button', { name: '保存' }).click()
    })
    expect(setCalls).toEqual([{ allowedHosts: ['API.example.com'], allowOtherHosts: false }])
    expect(notify).toHaveBeenCalledWith('站点限制已保存')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('mcp-site-policy-hosts') as HTMLTextAreaElement).value).toBe(
      'api.example.com'
    )
  })

  it('保存失败：主进程原因常驻显示（不是静默吞掉），也不冒充已保存', async () => {
    const { notify } = await mountCard({
      setMcpSitePolicy: () => ({ ok: false, error: '域名格式无效：http://' })
    })
    await act(async () => {
      screen.getByRole('button', { name: '保存' }).click()
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('域名格式无效：http://')
    expect(notify).not.toHaveBeenCalled()
    expect(pocketaiCalls().some((c) => c.fn === 'setMcpSitePolicy')).toBe(true)
  })
})
