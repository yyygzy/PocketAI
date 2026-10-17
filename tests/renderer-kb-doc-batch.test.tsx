// 文档批量操作条（V4-Iter-136）：能 DOM 断言的那一半进 CI，纯决策层另设一组
// @vitest-environment jsdom
//
// 为什么要拆得出：`KbDetail` 挂着 confirm/toast/十几条 IPC，测不动；
// 但「按钮什么时候该禁用」「失败篇数从哪来」「选中项会不会变成幽灵」都是可断言的判断，
// 于是把决策收进 `doc-batch.ts`、把展示收进 `DocBatchBar`，两边各测各的。
// 剩下只有肉眼的：整行的灰显观感、复选框换语义后的排版、以及确认弹窗真的弹在删除前 ⇒ 校验清单 B70。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { DocBatchBar, type DocBatchBarProps } from '../src/renderer/src/modules/knowledge/DocBatchBar'
import { cullStale, errorDocIds, selectByMode, toggleSelected } from '../src/renderer/src/modules/knowledge/doc-batch'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbDocument } from '../src/shared/types'

function doc(over: Partial<KbDocument> = {}): KbDocument {
  return {
    id: 'd1',
    kbId: 'kb1',
    source: 'a.md',
    sourceType: 'txt',
    title: '文档一',
    chunkCount: 3,
    status: 'ready',
    error: null,
    contentHash: null,
    enabled: true,
    createdAt: 1,
    ...over
  }
}

const DOCS: KbDocument[] = [
  doc({ id: 'd1', status: 'ready' }),
  doc({ id: 'd2', status: 'error', error: '解析失败' }),
  doc({ id: 'd3', status: 'error', error: 'embedding 服务 502' }),
  doc({ id: 'd4', status: 'indexing' })
]

const text = (key: keyof typeof zh, n?: string | number): string =>
  n === undefined ? zh[key] : zh[key].replace('{n}', String(n))

function mountBar(over: Partial<DocBatchBarProps> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const cbs = {
    onEnter: vi.fn(),
    onExit: vi.fn(),
    onSelectMode: vi.fn(),
    onClear: vi.fn(),
    onReindex: vi.fn(),
    onSetEnabled: vi.fn(),
    onDelete: vi.fn()
  }
  mountWithProviders(
    <DocBatchBar
      docs={DOCS}
      batchMode={false}
      selected={[]}
      busy={false}
      {...cbs}
      {...over}
    />
  )
  return cbs
}

describe('doc-batch 纯决策层', () => {
  it('errorDocIds 只认 status=error（pending / indexing / ready 都不算"失败"）', () => {
    expect(errorDocIds(DOCS)).toEqual(['d2', 'd3'])
    expect(errorDocIds([doc({ id: 'x', status: 'pending' }), doc({ id: 'y', status: 'indexing' })])).toEqual([])
  })

  it('toggleSelected 勾上与取消，且不改调用方的数组', () => {
    const base = ['d1']
    const added = toggleSelected(base, 'd3')
    expect(added).toEqual(['d1', 'd3'])
    expect(base).toEqual(['d1'])
    expect(toggleSelected(added, 'd1')).toEqual(['d3'])
  })

  it('cullStale：文档被删掉后选择里不许留幽灵（保留勾选先后，不重排）', () => {
    expect(cullStale(['d1', 'd2', 'd9'], [DOCS[2]!, DOCS[1]!, DOCS[0]!])).toEqual(['d1', 'd2'])
    expect(cullStale(['d9', 'd8'], [DOCS[0]!])).toEqual([])
  })

  it('selectByMode 的结果与列表同序（批量处理顺序不该随机）', () => {
    expect(selectByMode(DOCS, 'all')).toEqual(['d1', 'd2', 'd3', 'd4'])
    expect(selectByMode(DOCS, 'errors')).toEqual(['d2', 'd3'])
  })
})

