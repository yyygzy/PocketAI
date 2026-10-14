// KbDetail 真挂载：批量模式的接线半边（V4-Iter-138，把 B69/B70 里能断言的那半搬进 CI）
// @vitest-environment jsdom
//
// 上一批我写过「KbDetail 挂着 confirm/toast/十几条 IPC，挂不起来」——那是假设，不是证据。
// 实测：`useConfirm` 是自包含 hook（不需要 Provider），`{dialog}` 就渲染在 KbDetail 自己的 return 里，
// 于是"确认之前不许动手""复选框换语义""切库清选择"这些接线全都可以断言。
// 仍然只有肉眼的：配色、行灰显的观感、确认弹窗的排版——那些留在 B70。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { render } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ToastProvider } from '../src/renderer/src/components/ToastProvider'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, KbDocument } from '../src/shared/types'

const kb = (over: Partial<KnowledgeBase> = {}): KnowledgeBase => ({
  id: 'kbA',
  name: '库甲',
  description: '',
  embeddingProviderId: 'p1',
  embeddingModel: 'm1',
  embeddingDim: 3,
  chunkSize: 800,
  chunkOverlap: 200,
  topK: 20,
  topN: 5,
  minScore: 0,
  rerankProviderId: null,
  rerankModel: null,
  hydeProviderId: null,
  hydeModel: null,
  multiQueryProviderId: null,
  multiQueryModel: null,
  ocrProviderId: null,
  ocrModel: null,
  documentCount: 4,
  chunkCount: 9,
  createdAt: 0,
  ...over
})

const doc = (id: string, over: Partial<KbDocument> = {}): KbDocument => ({
  id,
  kbId: 'kbA',
  source: `${id}.md`,
  sourceType: 'txt',
  title: `文档 ${id}`,
  chunkCount: 2,
  status: 'ready',
  error: null,
  contentHash: null,
  enabled: true,
  createdAt: 1,
  ...over
})

/** 两条 ready（其中 dOff 已停用）+ 两条失败 */
const DOCS: KbDocument[] = [
  doc('d1'),
  doc('dOff', { enabled: false }),
  doc('d2', { status: 'error', error: 'PDF 未包含可提取文本' }),
  doc('d3', { status: 'error', error: 'embedding 服务 502' })
]

const H = vi.hoisted(() => ({
  docs: [] as unknown[],
  deleteFailIds: new Set<string>(),
  enqueued: 0
}))

const listKbDocuments = vi.fn()
const deleteKbDocument = vi.fn()
const setKbDocEnabled = vi.fn()
const reindexKbDocs = vi.fn()
const addKbFiles = vi.fn()

function mountDetail(props: { kbId?: string; onChanged?: () => void } = {}): void {
  mountWithProviders(
    <KbDetail
      kb={kb({ id: props.kbId ?? 'kbA' })}
      onChanged={props.onChanged ?? (() => {})}
    />
  )
}

const rowCheckbox = (label: string): HTMLElement[] => screen.getAllByLabelText(label)

