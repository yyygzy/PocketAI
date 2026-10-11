// @vitest-environment jsdom
// 折叠阈值设置项在 Markdown 里的落地：默认 20 行折叠、阈值 0 完全不折叠、改阈值即时重判
//
// 钉的是订阅链路（useSyncExternalStore）：阈值只写到缓存模块而组件不订阅的话，
// 用户得重启应用才看到效果 —— 这类回归只有挂载后改值才测得出来。
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { Markdown } from '../src/renderer/src/modules/chat/Markdown'
import { CODE_COLLAPSE_THRESHOLD } from '../src/renderer/src/utils/code-block'
import { setCodeCollapseLines as setThresholdRaw } from '../src/renderer/src/code-collapse'

/** 改阈值要走 act：订阅者通知在 React 批量更新之外，不包一层 DOM 不会重渲染 */
function setCodeCollapseLines(v: unknown): void {
  act(() => setThresholdRaw(v))
}

/** n 行围栏代码块 */
function codeOf(n: number): string {
  return '```\n' + Array.from({ length: n }, (_, i) => `line${i}`).join('\n') + '\n```'
}

let pre: HTMLElement

function mountCode(lines: number): void {
  stubPocketai({ setAppLanguage: () => Promise.resolve() })
  const { container } = mountWithProviders(<Markdown content={codeOf(lines)} />)
  const el = container.querySelector('pre')
  if (!el) throw new Error('未渲染出 <pre>，用例前提不成立')
  pre = el as HTMLElement
}

beforeEach(() => {
  setCodeCollapseLines(CODE_COLLAPSE_THRESHOLD)
})

describe('Markdown 代码块折叠阈值', () => {
  it('默认阈值：18 行不折叠（既不裁切也没有展开条）', () => {
    mountCode(18)
    expect(screen.queryByText(/展开全部/)).toBeNull()
    expect(pre.style.maxHeight).toBe('')
    expect(pre.className).not.toContain('overflow-y-hidden')
  })

  it('超过默认阈值：折叠并裁到 12 行预览，点「展开全部」恢复全文', () => {
    mountCode(30)
    expect(pre.className).toContain('overflow-y-hidden')
    expect(pre.style.maxHeight).toBe(`${12 * 20}px`)
    fireEvent.click(screen.getByText('展开全部（30 行）'))
    expect(pre.style.maxHeight).toBe('')
    expect(pre.className).not.toContain('overflow-y-hidden')
  })

  it('阈值 0：长代码块完全不折叠', () => {
    setCodeCollapseLines(0)
    mountCode(60)
    expect(pre.className).not.toContain('overflow-y-hidden')
    expect(pre.style.maxHeight).toBe('')
    expect(screen.queryByText(/展开全部/)).toBeNull()
  })

  it('阈值小于预览行数时按阈值裁切（阈值 5 不该露出 12 行）', () => {
    setCodeCollapseLines(5)
    mountCode(30)
    expect(pre.style.maxHeight).toBe(`${5 * 20}px`)
  })

  it('挂载后改阈值：已渲染的块立即重判，不可折叠时不得继续裁切', () => {
    mountCode(30)
    expect(screen.getByText('展开全部（30 行）')).toBeTruthy()

    // 展开态 -> 阈值 0：整条折叠 UI 消失
    fireEvent.click(screen.getByText('展开全部（30 行）'))
    setCodeCollapseLines(0)
    expect(screen.queryByText(/展开全部|收起/)).toBeNull()
    expect(pre.style.maxHeight).toBe('')

    // 收起态 + 收紧阈值：重新可折叠，按新阈值裁切
    setCodeCollapseLines(20)
    fireEvent.click(screen.getByText('收起'))
    setCodeCollapseLines(5)
    expect(pre.style.maxHeight).toBe(`${5 * 20}px`)
    expect(screen.getByText('展开全部（30 行）')).toBeTruthy()
  })
})
