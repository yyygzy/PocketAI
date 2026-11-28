// SEC-16-14：mermaid 输出（来自 LLM 代码）在 dangerouslySetInnerHTML 前必须过 DOMPurify。
// 构造 strict 模式下仍可能残留的危险节点，断言二次净化后全部消失。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MermaidBlock } from '../src/renderer/src/modules/chat/MermaidBlock'

const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn()
}))
vi.mock('mermaid', () => ({ default: { initialize: initializeMock, render: renderMock } }))

const MALICIOUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20">
<style>.x{fill:red}</style>
<script>window.__pwned=1</script>
<image href="https://evil.tld/pixel.png" xlink:href="https://evil.tld/pixel.png" onload="window.__pwned=2" />
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="window.__pwned=3">bad</div></foreignObject>
<a xlink:href="javascript:alert(1)"><text>bad link</text></a>
<use href="#x" /><animate attributeName="x" /><set attributeName="y" to="1" />
<text>safe</text>
</svg>`

describe('SEC-16-14 — mermaid SVG 二次净化', () => {
  it('script/onload/foreignObject/use/animate/set/危险 href 全部被剥离，正常 SVG 内容保留', async () => {
    renderMock.mockResolvedValue({ svg: MALICIOUS_SVG })
    const { container } = render(<MermaidBlock code="graph TD; A-->B" />)

    await waitFor(() => expect(container.querySelector('svg')).toBeTruthy())

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('foreignObject')).toBeNull()
    expect(container.querySelector('[onload]')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
    expect(container.querySelector('use')).toBeNull()
    expect(container.querySelector('animate')).toBeNull()
    expect(container.querySelector('set')).toBeNull()
    expect(container.innerHTML).not.toContain('javascript:')
    expect(container.innerHTML).not.toContain('evil.tld')
    expect(container.innerHTML).not.toContain('__pwned')
    // 白名单内的 SVG 内容与 mermaid 主题样式仍保留（不破坏正常图表）
    expect([...container.querySelectorAll('text')].some((n) => n.textContent === 'safe')).toBe(true)
    expect(container.querySelector('style')?.textContent).toContain('.x{fill:red}')
    // strict 层仍在（三层不可删）
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }))
  })
})
