// 产物导出 PDF（主进程）：保存框 / 取消 / 失败 / kind 校验 / 同 id 并发去重
//
// 这里不测 printToPDF 本身（Chromium 行为由 electron 提供，CI 里起不来），
// 而是把「落盘与语义」钉死：取消不是错误、失败要抛、.tmp 不残留、并发不叠保存框。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const stub = vi.hoisted(() => ({
  artifacts: new Map<string, { id: string; kind: string; title: string }>(),
  save: { canceled: false, filePath: '' },
  saveCalls: 0,
  pdfCalls: 0,
  pdfImpl: async (_html: string): Promise<Uint8Array> => new Uint8Array([0x25, 0x50, 0x44, 0x46])
}))

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: async () => {
      stub.saveCalls++
      return stub.save
    }
  }
}))

vi.mock('../src/main/artifacts/artifact-service', () => ({
  getArtifact: (id: string) => stub.artifacts.get(id) ?? null,
  getArtifactPath: (id: string) => (stub.artifacts.has(id) ? '/stub/generated/x.md' : null)
}))

vi.mock('../src/main/export/pdf', () => ({
  htmlToPdf: async (html: string) => {
    stub.pdfCalls++
    return stub.pdfImpl(html)
  }
}))

import { exportArtifactPdf } from '../src/main/artifacts/artifact-pdf-export'

let dir = ''
const win = {} as never

function target(name: string): string {
  return path.join(dir, name)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-pdf-export-'))
  stub.artifacts = new Map([
    ['md-artifact-1', { id: 'md-artifact-1', kind: 'md', title: '周报' }],
    ['docx-artifact-1', { id: 'docx-artifact-1', kind: 'docx', title: '文档' }]
  ])
  stub.save = { canceled: false, filePath: target('周报.pdf') }
  stub.saveCalls = 0
  stub.pdfCalls = 0
  stub.pdfImpl = async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('exportArtifactPdf', () => {
  it('成功：写入目标路径，返回 path，且不残留 .pocketai-tmp', async () => {
    const r = await exportArtifactPdf({ win, id: 'md-artifact-1', html: '<p>x</p>' })
    expect(r.ok).toBe(true)
    expect(r.path).toBe(stub.save.filePath)
    expect(fs.readFileSync(stub.save.filePath).subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect(fs.existsSync(`${stub.save.filePath}.pocketai-tmp`)).toBe(false)
  })

  it('取消：返回 canceled 而不是 error，且不做转换', async () => {
    stub.save = { canceled: true, filePath: '' }
    const r = await exportArtifactPdf({ win, id: 'md-artifact-1', html: '<p>x</p>' })
    expect(r).toEqual({ ok: true, canceled: true })
    expect(stub.pdfCalls).toBe(0)
  })

  it('不支持的 kind（docx）：直接拒绝，不弹保存框', async () => {
    const r = await exportArtifactPdf({ win, id: 'docx-artifact-1', html: '<p>x</p>' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Markdown/)
    expect(stub.saveCalls).toBe(0)
  })

  it('转换失败：抛出可读错误，目标路径与 .tmp 都不留', async () => {
    stub.pdfImpl = async () => {
      throw new Error('PDF 转换失败: 超时')
    }
    await expect(exportArtifactPdf({ win, id: 'md-artifact-1', html: '<p>x</p>' })).rejects.toThrow(
      /PDF 转换失败/
    )
    expect(fs.existsSync(stub.save.filePath)).toBe(false)
    expect(fs.existsSync(`${stub.save.filePath}.pocketai-tmp`)).toBe(false)
  })

  it('同 id 并发：只弹一次保存框、只转换一次，两发拿到同一结果', async () => {
    const [a, b] = await Promise.all([
      exportArtifactPdf({ win, id: 'md-artifact-1', html: '<p>x</p>' }),
      exportArtifactPdf({ win, id: 'md-artifact-1', html: '<p>x</p>' })
    ])
    expect(stub.saveCalls).toBe(1)
    expect(stub.pdfCalls).toBe(1)
    expect(a).toEqual(b)
  })
})
