// §416：多选操作条的「已选 N 条」曾被 flex-1 + truncate 收成 0 宽
//
// 元素一直在 DOM 里，所以「查得到」不能证明它看得见。这里钉的是**布局归属**：
// 计数节点自己是 shrink-0（不参与收缩），能伸缩的是旁边的空占位（flex-1）；
// 且计数不带 truncate（宽度不会被裁成 0）。四语文案长度不同，但这条分配与文案无关。
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { HookProviders, stubPocketai } from './helpers/renderer'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { ConversationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const conv = (id: string): ConversationRecord =>
  ({ id, title: `会话${id}`, assistantId: 'a1' }) as unknown as ConversationRecord

beforeEach(() => {
  stubPocketai({
    listConversationGroups: () => [],
    searchMessages: () => [],
    setConversationPinned: () => ({ ok: true }),
    setConversationArchived: () => ({ ok: true })
  })
})

/** 挂载后经「批量导出 → 多选导出」进入多选态；再点一行选中它 */
function mountInSelectMode(): HTMLElement {
  render(
    <HookProviders>
      <ConversationList
        conversations={[conv('c1'), conv('c2')]}
        currentId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onBatchExport={() => {}}
        onBatchExportSelected={() => {}}
        onBatchDelete={() => {}}
      />
    </HookProviders>
  )
  fireEvent.click(screen.getByLabelText(L('chat.exportBatch')))
  fireEvent.click(screen.getByText(L('chat.exportMulti')))
  fireEvent.click(screen.getByText('会话c2'))
  return screen.getByTestId('conv-multi-count')
}

describe('多选导出计数可见性（§416）', () => {
  it('计数 1 条真实渲染出来，且不参与收缩：shrink-0、无 flex-1／truncate', () => {
    const count = mountInSelectMode()
    expect(count.textContent).toBe('已选 1 个会话')
    const cls = count.className
    expect(cls).toContain('shrink-0')
    expect(cls).not.toContain('flex-1')
    expect(cls).not.toContain('truncate')
    // 不靠固定宽度：没有任何 w-*/min-w-/max-w- 的像素宽度
    expect(cls).not.toMatch(/\bw-|min-w-|max-w-/)
  })

  it('剩余空间交给空占位（flex-1）；操作条可换行，窄栏放不下时计数也不会被挤掉', () => {
    const count = mountInSelectMode()
    const spacer = count.nextElementSibling as HTMLElement | null
    expect(spacer).not.toBeNull()
    expect(spacer!.getAttribute('aria-hidden')).toBe('true')
    expect(spacer!.className).toContain('flex-1')
    expect(spacer!.className).not.toContain('truncate')
    // 计数与按钮不在同一层级争抢收缩：外层允许换行
    expect(count.parentElement!.className).toContain('flex-wrap')
    // 四颗动作按钮都还在（没有为了给计数腾位置而消失）
    expect(screen.getByText(L('chat.exportSelectedMd'))).toBeTruthy()
    expect(screen.getByText(L('chat.exportSelectedHtml'))).toBeTruthy()
    expect(screen.getByText(L('chat.exportSelectedPdf'))).toBeTruthy()
    expect(screen.getByText(L('chat.batchDelete'))).toBeTruthy()
  })

  it('四语计数文案都带 n，且长度差异由同一套 flex 分配吸收（不靠固定宽度）', () => {
    const dicts = [zh, en, ja, ko] as Array<Record<string, string>>
    for (const dict of dicts) {
      expect(dict['chat.exportMultiCount']).toBeTruthy()
      const text = (dict['chat.exportMultiCount'] ?? '').replace('{n}', '12')
      expect(text).toContain('12')
    }
  })
})