beforeEach(() => {
  H.docs = [...DOCS]
  H.deleteFailIds = new Set()
  H.enqueued = 2
  listKbDocuments.mockReset()
  listKbDocuments.mockImplementation(async () => H.docs)
  deleteKbDocument.mockReset()
  deleteKbDocument.mockImplementation(async (id: string) => {
    if (H.deleteFailIds.has(String(id))) throw new Error(`删不掉 ${id}`)
    H.docs = H.docs.filter((d) => (d as KbDocument).id !== id)
    return { ok: true }
  })
  setKbDocEnabled.mockReset()
  setKbDocEnabled.mockResolvedValue({ ok: true })
  reindexKbDocs.mockReset()
  reindexKbDocs.mockImplementation(async (ids: string[]) => {
    H.enqueued = ids.length
    return { enqueued: H.enqueued }
  })
  stubPocketai({
    listKbDocuments,
    deleteKbDocument,
    setKbDocEnabled,
    reindexKbDocs,
    reindexKbDocument: vi.fn(async () => ({ ok: true })),
    addKbFiles: addKbFiles.mockResolvedValue({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
    listProviders: vi.fn(async () => []),
    listKbAskSessions: vi.fn(async () => []),
    getKbAskRetention: vi.fn(async () => ({ keepCount: 0, keepDays: 0 })),
    onKbAskChunk: vi.fn(() => () => {}),
    onKbAskDone: vi.fn(() => () => {}),
    onKbAskError: vi.fn(() => () => {}),
    reportPerf: vi.fn(async () => undefined)
  })
})

const enterBatch = async (): Promise<void> => {
  fireEvent.click(screen.getByText(zh['kb.batchMode']))
  await waitFor(() => expect(batchBar(0)).toBeTruthy())
}

/** 批量条本身：行里也有「删除」，所以按钮一律在批量条的容器里查，不用全局 getByText */
const batchBar = (selected: number): HTMLElement =>
  screen.getByText(zh['kb.batchSelected'].replace('{n}', String(selected))).parentElement as HTMLElement

const batchButton = (selected: number, label: string): HTMLElement =>
  within(batchBar(selected)).getByText(label)

describe('行首那个复选框的两种语义', () => {
  it('平时：勾选状态=是否参与检索，停用那条的提示语也是另一句', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    const on = rowCheckbox(zh['kb.docEnabled'])
    const off = rowCheckbox(zh['kb.docDisabled'])
    expect(on).toHaveLength(3) // d1 / d2 / d3 在检索里
    expect(off).toHaveLength(1) // dOff 不在
    expect((on[0] as HTMLInputElement).checked).toBe(true)
    expect((off[0] as HTMLInputElement).checked).toBe(false)
    // 反向对照：平时绝不该出现"选中此文档"这个语义
    expect(screen.queryAllByLabelText(zh['kb.batchPick'])).toHaveLength(0)
  })

  it('批量模式：同一批复选框换成"选中"，一条都不该预先勾着', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    expect(screen.getAllByLabelText(zh['kb.batchPick'])).toHaveLength(4)
    expect(screen.queryAllByLabelText(zh['kb.docEnabled'])).toHaveLength(0)
    expect(screen.getAllByLabelText(zh['kb.batchPick']).every((c) => !(c as HTMLInputElement).checked)).toBe(true)
  })

  it('批量模式里点第一行 ⇒「已选 1 篇」，再点一次 ⇒ 回到 0 篇（取消勾选不许只加不减）', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    const boxes = screen.getAllByLabelText(zh['kb.batchPick'])
    fireEvent.click(boxes[0]!)
    await waitFor(() => expect(screen.getByText(zh['kb.batchSelected'].replace('{n}', '1'))).toBeTruthy())
    fireEvent.click(screen.getAllByLabelText(zh['kb.batchPick'])[0]!)
    await waitFor(() => expect(screen.getByText(zh['kb.batchSelected'].replace('{n}', '0'))).toBeTruthy())
  })
})

describe('批量动作接到哪条通道', () => {
  it('删除前先弹确认；点「取消」⇒ 一次 deleteKbDocument 都不许发', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(screen.getAllByLabelText(zh['kb.batchPick'])[0]!)
    await waitFor(() => expect(batchBar(1)).toBeTruthy())
    fireEvent.click(batchButton(1, zh['common.delete']))
    await waitFor(() =>
      expect(screen.getByText(zh['kb.batchDeleteConfirm'].replace('{n}', '1'))).toBeTruthy()
    )
    fireEvent.click(screen.getByText(zh['common.cancel']))
    await waitFor(() => expect(pocketaiCalls().filter((c) => c.fn === 'deleteKbDocument')).toHaveLength(0))
  })

  it('确认后逐条删除，选择清空，且逐条调用的是既有单篇通道（本轮没新增批量删除 IPC）', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    await waitFor(() => expect(batchBar(4)).toBeTruthy())
    fireEvent.click(batchButton(4, zh['common.delete']))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDeleteConfirm'].replace('{n}', '4'))).toBeTruthy())
    fireEvent.click(screen.getByText(zh['common.confirm']))
    await waitFor(() => expect(deleteKbDocument).toHaveBeenCalledTimes(4))
    expect(deleteKbDocument.mock.calls.map((c) => c[0]).sort()).toEqual(['d1', 'd2', 'd3', 'dOff'])
    // 删完的幽灵选择不能留着数「已选 4 篇」
    await waitFor(() => expect(screen.getByText(zh['kb.batchSelected'].replace('{n}', '0'))).toBeTruthy())
    expect(screen.getByText(zh['kb.batchDone'].replace('{n}', '4').replace('{m}', '0'))).toBeTruthy()
  })

  it('部分失败要如实报差值，而不是"全部成功"', async () => {
    H.deleteFailIds = new Set(['d2'])
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    fireEvent.click(batchButton(4, zh['common.delete']))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDeleteConfirm'].replace('{n}', '4'))).toBeTruthy())
    fireEvent.click(screen.getByText(zh['common.confirm']))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDone'].replace('{n}', '3').replace('{m}', '1'))).toBeTruthy())
  })

  it('「重试全部失败（2）」只把 error 那两条交给批量重建通道', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchRetryErrors'].replace('{n}', '2')))
    await waitFor(() => expect(reindexKbDocs).toHaveBeenCalled())
    expect(reindexKbDocs.mock.calls[0]![0]).toEqual(['d2', 'd3'])
    expect(screen.getByText(zh['kb.batchDone'].replace('{n}', '2').replace('{m}', '0'))).toBeTruthy()
  })

  it('入队数少于选中数（文档刚好被别人删了）⇒ 报的是真实差值', async () => {
    reindexKbDocs.mockImplementation(async (ids: string[]) => ({ enqueued: ids.length - 1 }))
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchRetryErrors'].replace('{n}', '2')))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDone'].replace('{n}', '1').replace('{m}', '1'))).toBeTruthy())
  })

  it('停用/启用按选中逐条下发，enabled 参数不许写反', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    fireEvent.click(batchButton(4, zh['kb.batchDisable']))
    await waitFor(() => expect(setKbDocEnabled).toHaveBeenCalledTimes(4))
    expect(setKbDocEnabled.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['d1', false],
      ['dOff', false],
      ['d2', false],
      ['d3', false]
    ])
    // 上一次动作已把选择清空（设计如此），所以启用要重新选一遍
    await waitFor(() => expect(batchBar(0)).toBeTruthy())
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    fireEvent.click(batchButton(4, zh['kb.batchEnable']))
    await waitFor(() => expect(setKbDocEnabled).toHaveBeenCalledTimes(8))
    expect(setKbDocEnabled.mock.calls[4]!.slice(1)).toEqual(['d1', true])
  })
})

