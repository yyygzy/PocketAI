// SEC-16-13：渲染含外域图片的 markdown 时零跨域请求；生产 CSP 兜底；
// 导出 PNG 不再用 cacheBust 重抓外域图片。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { stubPocketai } from './helpers/renderer'
import { Markdown } from '../src/renderer/src/modules/chat/Markdown'
import { exportConversationAsPng } from '../src/renderer/src/utils/export-image'
import { installContentSecurityPolicy } from '../src/main/security/csp'

// katex 懒加载桩掉，避免测试里的动态 import 噪声（PERF-02/03 既有用例同口径）
vi.mock('rehype-katex', () => ({ default: () => () => {} }))
vi.mock('katex/dist/katex.min.css', () => ({}))

const { toPngMock, onHeadersReceived } = vi.hoisted(() => ({
  toPngMock: vi.fn(),
  onHeadersReceived: vi.fn()
}))
vi.mock('html-to-image', () => ({ toPng: toPngMock }))
vi.mock('electron', () => ({
  session: { defaultSession: { webRequest: { onHeadersReceived } } }
}))

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const BLOB = 'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000'

let fetchSpy: ReturnType<typeof vi.fn>
let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  stubPocketai()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  openSpy = vi.spyOn(XMLHttpRequest.prototype, 'open')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SEC-16-13 — 外域图片在渲染阶段硬拦', () => {
  it('含 https/http 图片的 markdown：无 img 节点、fetch/XHR 零调用，降级为可点链接', async () => {
    const content = '开头\n\n![pixel](https://attacker.tld/pixel.png)\n\n![plain](http://attacker.tld/x.png)\n\n结尾'
    const { container } = render(<Markdown content={content} />)
    await act(async () => {})

    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()

    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://attacker.tld/pixel.png')
    expect(hrefs).toContain('http://attacker.tld/x.png')
    expect(container.textContent).toContain('开头')
    expect(container.textContent).toContain('结尾')
  })

  it('data:image / blob: 仍正常渲染，且带 no-referrer + lazy 兜底', async () => {
    const { container } = render(<Markdown content={`![d](${GIF})\n\n![b](${BLOB})`} />)
    await act(async () => {})

    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(2)
    for (const img of imgs) {
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
      expect(img.getAttribute('loading')).toBe('lazy')
    }
    expect([...imgs].map((i) => i.getAttribute('src'))).toEqual([GIF, BLOB])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('危险协议图片：不产出 img，也不产出危险 href', async () => {
    const content = [
      '![js](javascript:alert(1))',
      '![data](data:text/html,<script>alert(1)</script>)',
      '![file](file:///c:/windows/win.ini)'
    ].join('\n\n')
    const { container } = render(<Markdown content={content} />)
    await act(async () => {})

    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container.querySelector('a[href^="data:"]')).toBeNull()
    expect(container.querySelector('a[href^="file:"]')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('SEC-16-13 — 生产 CSP 与导出图片', () => {
  it('生产 CSP 的 img-src 去掉 https:，仅 data:/blob: 内嵌图可加载', () => {
    const saved = process.env['ELECTRON_RENDERER_URL']
    delete process.env['ELECTRON_RENDERER_URL']
    try {
      installContentSecurityPolicy()
      expect(onHeadersReceived).toHaveBeenCalledTimes(1)
      const handler = onHeadersReceived.mock.calls[0]?.[0] as (
        details: unknown,
        cb: (r: { responseHeaders: Record<string, string[]> }) => void
      ) => void
      let csp = ''
      handler({}, (r) => { csp = r.responseHeaders['Content-Security-Policy']?.[0] ?? '' })
      expect(csp).toContain("img-src 'self' data: blob:")
      expect(csp).not.toMatch(/img-src[^;]*https:/)
    } finally {
      if (saved === undefined) delete process.env['ELECTRON_RENDERER_URL']
      else process.env['ELECTRON_RENDERER_URL'] = saved
    }
  })

  it('导出 PNG 时 toPng 不启用 cacheBust 重抓', async () => {
    const dataUrl = 'data:image/png;base64,AA=='
    toPngMock.mockResolvedValue(dataUrl)
    fetchSpy.mockResolvedValue({ blob: async () => new Blob(['x']) } as unknown as Response)
    // jsdom 的 URL.createObjectURL 只认自家 Blob 内部结构，桩掉即可（这里只断言 toPng 入参）
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    // 不能包在 act 里：act 会推迟 concurrent commit，真实导出函数靠两帧等 DOM 就绪
    await exportConversationAsPng({
      messages: [],
      truncated: false,
      assistantName: null,
      fileName: 'x.png',
      t: (k: string) => k
    })

    expect(toPngMock).toHaveBeenCalledTimes(1)
    expect(toPngMock.mock.calls[0]?.[1]).toMatchObject({ cacheBust: false })
    expect(fetchSpy).toHaveBeenCalledWith(dataUrl)
    clickSpy.mockRestore()
  })
})
