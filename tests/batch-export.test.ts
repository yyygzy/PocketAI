// 批量导出共用核心测试（V4-Iter-24 多选导出抽取自 ChatModule/AgentPanel 的重复循环）
//
// 覆盖 src/renderer/src/utils/batch-export.ts：
// - capSelection：空/不足上限原样/超上限截断保序
// - buildBatchExportFiles：md/html 组装、文件名 safeFileName、顺序、onProgress、让帧不崩
//   （listMessages/resolveAssistantName 内存 stub，buildConversationHtml 在 node 下可跑——export-markdown.test 已验证链路）
import { describe, it, expect } from 'vitest'
import type { ConversationRecord, MessageRecord } from '../src/shared/types'
import { capSelection, buildBatchExportFiles, BATCH_EXPORT_MAX } from '../src/renderer/src/utils/batch-export'

const conv = (id: string, title: string, over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id,
  title,
  assistantId: 'a1',
  modelLabel: null,
  status: 'active',
  pinned: false,
  archived: false,
  titleDefault: true,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

function msg(id: string, role: 'user' | 'assistant', content: string): MessageRecord {
  return { id, conversationId: 'c1', role, content, provider: null, model: null, status: 'done', parentId: null, createdAt: 1 }
}

describe('capSelection', () => {
  it('空数组：原样返回，dropped=0', () => {
    expect(capSelection([])).toEqual({ list: [], dropped: 0 })
  })

  it('少于上限：原样返回不截断', () => {
    const list = [conv('a', 'A'), conv('b', 'B')]
    const r = capSelection(list)
    expect(r.list).toBe(list)
    expect(r.dropped).toBe(0)
  })

  it('超上限：保留前 max 个（保序），dropped 计数正确', () => {
    const list = Array.from({ length: BATCH_EXPORT_MAX + 7 }, (_, i) => conv(`c${i}`, `会话${i}`))
    const r = capSelection(list)
    expect(r.list).toHaveLength(BATCH_EXPORT_MAX)
    expect(r.list[0]!.id).toBe('c0')
    expect(r.dropped).toBe(7)
  })

  it('自定义 max 生效', () => {
    const list = [conv('a', 'A'), conv('b', 'B'), conv('c', 'C')]
    expect(capSelection(list, 2)).toEqual({ list: [list[0], list[1]], dropped: 1 })
  })
})

describe('buildBatchExportFiles', () => {
  const convs = [conv('c1', '测试:会话一'), conv('c2', '会话二'), conv('c3', '会话三')]
  const store = new Map<string, MessageRecord[]>([
    ['c1', [msg('m1', 'user', '你好'), msg('m2', 'assistant', '# 回答标题\n\n正文')]],
    ['c2', [msg('m3', 'user', '第二个问题'), msg('m4', 'assistant', '第二个回答')]],
    ['c3', [msg('m5', 'user', '第三个问题'), msg('m6', 'assistant', '第三个回答')]]
  ])
  const deps = {
    listMessages: (id: string) => Promise.resolve(store.get(id) ?? []),
    resolveAssistantName: (assistantId: string | null) => (assistantId === 'a1' ? '通用问答助手' : null)
  }

  it('md 路径：按顺序产出 safeFileName(title).md，内容含正文', async () => {
    const files = await buildBatchExportFiles({ convs, format: 'md', ...deps })
    expect(files).toHaveLength(3)
    // safeFileName 替换 Windows 非法字符冒号
    expect(files[0]!.name).toBe('测试_会话一.md')
    expect(files[1]!.name).toBe('会话二.md')
    expect(files[0]!.content).toContain('# 回答标题')
    expect(files[0]!.content).toContain('你好')
  })

  it('html 路径：产出 .html 且为自包含 HTML 文档', async () => {
    const files = await buildBatchExportFiles({ convs: convs.slice(0, 1), format: 'html', ...deps })
    expect(files[0]!.name).toBe('测试_会话一.html')
    expect(files[0]!.content).toContain('</html>')
    expect(files[0]!.content).toContain('回答标题')
  })

  it('onProgress 逐个回调 done/total', async () => {
    const seen: Array<[number, number]> = []
    await buildBatchExportFiles({
      convs,
      format: 'md',
      ...deps,
      onProgress: (done, total) => seen.push([done, total])
    })
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('消息为空的会话也产出文件（正文空但不缺文件）', async () => {
    const files = await buildBatchExportFiles({ convs: [conv('cx', '空会话')], format: 'md', ...deps })
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe('空会话.md')
  })
})
