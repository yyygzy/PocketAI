// 聊天附件扩展：文本/代码白名单 + PDF/DOCX/XLSX/HTML 走主进程字节解析。
// 这里用真实 xlsx 字节与真实 HTML 解析证明「不落临时文件也能提取文本」，
// 再用 jsdom File 证明渲染层把 .java/.svg 当文本、把 .pdf 交给 IPC。
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { parseDocumentBytes } from '../src/main/knowledge/parsers'
import {
  ATTACHMENT_ACCEPT,
  readFileAsAttachment
} from '../src/renderer/src/components/agent/agent-shared'

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).pocketai
})

describe('主进程：文档字节直接解析', () => {
  it('XLSX 字节 → 按 sheet 产出「列名: 值」行式文本', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['姓名', '年龄'], ['张三', 18]]), '人员')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    const parsed = await parseDocumentBytes('花名册.xlsx', new Uint8Array(buf))

    expect(parsed.title).toBe('花名册.xlsx')
    expect(parsed.text).toContain('# 人员')
    expect(parsed.text).toContain('姓名: 张三')
    expect(parsed.text).toContain('年龄: 18')
  })

  it('HTML 字节 → 去标签后只留正文', async () => {
    const parsed = await parseDocumentBytes(
      '页面.html',
      new Uint8Array(Buffer.from('<html><head><title>标题</title><style>p{color:red}</style></head><body><p>Hello 文档</p></body></html>'))
    )
    expect(parsed.text).toContain('Hello 文档')
    expect(parsed.text).not.toContain('<p>')
    expect(parsed.text).not.toContain('color:red')
  })

  it('图片不能冒充文档附件', async () => {
    await expect(parseDocumentBytes('a.png', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /不支持作为聊天文档附件解析/
    )
  })
})

describe('渲染层：附件白名单与 IPC 分流', () => {
  it('accept 列表包含新增的代码格式与结构化文档', () => {
    for (const ext of ['.java', '.go', '.rs', '.svg', '.pdf', '.docx', '.xlsx', '.html']) {
      expect(ATTACHMENT_ACCEPT, ext).toContain(ext)
    }
  })

  it(' uncommon 代码/标记文件按纯文本读取', async () => {
    const java = await readFileAsAttachment(new File(['class Demo {}'], 'Demo.java', { type: 'text/plain' }))
    expect(java?.type).toBe('text')
    expect(java?.data).toContain('class Demo {}')

    const svg = await readFileAsAttachment(new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'icon.svg', { type: 'image/svg+xml' }))
    expect(svg?.type).toBe('text')
    expect(svg?.data).toContain('<svg')
  })

  it('PDF 交给主进程解析，结果作为文本附件带回', async () => {
    let seen: { name: string; base64: string } | null = null
    ;(window as unknown as { pocketai: any }).pocketai = {
      parseAttachmentDocument: async (name: string, base64: string) => {
        seen = { name, base64 }
        return { text: '从 PDF 提取的正文', title: name }
      }
    }

    const file = new File(['%PDF-1.4 fake'], '报告.pdf', { type: 'application/pdf' })
    const attachment = await readFileAsAttachment(file)

    expect(seen).not.toBeNull()
    expect(seen!.name).toBe('报告.pdf')
    expect(seen!.base64.length).toBeGreaterThan(0)
    expect(attachment?.type).toBe('text')
    expect(attachment?.name).toBe('报告.pdf（已提取文本）')
    expect(attachment?.data).toBe('从 PDF 提取的正文')
  })

  it('主进程解析失败时不产生附件', async () => {
    ;(window as unknown as { pocketai: any }).pocketai = {
      parseAttachmentDocument: async () => ({ ok: false, error: '打不开' })
    }
    const attachment = await readFileAsAttachment(new File(['%PDF'], '坏文件.pdf', { type: 'application/pdf' }))
    expect(attachment).toBeNull()
  })
})
