// @vitest-environment jsdom
// DOCX 产物卡片：预览必须走无脚本沙箱，失败必须有可见面（V4-Iter-472）
//
// 这三条只有真挂载才验得到：iframe 的 sandbox 属性、html 为空时的失败文案、
// IPC 返回 {ok:false} 时不画成"预览成功"。
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { ArtifactActions } from '../src/renderer/src/components/agent/ArtifactActions'

const result = JSON.stringify({
  ok: true,
  id: 'a1',
  kind: 'docx',
  title: '周报',
  fileName: '周报.docx',
  size: 2048,
  sectionCount: 2
})

describe('DOCX 产物卡片', () => {
  it('预览 HTML 放进 sandbox=""（不带 allow-scripts）的 iframe', async () => {
    stubPocketai({
      previewArtifact: () => ({
        id: 'a1',
        kind: 'docx',
        missing: false,
        html: '<p>正文段落</p><ul><li>要点</li></ul>'
      })
    })
    mountWithProviders(<ArtifactActions resultContent={result} />)

    fireEvent.click(screen.getByText('预览正文'))
    await screen.findByText('只读渲染，分页与页眉页脚以 Word 打开为准')

    const frame = document.querySelector('iframe')
    expect(frame, '没有渲染 iframe').toBeTruthy()
    const sandbox = frame!.getAttribute('sandbox')
    expect(sandbox).toBe('')
    expect(sandbox ?? '').not.toContain('allow-scripts')
    expect(frame!.getAttribute('srcdoc') ?? '').toContain('正文段落')
    expect(pocketaiCalls().some((c) => c.fn === 'previewArtifact' && c.args[0] === 'a1')).toBe(true)
  })

  it('mammoth 转换失败（html 空串）→ 如实报"渲染失败"，不画空 iframe', async () => {
    stubPocketai({
      previewArtifact: () => ({ id: 'a1', kind: 'docx', missing: false, html: '' })
    })
    mountWithProviders(<ArtifactActions resultContent={result} />)

    fireEvent.click(screen.getByText('预览正文'))
    await screen.findByText('没能渲染这份文档的预览，请直接打开文件')
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('IPC 返回 {ok:false} → 有可见失败面，不当成预览成功', async () => {
    stubPocketai({
      previewArtifact: () => ({ ok: false, error: 'E_PREVIEW' })
    })
    mountWithProviders(<ArtifactActions resultContent={result} />)

    fireEvent.click(screen.getByText('预览正文'))
    await waitFor(() => {
      const status = document.querySelector('[role="status"]')
      expect(status?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    })
    expect(document.querySelector('iframe')).toBeNull()
  })
})
