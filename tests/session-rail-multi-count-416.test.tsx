// §416：Agent 屏多选操作条的「已选 N」与对话屏同构——计数 shrink-0、不收缩；
// 这一条只钉类名归属（jsdom 没有布局，量不出真实宽度，宽度需真机读数背书）。
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { HookProviders, stubPocketai } from './helpers/renderer'
import { SessionRail } from '../src/renderer/src/modules/agent/components/SessionRail'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, ConversationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const conv = (id: string): ConversationRecord =>
  ({ id, title: `会话${id}`, assistantId: 'a1' }) as unknown as ConversationRecord

const assistant = { id: 'a1', name: '助手' } as unknown as AssistantRecord

beforeEach(() => {
  stubPocketai({ searchMessages: () => [] })
})

/** 挂载后经「批量导出 → 多选导出」进入多选态；再点一行选中它 */
function mountInSelectMode(): HTMLElement {
  render(
    <HookProviders>
      <SessionRail
        assistants={[assistant]}
        assistantId="a1"
        onAssistantChange={() => {}}
        conversations={[conv('c1'), conv('c2')]}
        conversationId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onBatchExport={() => {}}
        onBatchExportSelected={() => {}}
      />
    </HookProviders>
  )
  fireEvent.click(screen.getByLabelText(L('chat.exportBatch')))
  fireEvent.click(screen.getByText(L('chat.exportMulti')))
  fireEvent.click(screen.getByText('会话c2'))
  return screen.getByText('已选 1 个会话')
}

describe('Agent 多选导出计数可见性（§416）', () => {
  it('计数 1 条真实渲染出来，且不参与收缩：shrink-0、whitespace-nowrap、无 flex-1／truncate', () => {
    const count = mountInSelectMode()
    expect(count.textContent).toBe('已选 1 个会话')
    const cls = count.className
    expect(cls).toContain('shrink-0')
    expect(cls).toContain('whitespace-nowrap')
    expect(cls).not.toContain('flex-1')
    expect(cls).not.toContain('truncate')
  })

  it('剩余空间交给空占位；操作条可换行；三颗按钮都还在', () => {
    const count = mountInSelectMode()
    const spacer = count.nextElementSibling as HTMLElement | null
    expect(spacer).not.toBeNull()
    expect(spacer!.getAttribute('aria-hidden')).toBe('true')
    expect(spacer!.className).toContain('flex-1')
    expect(spacer!.className).toContain('min-w-0')
    expect(count.parentElement!.className).toContain('flex-wrap')
    expect(screen.getByText(L('chat.exportSelectedMd'))).toBeTruthy()
    expect(screen.getByText(L('chat.exportSelectedHtml'))).toBeTruthy()
    expect(screen.getByText(L('chat.exportSelectedPdf'))).toBeTruthy()
  })
})
