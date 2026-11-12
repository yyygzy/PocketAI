// @vitest-environment jsdom
// md 产物「导出 PDF」：按钮可见性 / 成功 / 取消静默 / 失败可见 + 打印补丁（V4-Iter-476）
//
// 这一片的两个易错点都在界面上：
//  · 按钮只该出现在 md 卡片上（docx/xlsx/pptx 明确不做）；
//  · 用户取消不是错误——不许弹红条，但失败必须有可见面（形状闸门 + §217）。
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ArtifactActions } from '../src/renderer/src/components/agent/ArtifactActions'
import { buildArtifactPdfHtml } from '../src/renderer/src/utils/artifact-pdf'

const card = (kind: 'md' | 'docx' | 'xlsx' | 'pptx'): string =>
  JSON.stringify({
    ok: true,
    id: `${kind}-artifact-1`,
    kind,
    title: '周报',
    fileName: `周报.${kind === 'md' ? 'md' : kind}`,
    size: 1024,
    slideCount: 0,
    sheetCount: 0
  })

const statusTexts = (): string[] =>
  screen.queryAllByRole('status').map((el) => el.textContent ?? '')

describe('产物卡片：导出 PDF 按钮', () => {
  it('只有 md 卡片显示；docx / xlsx / pptx 都不显示', () => {
    const seen: Record<string, string | null> = {}
    for (const kind of ['md', 'docx', 'xlsx', 'pptx'] as const) {
      stubPocketai({})
      const view = mountWithProviders(<ArtifactActions resultContent={card(kind)} />)
      const btn = screen.queryByText('导出 PDF')
      seen[kind] = btn ? btn.textContent : null
      view.unmount()
    }
    expect(seen.md).toBe('导出 PDF')
    expect(seen.docx).toBeNull()
    expect(seen.xlsx).toBeNull()
    expect(seen.pptx).toBeNull()
  })

  it('成功：读全文 → 拼 HTML（带打印补丁）→ 导出，给成功回执', async () => {
    const calls: Array<[string, string]> = []
    stubPocketai({
      readArtifactText: () => ({ ok: true, text: '# 标题\n\n| 指标 | 数值 |\n| --- | --- |\n| 周活 | 1,234 |' }),
      exportArtifactPdf: (id: string, html: string) => {
        calls.push([id, html])
        return { ok: true, path: 'C:\\tmp\\周报.pdf' }
      }
    })
    mountWithProviders(<ArtifactActions resultContent={card('md')} />)

    fireEvent.click(screen.getByText('导出 PDF'))

    await waitFor(() => expect(statusTexts().some((s) => s.includes('已导出 PDF'))).toBe(true))
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('md-artifact-1')
    const html = calls[0]![1]
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('周活')
    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('table-layout:fixed')
    expect(html.toLowerCase()).not.toContain('<script')
  })

  it('用户取消：静默，不弹任何提示条', async () => {
    stubPocketai({
      readArtifactText: () => ({ ok: true, text: '正文' }),
      exportArtifactPdf: () => ({ ok: true, canceled: true })
    })
    mountWithProviders(<ArtifactActions resultContent={card('md')} />)

    fireEvent.click(screen.getByText('导出 PDF'))
    // 等两个 IPC 都走完（按钮回到「导出 PDF」），再确认全程没有提示条
    await waitFor(() => expect(screen.queryByText('正在生成 PDF…')).toBeNull())
    await new Promise((r) => setTimeout(r, 30))
    expect(statusTexts()).toEqual([])
  })

  it('导出失败：有可见失败面，且文案带原因', async () => {
    stubPocketai({
      readArtifactText: () => ({ ok: true, text: '正文' }),
      exportArtifactPdf: () => ({ ok: false, error: '磁盘已满' })
    })
    mountWithProviders(<ArtifactActions resultContent={card('md')} />)

    fireEvent.click(screen.getByText('导出 PDF'))
    await waitFor(() =>
      expect(statusTexts().some((s) => s.includes('导出 PDF 失败') && s.includes('磁盘已满'))).toBe(true)
    )
  })

  it('读全文被拒（超限）：把原因如实上屏', async () => {
    stubPocketai({
      readArtifactText: () => ({ ok: false, error: '正文 3.0MB，超过 2MB 上限，请拆分后再导出' }),
      exportArtifactPdf: () => ({ ok: true, path: 'x' })
    })
    mountWithProviders(<ArtifactActions resultContent={card('md')} />)

    fireEvent.click(screen.getByText('导出 PDF'))
    await waitFor(() =>
      expect(statusTexts().some((s) => s.includes('超过 2MB 上限'))).toBe(true)
    )
  })
})

describe('buildArtifactPdfHtml：打印补丁', () => {
  it('pre 改 pre-wrap（不许被 overflow-x:auto 裁字）、表格 fixed 布局、无脚本', async () => {
    const html = await buildArtifactPdfHtml({
      title: '打印',
      markdown: '## 小节\n\n```ts\nconst aVeryLongLine = 1\n```\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |'
    })
    // 基础样式里 `.markdown-body pre` 仍带 overflow-x:auto（屏幕版要横向滚动），
    // 打印补丁必须用**同等特异性且更靠后**的规则把它盖掉——这里断的就是最后一条生效规则。
    const preRules = [...html.matchAll(/\.markdown-body pre \{([^}]*)\}/g)]
    expect(preRules.length).toBeGreaterThanOrEqual(2)
    expect(preRules[preRules.length - 1]![1]).toContain('white-space:pre-wrap')
    expect(preRules[preRules.length - 1]![1]).toContain('overflow-x:visible')
    expect(html).toContain('.markdown-body table { table-layout:fixed')
    expect(html).toContain('word-break:break-word')
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).toContain('<table')
    expect(html).toContain('<pre')
  })
})