describe('safeHandle 的合同：失败是返回值，不是 reject', async () => {
  it('删除通道逐条返回 {ok:false} ⇒ 一篇都不算成功', async () => {
    deleteKbDocument.mockResolvedValue({ ok: false, error: '数据库被锁' })
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    fireEvent.click(batchButton(4, zh['common.delete']))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDeleteConfirm'].replace('{n}', '4'))).toBeTruthy())
    fireEvent.click(screen.getByText(zh['common.confirm']))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDone'].replace('{n}', '0').replace('{m}', '4'))).toBeTruthy())
  })

  it('停用里有几条被拒 ⇒「已处理 n 篇，失败 m 篇」按真实结果计，不看调用次数', async () => {
    setKbDocEnabled.mockImplementation(async (_kb: unknown, id: string) =>
      id === 'd2' ? { ok: false, error: '数据库被锁' } : { ok: true })
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    fireEvent.click(batchButton(4, zh['kb.batchDisable']))
    await waitFor(() => expect(screen.getByText(zh['kb.batchDone'].replace('{n}', '3').replace('{m}', '1'))).toBeTruthy())
  })

  it('批量重建通道返回 {ok:false} ⇒ 说错误，不许报"已处理 2 篇"', async () => {
    reindexKbDocs.mockResolvedValue({ ok: false, error: '知识库不存在' })
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchRetryErrors'].replace('{n}', '2')))
    await waitFor(() => expect(screen.getByText(/知识库不存在/)).toBeTruthy())
    expect(screen.queryByText(zh['kb.batchDone'].replace('{n}', '2').replace('{m}', '0'))).toBeNull()
  })

  it('添加文件通道失败（返回结构化失败）⇒ 要报错，不许当场崩或静默', async () => {
    addKbFiles.mockResolvedValue({ ok: false, error: '没有权限' })
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.upload']))
    await waitFor(() => expect(screen.getByText(/没有权限/)).toBeTruthy())
  })
})

describe('选择状态的两条不变量', () => {
  it('切库必须清空选择并退出批量模式（跨库残留会误删另一个库的文档）', async () => {
    // 要换 kb 重渲染，就必须连 Provider 一起重挂（render 返回的 rerender 会甩掉包装层）
    const wrap = (ui: React.ReactElement): React.ReactElement => (
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    )
    const { rerender } = render(wrap(<KbDetail kb={kb({ id: 'kbA' })} onChanged={() => {}} />))
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(screen.getAllByLabelText(zh['kb.batchPick'])[0]!)
    await waitFor(() => expect(screen.getByText(zh['kb.batchSelected'].replace('{n}', '1'))).toBeTruthy())

    listKbDocuments.mockImplementation(async () => H.docs.map((d) => ({ ...(d as KbDocument), kbId: 'kbB' })))
    rerender(wrap(<KbDetail kb={kb({ id: 'kbB' })} onChanged={() => {}} />))
    // 回到"批量操作"入口 = 已退出批量模式；上一库的选中不在场
    await waitFor(() => expect(screen.getByText(zh['kb.batchMode'])).toBeTruthy())
    expect(screen.queryByText(zh['kb.batchSelected'].replace('{n}', '1'))).toBeNull()
  })

  it('轮询发现某篇已不存在 ⇒「已选 N 篇」不许继续数它', async () => {
    mountDetail()
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    await enterBatch()
    fireEvent.click(batchButton(0, zh['kb.batchSelectAll']))
    await waitFor(() => expect(batchBar(4)).toBeTruthy())
    // 外部把 d2 删掉了（数据健康的去重、或另一个窗口），列表一刷新就该出清
    H.docs = H.docs.filter((d) => (d as KbDocument).id !== 'd2')
    // [0] 是批量条里的「重建」（那会清空选择），[1] 才是第一行的单篇重建：只触发刷新，不该清选择
    fireEvent.click(screen.getAllByText(zh['kb.reindex'])[1]!)
    await waitFor(() => expect(batchBar(3)).toBeTruthy())
  })
})
