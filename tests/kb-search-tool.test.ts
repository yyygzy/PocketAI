// kb_search 内置工具测试
// 覆盖：kbIds 透传、top_k 钳制、片段截断与空白折叠、未绑定/空结果提示、错误透传
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/knowledge/rag', () => ({
  ragService: {
    retrieve: vi.fn(async () => ({ query: '', chunks: [] })),
    buildContext: vi.fn(() => '')
  }
}))

import { kbSearchTool } from '../src/main/tools/kb-search'
import { ragService } from '../src/main/knowledge/rag'

const retrieveMock = vi.mocked(ragService.retrieve)

function makeChunk(
  overrides: Partial<{
    chunkId: string
    docId: string
    docTitle: string
    content: string
    score: number
  }> = {}
) {
  return {
    chunkId: 'c1',
    docId: 'd1',
    docTitle: '产品手册',
    content: '这是文档片段内容',
    score: 0.123456,
    ...overrides
  }
}

beforeEach(() => {
  retrieveMock.mockReset()
})

describe('kb_search 工具', () => {
  it('未绑定知识库（无 ctx）时返回提示且不调 retrieve', async () => {
    const out = await kbSearchTool.execute({ query: '退款政策' })
    const parsed = JSON.parse(out) as { results: unknown[]; note: string }
    expect(parsed.results).toEqual([])
    expect(parsed.note).toContain('未绑定知识库')
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it('kbIds 为空数组时同样返回提示', async () => {
    const out = await kbSearchTool.execute({ query: 'x' }, { kbIds: [] })
    expect((JSON.parse(out) as { note: string }).note).toContain('未绑定知识库')
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it('query 为空或纯空白时抛错', async () => {
    await expect(
      kbSearchTool.execute({ query: '   ' }, { kbIds: ['kb1'] })
    ).rejects.toThrow('query 不能为空')
    await expect(kbSearchTool.execute({}, { kbIds: ['kb1'] })).rejects.toThrow('query 不能为空')
  })

  it('透传 kbIds 与默认 top_k=4 给 retrieve', async () => {
    retrieveMock.mockResolvedValue({ query: '退款', chunks: [] })
    await kbSearchTool.execute({ query: '退款' }, { kbIds: ['kb1', 'kb2'] })
    expect(retrieveMock).toHaveBeenCalledWith(['kb1', 'kb2'], '退款', { topN: 4 })
  })

  it('top_k 钳制：超上限取 8，非法值（0/负数/非数字）取默认 4', async () => {
    retrieveMock.mockResolvedValue({ query: 'q', chunks: [] })
    await kbSearchTool.execute({ query: 'q', top_k: 99 }, { kbIds: ['kb1'] })
    expect(retrieveMock).toHaveBeenLastCalledWith(['kb1'], 'q', { topN: 8 })
    await kbSearchTool.execute({ query: 'q', top_k: 0 }, { kbIds: ['kb1'] })
    expect(retrieveMock).toHaveBeenLastCalledWith(['kb1'], 'q', { topN: 4 })
    await kbSearchTool.execute({ query: 'q', top_k: -2 }, { kbIds: ['kb1'] })
    expect(retrieveMock).toHaveBeenLastCalledWith(['kb1'], 'q', { topN: 4 })
    await kbSearchTool.execute({ query: 'q', top_k: 'abc' }, { kbIds: ['kb1'] })
    expect(retrieveMock).toHaveBeenLastCalledWith(['kb1'], 'q', { topN: 4 })
  })

  it('结果映射：docTitle/docId/chunkId 透传，分数四舍五入到 4 位', async () => {
    retrieveMock.mockResolvedValue({
      query: 'q',
      chunks: [makeChunk({ score: 0.123456 })]
    })
    const out = await kbSearchTool.execute({ query: 'q' }, { kbIds: ['kb1'] })
    const parsed = JSON.parse(out) as {
      query: string
      results: Array<{ docTitle: string; docId: string; chunkId: string; content: string; score: number }>
    }
    expect(parsed.query).toBe('q')
    expect(parsed.results[0]).toMatchObject({
      docTitle: '产品手册',
      docId: 'd1',
      chunkId: 'c1',
      content: '这是文档片段内容',
      score: 0.1235
    })
  })

  it('片段内容空白折叠并按 350 字符截断加省略号', async () => {
    retrieveMock.mockResolvedValue({
      query: 'q',
      chunks: [makeChunk({ content: '第一行\n\n  第二行 ' + 'x'.repeat(400) })]
    })
    const out = await kbSearchTool.execute({ query: 'q' }, { kbIds: ['kb1'] })
    const parsed = JSON.parse(out) as { results: Array<{ content: string }> }
    const content = parsed.results[0]!.content
    expect(content.startsWith('第一行 第二行 xxx')).toBe(true)
    expect(content.length).toBe(350 + 1) // 350 字符 + '…'
    expect(content.endsWith('…')).toBe(true)
  })

  it('检索结果为空时返回「未检索到」提示', async () => {
    retrieveMock.mockResolvedValue({ query: 'q', chunks: [] })
    const out = await kbSearchTool.execute({ query: 'q' }, { kbIds: ['kb1'] })
    const parsed = JSON.parse(out) as { results: unknown[]; note: string }
    expect(parsed.results).toEqual([])
    expect(parsed.note).toContain('未检索到')
  })

  it('retrieve 抛错时透传（由 registry 统一转 isError 结果）', async () => {
    retrieveMock.mockRejectedValue(new Error('embedding 服务不可用'))
    await expect(kbSearchTool.execute({ query: 'q' }, { kbIds: ['kb1'] })).rejects.toThrow(
      'embedding 服务不可用'
    )
  })
})
