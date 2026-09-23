// 知识库摄取管线纯函数测试：分块 / 类型探测 / 文档解析 / 余弦相似度 / RAG context 拼装
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与 agent-security.test.ts 相同的最小 mock：repos → database → electron 依赖链
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
vi.mock('../src/main/db/database', () => {
  const store = new Map<string, string>()
  const makeStmt = (sql: string) => ({
    get(...args: unknown[]) {
      if (sql.startsWith('SELECT')) {
        const v = store.get(String(args[0]))
        return v === undefined ? undefined : { value: v }
      }
      return undefined
    },
    run(...args: unknown[]) {
      if (sql.startsWith('INSERT')) store.set(String(args[0]), String(args[1]))
      else if (sql.startsWith('DELETE')) store.delete(String(args[0]))
      return { changes: 1, lastInsertRowid: 0 }
    }
  })
  return {
    LATEST_SCHEMA_VERSION: 0,
    DatabaseService: class {},
    dbService: { getHandle: () => ({ prepare: (sql: string) => makeStmt(sql) }) }
  }
})

import { chunkText } from '../src/main/knowledge/chunker'
import { detectSourceType, parseDocument } from '../src/main/knowledge/parsers'
import { cosineSimilarity } from '../src/main/db/repositories/kb-chunk.repo'
import { ragService } from '../src/main/knowledge/rag'

