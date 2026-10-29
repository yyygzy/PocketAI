// @vitest-environment jsdom
// V4-Iter-340 行为面：键盘提交路径与鼠标提交路径必须走同一道守卫
//
// 两处形状：
// ① 输入法组字那次 Enter 不该当"提交"（同屏 Composer 早已判 `isComposing`，这一批把它铺到 21 个自由文本框）；
//    判据要成对——组字那发不许动、真 Enter 那发照常发，否则"把提交写成永远不发"也能骗绿。
// ② 凭据框的 Enter 与随后被弹窗挤出来的 blur 会各发一发（§336 修过 ChannelsPanel，这张屏是漏掉的姊妹处）；
//    判据按通道调用次数钉，并留一条"单独 blur 仍会写"的反向对照（那是取消确认后重试的路，不许一起砍掉）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { MessageBubble } from '../src/renderer/src/modules/chat/MessageBubble'
import { AgentToolBars } from '../src/renderer/src/modules/agent/components/AgentToolBars'
import { useAgentToolConfigs } from '../src/renderer/src/modules/agent/hooks/useAgentToolConfigs'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (k: string): string => (zh as unknown as Record<string, string>)[k]!

describe('① 消息编辑重发：组字 Enter 不提交、真 Enter 提交', () => {
  const resends = vi.fn()

  /** 进编辑态：右键这张气泡 → 点「编辑并重发」 */
  async function toEditing(): Promise<HTMLElement> {
    mountWithProviders(<MessageBubble role="user" content="原文" messageId="u1" streaming={false} onResend={resends} />)
    fireEvent.contextMenu(screen.getByText('原文'))
    fireEvent.click(await screen.findByText(L('chatview.editResend')))
    return (await screen.findByRole('textbox')) as HTMLElement
  }

  beforeEach(() => resends.mockClear())

  it('输入法还在组字时按 Enter ⇒ 一次都不发（发出去就是拼音串，还会退出编辑态丢掉用户已写的）', async () => {
    const box = await toEditing()
    fireEvent.change(box, { target: { value: 'gou wu mai' } })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(resends, '组字那次的 Enter 不许提交').not.toHaveBeenCalled()
    // 还在编辑态（没被那条 Enter 关掉）
    expect(screen.queryByRole('textbox')).toBeTruthy()
  })

  it('反向对照：组字结束后的普通 Enter 照常提交（新闸不许把正常路径一起挡掉）', async () => {
    const box = await toEditing()
    fireEvent.change(box, { target: { value: '改好的正文' } })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(resends).toHaveBeenCalledTimes(1))
    expect(resends).toHaveBeenCalledWith('u1', '改好的正文')
  })
})

describe('② 联网搜索 API Key：Enter 之后被 blur 追一发 ⇒ 只写一次', () => {
  const calls: string[] = []

  /** 照抄 renderer-websearch-b3 的夹具形状：AgentToolBars 吃的是 useAgentToolConfigs() 的返回值，默认收起要先展开 */
  function mount(): void {
    stubPocketai({
      getEncryptionStatus: () => ({
        mode: 'db', unlocked: true, dbEncrypted: true, fieldEncrypted: true,
        masterPasswordVerified: true, kdfN: 131072, kdfAtCurrentTier: true
      }),
      getAgentWorkspaceDir: () => '',
      getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
      getCalendarConfig: () => ({ enabled: false, paths: [] }),
      getWebSearchConfig: () => ({ enabled: true, provider: 'tavily', apiKey: '', hasKey: false }),
      setWebSearchConfig: (patch: { apiKey?: string }) => {
        if (typeof patch.apiKey === 'string') calls.push(patch.apiKey)
        return Promise.resolve({ enabled: true, provider: 'tavily', apiKey: '', hasKey: true })
      },
      setShellConfig: () => ({}),
      setCalendarConfig: () => ({}),
      pickIcsFile: () => ({ canceled: true })
    })
    const Harness: React.FC = () => {
      const tools = useAgentToolConfigs()
      return <AgentToolBars tools={tools} />
    }
    mountWithProviders(<Harness />)
    fireEvent.click(screen.getAllByText('工具配置')[0]!.closest('button') as HTMLElement)
  }

  beforeEach(() => { calls.length = 0 })

  it('Enter 提交后焦点被挤走（blur 紧跟）⇒ 通道只收到一发、且值是那条 Key', async () => {
    mount()
    const box = (await screen.findByPlaceholderText(L('agent.websearch.keyPlaceholder'))) as HTMLElement
    fireEvent.change(box, { target: { value: 'tvly-secret-123' } })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    fireEvent.blur(box) // 改前：弹窗抢 focus 走的正是这条路 ⇒ 这里会变成两发
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    await new Promise((r) => setTimeout(r, 30))
    expect(calls, '同一份凭据被写两次＝§336 修过的形状在另一张屏复发').toEqual(['tvly-secret-123'])
  })

  it('反向对照：只按 blur（粘完就点别处）仍然要写进去——那条"取消确认后重试"的路不许砍', async () => {
    mount()
    const box = (await screen.findByPlaceholderText(L('agent.websearch.keyPlaceholder'))) as HTMLElement
    fireEvent.change(box, { target: { value: 'tvly-blur-only' } })
    fireEvent.blur(box)
    await waitFor(() => expect(calls).toEqual(['tvly-blur-only']))
  })
})
