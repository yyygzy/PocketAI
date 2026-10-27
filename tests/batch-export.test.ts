// 批量导出共用核心测试（V4-Iter-24 多选导出抽取自 ChatModule/AgentPanel 的重复循环）
//
// 覆盖 src/renderer/src/utils/batch-export.ts：
// - capSelection：空/不足上限原样/超上限截断保序
// - buildBatchExportFiles：md/html 组装、文件名 safeFileName、顺序、onProgress、让帧不崩
//   （listMessages/resolveAssistantName 内存 stub，buildConversationHtml 在 node 下可跑——export-markdown.test 已验证链路）
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ConversationRecord, MessageRecord } from '../src/shared/types'
import { capSelection, buildBatchExportFiles, finishBatchExport, reportBatchOutcome, BATCH_EXPORT_MAX, BATCH_PDF_MAX } from '../src/renderer/src/utils/batch-export'
import { zh } from '../src/renderer/src/i18n/zh'

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
    const { files } = await buildBatchExportFiles({ convs, format: 'md', ...deps })
    expect(files).toHaveLength(3)
    // safeFileName 替换 Windows 非法字符冒号
    expect(files[0]!.name).toBe('测试_会话一.md')
    expect(files[1]!.name).toBe('会话二.md')
    expect(files[0]!.content).toContain('# 回答标题')
    expect(files[0]!.content).toContain('你好')
  })

  it('html 路径：产出 .html 且为自包含 HTML 文档', async () => {
    const { files } = await buildBatchExportFiles({ convs: convs.slice(0, 1), format: 'html', ...deps })
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
    const { files } = await buildBatchExportFiles({ convs: [conv('cx', '空会话')], format: 'md', ...deps })
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe('空会话.md')
  })

  it('pdf 路径：产出 .pdf 扩展名，content 仍为自包含 HTML（主进程负责转换）', async () => {
    const { files } = await buildBatchExportFiles({ convs: convs.slice(0, 1), format: 'pdf', ...deps })
    expect(files[0]!.name).toBe('测试_会话一.pdf')
    expect(files[0]!.content).toContain('</html>')
    expect(files[0]!.content).toContain('回答标题')
  })
})

describe('finishBatchExport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubPocketai = (pdfBatch: ReturnType<typeof vi.fn>, batch?: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal('window', {
      pocketai: {
        exportConversationsPdfBatch: pdfBatch,
        exportConversationsBatch: batch ?? vi.fn()
      }
    })
  }

  it('pdf 分支走 exportConversationsPdfBatch 且透传结果', async () => {
    const pdfBatch = vi.fn().mockResolvedValue({ ok: true, count: 2, dir: '/tmp/x', failed: ['b.pdf'] })
    const batch = vi.fn()
    stubPocketai(pdfBatch, batch)
    const outcome = await finishBatchExport([{ name: 'a.pdf', content: '<html></html>' }], 'pdf')
    expect(pdfBatch).toHaveBeenCalledTimes(1)
    expect(batch).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'done', count: 2, dir: '/tmp/x', failedCount: 1 })
  })

  it('md/html 分支仍走既有通道；canceled 归一化', async () => {
    const batch = vi.fn().mockResolvedValue({ ok: true, canceled: true })
    stubPocketai(vi.fn(), batch)
    expect(await finishBatchExport([{ name: 'a.md', content: '# t' }], 'md')).toEqual({ kind: 'canceled' })
    expect(batch).toHaveBeenCalledTimes(1)
  })

  it('BATCH_PDF_MAX = 50（conversations.ts PDF_BATCH handler 同值）', () => {
    expect(BATCH_PDF_MAX).toBe(50)
  })
})


// ---------- V4-Iter-329：批量导出的「读不到」与「一个都没成」 ----------

/**
 * 两条账要分开：
 *  · `listMessages` 是**注入回调**，§217 那道 AST 闸门看不见它（扫描器只认 `window.pocketai.` 字面链根），
 *    而 `safeHandle` 把失败转成 resolve 的 `{ok:false}` ⇒ 改前它直接进渲染函数得 TypeError，
 *    整批停产、已构建的那些一起丢，toast 是一句「…is not iterable」的天书；
 *  · 主进程写盘那侧全失败仍回 `{ok:true,count:0,failed:[…]}` ⇒ 改前走 `toast.success`，
 *    绿色那句「已导出 0 个文件（N 个失败）」在替用户演成功。
 */