describe('DocBatchBar 的可供性与禁用', () => {
  it('非批量模式只有一个「批量操作」入口，没有任何计数与动作按钮', () => {
    stubPocketai({})
    mountBar()
    expect(screen.getByText(text('kb.batchMode'))).toBeTruthy()
    expect(screen.queryByText(text('kb.batchSelected', 0))).toBeNull()
    expect(screen.queryByText(text('kb.batchRetryErrors', 2))).toBeNull()
  })

  it('库内一篇文档都没有时，批量入口是禁用的（进去也只能对着空列表干瞪眼）', () => {
    stubPocketai({})
    mountBar({ docs: [] })
    expect((screen.getByText(text('kb.batchMode')) as HTMLButtonElement).disabled).toBe(true)
  })

  it('批量模式但零选中：四个动作与「取消选择」全禁用，「全选」仍可用', () => {
    stubPocketai({})
    mountBar({ batchMode: true, selected: [] })
    expect(screen.getByText(text('kb.batchSelected', 0))).toBeTruthy()
    for (const label of [text('kb.reindex'), text('kb.batchEnable'), text('kb.batchDisable'), text('common.delete'), text('kb.batchClear')]) {
      expect((screen.getByText(label) as HTMLButtonElement).disabled).toBe(true)
    }
    expect((screen.getByText(text('kb.batchSelectAll')) as HTMLButtonElement).disabled).toBe(false)
  })

  it('勾了两篇：动作可用，点删除/重建把**选中的那两个 id**交回调用方', () => {
    stubPocketai({})
    const cbs = mountBar({ batchMode: true, selected: ['d1', 'd3'] })
    fireEvent.click(screen.getByText(text('common.delete')))
    expect(cbs.onDelete!.mock.calls[0]![0]).toEqual(['d1', 'd3'])
    fireEvent.click(screen.getByText(text('kb.reindex')))
    expect(cbs.onReindex!.mock.calls[0]![0]).toEqual(['d1', 'd3'])
    fireEvent.click(screen.getByText(text('kb.batchDisable')))
    expect(cbs.onSetEnabled!.mock.calls[0]).toEqual([['d1', 'd3'], false])
  })

  it('busy 期间即便有选中也不许再发动作（删除与重建都要等上一轮）', () => {
    stubPocketai({})
    mountBar({ batchMode: true, selected: ['d1'], busy: true })
    expect((screen.getByText(text('common.delete')) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText(text('kb.reindex')) as HTMLButtonElement).disabled).toBe(true)
  })

  it('有失败项才出现「全选失败项（2）」与「重试全部失败（2）」，重试只把 error 的 id 交给重建', () => {
    stubPocketai({})
    const cbs = mountBar({ batchMode: true, selected: [] })
    fireEvent.click(screen.getByText(text('kb.batchSelectErrors', 2)))
    expect(cbs.onSelectMode!.mock.calls[0]).toEqual(['errors'])
    fireEvent.click(screen.getByText(text('kb.batchRetryErrors', 2)))
    expect(cbs.onReindex!.mock.calls[0]![0]).toEqual(['d2', 'd3'])
  })

  it('反向对照：库里没有失败文档时，那两个按钮都不该出现（别给一个永远为 0 的入口）', () => {
    stubPocketai({})
    mountBar({ batchMode: true, docs: [doc({ id: 'd1', status: 'ready' })] })
    expect(screen.queryByText(text('kb.batchSelectErrors', 0))).toBeNull()
    expect(screen.queryByText(text('kb.batchRetryErrors', 0))).toBeNull()
  })

  it('退出批量与清空选择各自回调到调用方（选中集合的收口在 KbDetail 那一层）', () => {
    stubPocketai({})
    const cbs = mountBar({ batchMode: true, selected: ['d2'] })
    fireEvent.click(screen.getByText(text('kb.batchClear')))
    expect(cbs.onClear!).toHaveBeenCalled()
    fireEvent.click(screen.getByText(text('kb.batchExit')))
    expect(cbs.onExit!).toHaveBeenCalled()
  })
})