// ---------- 临时文件工具 ----------
let tmpDir: string
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-kb-test-'))
})
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
function writeTmp(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

describe('chunkText — 文本分块', () => {
  it('空串 / 纯空白 → 空数组', () => {
    expect(chunkText('', { chunkSize: 100, chunkOverlap: 10 })).toEqual([])
    expect(chunkText('   \n\t\n  ', { chunkSize: 100, chunkOverlap: 10 })).toEqual([])
  })

  it('短文本 → 单块且 sequence=0', () => {
    expect(chunkText('hello', { chunkSize: 100, chunkOverlap: 10 })).toEqual([
      { content: 'hello', sequence: 0 }
    ])
  })

  it('规范化：CRLF/NBSP/连续空行/首尾空白', () => {
    const out = chunkText('  a\r\nb\u00a0c\n\n\n\n\nd  ', { chunkSize: 100, chunkOverlap: 10 })
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('a\nb c\n\nd')
  })

  it('无边界长文本按固定步长切分：块长不超过 chunkSize', () => {
    const text = 'a'.repeat(130)
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 10 })
    // pos: 0 → +40 → +40 → 尾块：共 3 块，每块 50 字
    expect(chunks.map((c) => c.content.length)).toEqual([50, 50, 50])
    chunks.forEach((c) => expect(c.content.length).toBeLessThanOrEqual(50))
  })

  it('无重叠时尾块为剩余部分（30 字）', () => {
    const chunks = chunkText('a'.repeat(130), { chunkSize: 50, chunkOverlap: 0 })
    expect(chunks.map((c) => c.content.length)).toEqual([50, 50, 30])
  })

  it('优先在段落边界断开：段落标记之后的内容进入下一块', () => {
    const p1 = '一'.repeat(40)
    const p2 = '二'.repeat(40)
    const chunks = chunkText(`${p1}\n\n${p2}`, { chunkSize: 50, chunkOverlap: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.content).toBe(p1)
    expect(chunks[0]!.content).not.toContain('二')
    expect(chunks.some((c) => c.content.includes(p2))).toBe(true)
  })

  it('sequence 始终从 0 连续递增', () => {
    const text = '句子。'.repeat(200)
    const chunks = chunkText(text, { chunkSize: 80, chunkOverlap: 12 })
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => expect(c.sequence).toBe(i))
  })

  it('任意输入下不产生死循环且所有内容被覆盖（拼回去重合并包含原字）', () => {
    const text = Array.from({ length: 500 }, (_, i) => `第${i}段内容，用于测试分块覆盖。`).join('\n\n')
    const chunks = chunkText(text, { chunkSize: 120, chunkOverlap: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    // 首块包含开头、末块包含结尾（重叠拼接保证全量覆盖）
    expect(chunks[0]!.content).toContain('第0段')
    expect(chunks[chunks.length - 1]!.content).toContain('第499段')
  })
})

describe('detectSourceType — 来源类型探测', () => {
  it('http/https（含查询串）→ url', () => {
    expect(detectSourceType('https://a.com/x?y=1')).toBe('url')
    expect(detectSourceType('http://localhost:8080/')).toBe('url')
  })
  it('扩展名映射（大小写不敏感）', () => {
    expect(detectSourceType('a.PDF')).toBe('pdf')
    expect(detectSourceType('a.docx')).toBe('docx')
    expect(detectSourceType('a.XLSX')).toBe('xlsx')
    expect(detectSourceType('a.xls')).toBe('xlsx')
    expect(detectSourceType('a.htm')).toBe('html')
    expect(detectSourceType('a.md')).toBe('md')
    expect(detectSourceType('a.markdown')).toBe('md')
    expect(detectSourceType('a.csv')).toBe('txt')
    expect(detectSourceType('a.json')).toBe('txt')
    expect(detectSourceType('a.log')).toBe('txt')
  })
  it('未知扩展名 → 兜底 txt（不抛异常）', () => {
    expect(detectSourceType('a.unknownext')).toBe('txt')
    expect(detectSourceType('noext')).toBe('txt')
  })
})

describe('parseDocument — 真实文件解析', () => {
  it('txt：正文原样返回，title 取文件名', () => {
    const p = writeTmp('note.txt', '第一行\n第二行')
    return parseDocument(p, 'txt').then((r) => {
      expect(r.text).toBe('第一行\n第二行')
      expect(r.title).toBe('note.txt')
    })
  })

  it('html：提取标题与正文，移除 script/style/nav 噪声', async () => {
    const html = '<html><head><title>我的标题</title><style>.x{color:red}</style></head>'
      + '<body><nav>导航菜单</nav><h1>大标题</h1><p>正文内容123</p>'
      + '<script>alert("bad")</script></body></html>'
    const p = writeTmp('page.html', html)
    const r = await parseDocument(p, 'html')
    expect(r.title).toBe('我的标题')
    expect(r.text).toContain('正文内容123')
    expect(r.text).not.toContain('alert')
    expect(r.text).not.toContain('color:red')
    expect(r.text).not.toContain('导航菜单')
  })

  it('html 无 title 时回退到 h1', async () => {
    const p = writeTmp('noh1.html', '<html><body><h1>回退标题</h1><p>x</p></body></html>')
    const r = await parseDocument(p, 'html')
    expect(r.title).toBe('回退标题')
  })

  it('文件不存在 → 抛异常', async () => {
    await expect(parseDocument(path.join(tmpDir, 'missing.txt'), 'txt')).rejects.toBeTruthy()
  })
})

describe('cosineSimilarity — 纯 JS 向量相似度', () => {
  it('同向 → 1，正交 → 0，反向 → -1', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1)
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0)
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1)
  })
  it('非单位向量归一化正确（3,4 勾股）', () => {
    expect(cosineSimilarity(Float32Array.from([3, 4]), Float32Array.from([3, 4]))).toBeCloseTo(1)
    expect(cosineSimilarity(Float32Array.from([3, 4]), Float32Array.from([-3, -4]))).toBeCloseTo(-1)
  })
  it('零向量 → 0 而非 NaN（防止污染 KNN 排序）', () => {
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0)
    expect(Number.isNaN(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([0, 0])))).toBe(false)
  })
})

describe('ragService.buildContext — 上下文拼装', () => {
  it('空数组 → 空串', () => {
    expect(ragService.buildContext([])).toBe('')
  })
  it('多块按 [标题]\\n正文 拼装并用分隔线连接', () => {
    const ctx = ragService.buildContext([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { docTitle: '文档A', content: '内容A' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { docTitle: '文档B', content: '内容B' } as any
    ])
    expect(ctx).toContain('[文档A]\n内容A')
    expect(ctx).toContain('[文档B]\n内容B')
    expect(ctx).toContain('---')
    expect(ctx.startsWith('以下是相关知识库内容')).toBe(true)
  })
})