describe('329 buildBatchExportFiles 判失败面', () => {
  const convs = [conv('c1', '会话一'), conv('c2', '会话二'), conv('c3', '会话三')]
  const ok = (id: string): MessageRecord[] => [msg('m-' + id, 'user', '问 ' + id), msg('r-' + id, 'assistant', '答 ' + id)]

  it('中间那一发的消息读不到 ⇒ 跳过它并计数，其余照常出货（不再整批停产）', async () => {
    const seen: Array<[number, number]> = []
    const { files, unreadable } = await buildBatchExportFiles({
      convs,
      format: 'md',
      listMessages: (id) => (id === 'c2' ? Promise.resolve({ ok: false, error: '数据库被占用' } as const) : Promise.resolve(ok(id))),
      resolveAssistantName: () => '通用问答助手',
      onProgress: (done, total) => seen.push([done, total])
    })
    expect(unreadable).toBe(1)
    expect(files.map((f) => f.name)).toEqual(['会话一.md', '会话三.md'])
    // 坏那一步的进度照样要报：不然界面上的 done/total 会永远差一格
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('反向对照：全都读得到 ⇒ unreadable=0，三份文件一个不少', async () => {
    const { files, unreadable } = await buildBatchExportFiles({
      convs,
      format: 'md',
      listMessages: (id) => Promise.resolve(ok(id)),
      resolveAssistantName: () => null
    })
    expect(unreadable).toBe(0)
    expect(files).toHaveLength(3)
  })

  it('一个会话都读不到 ⇒ files 空数组（调用方据此不再发那一发写盘），而不是抛出去', async () => {
    const { files, unreadable } = await buildBatchExportFiles({
      convs,
      format: 'md',
      listMessages: () => Promise.resolve({ ok: false, error: '通道炸了' } as const),
      resolveAssistantName: () => null
    })
    expect(files).toEqual([])
    expect(unreadable).toBe(3)
  })
})

describe('329 reportBatchOutcome 话术', () => {
  /** 逐字取自字典（字典少键这里当场抛，比断「有个 toast」有用） */
  const t = (key: string, args?: Record<string, string | number>): string => {
    const raw = (zh as Record<string, string>)[key]
    if (raw === undefined) throw new Error(`字典里没有 ${key}`)
    return Object.entries(args ?? {}).reduce<string>((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), raw)
  }
  const newToast = () => {
    const calls: string[] = []
    const lines: string[] = []
    return {
      calls,
      lines,
      toast: {
        success: (m: string) => { calls.push('success'); lines.push(m) },
        error: (m: string) => { calls.push('error'); lines.push(m) },
        info: (m: string) => { calls.push('info'); lines.push(m) }
      }
    }
  }

  it('一个都没落地 ⇒ 红的那句，数＝写不进＋读不到（不许报绿）', () => {
    const h = newToast()
    reportBatchOutcome(
      h.toast, t, { kind: 'done', count: 0, dir: '/d', failedCount: 2 }, 1, '未知错误'
    )
    expect(h.calls).toEqual(['error'])
    expect(h.lines[0]).toBe(t('chat.exportBatchAllFailed', { n: 3 }))
  })

  it('部分成功 ⇒ 绿的句子带上两笔账：几个失败、几个读不到（分开说）', () => {
    const h = newToast()
    reportBatchOutcome(
      h.toast, t, { kind: 'done', count: 4, dir: '/d', failedCount: 1 }, 2, '未知错误'
    )
    expect(h.calls).toEqual(['success'])
    expect(h.lines[0]).toBe(
      `${t('chat.exportBatchDone', { n: 4, dir: '/d' })}（1 ${t('chat.exportBatchFailed')}）（${t('chat.exportBatchUnreadable', { n: 2 })}）`
    )
  })

  it('主进程整发失败 ⇒ 原因照说，并仍带上「几个会话读不到」那半句（两件事不互相顶掉）', () => {
    const h = newToast()
    reportBatchOutcome(h.toast, t, { kind: 'failed', error: '磁盘只读' }, 1, '未知错误')
    expect(h.calls).toEqual(['error'])
    expect(h.lines[0]).toBe(
      `${t('chat.exportFail', { e: '磁盘只读' })}（${t('chat.exportBatchUnreadable', { n: 1 })}）`
    )
  })

  it('反向对照：用户在目录对话框里取消 ⇒ 一句都不说（不是失败，也别报成功）', () => {
    const h = newToast()
    reportBatchOutcome(h.toast, t, { kind: 'canceled' }, 0, '未知错误')
    expect(h.calls).toEqual([])
    expect(h.lines).toEqual([])
  })
})
