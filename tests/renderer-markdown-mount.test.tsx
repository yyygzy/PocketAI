// PERF-03：Markdown 子树不再因父组件 rerender 而卸载重挂
//
// 断言口径（不依赖真实耗时，也不 mock react-markdown，走真渲染）：
//  · 挂载后捕获 <pre> 的 DOM 节点，父组件连续 rerender N 次后仍是**同一个节点**——
//    只要发生过一次 unmount/remount，React 必然重建 DOM 节点，节点同一即证明 mount 仅 1 次；
//  · 代码块折叠态在 rerender 中保持稳定（旧实现在折叠态被 unmount 重置回 EXPANDED）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { stubPocketai } from './helpers/renderer'
import { Markdown } from '../src/renderer/src/modules/chat/Markdown'

// katex 是懒加载的：ready 后 rehypePlugins 换桶，会带来**一次预期内的**重解析。
// 用桩让它确定性地立刻 resolve，捕获节点前先等这次换桶落定，之后父组件 rerender
// 就不该再有任何重挂。
vi.mock('rehype-katex', () => ({ default: () => () => {} }))
vi.mock('katex/dist/katex.min.css', () => ({}))

/** 25 行代码：超过默认折叠阈值（20 行），CodeBlock 初始为折叠态 */
const LONG = Array.from({ length: 25 }, (_, i) => `const v${i} = ${i}`).join('\n')
const CONTENT = `\`\`\`ts\n${LONG}\n\`\`\``

function Parent({ tick }: { tick: number }): React.ReactElement {
  // tick 只是让父组件重渲染；传给 Markdown 的 props 保持不变（流式期间的真实形态）
  void tick
  return <Markdown content={CONTENT} />
}

/** 折叠/展开切换按钮：CodeBlock 里唯一没有 aria-label 的 button（复制按钮有） */
function toggle(container: HTMLElement): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => !b.getAttribute('aria-label')
  )
  expect(btn, '折叠切换按钮应存在（25 行 > 阈值 20）').toBeTruthy()
  return btn as HTMLButtonElement
}

beforeEach(() => {
  stubPocketai({ getUiPrefs: () => ({ ok: true, data: null }) })
})

/** 渲染并等 katex 懒加载换桶落定，返回稳定的渲染结果 */
async function mountSettled(): Promise<ReturnType<typeof render>> {
  const r = render(<Parent tick={0} />)
  await act(async () => {})
  return r
}

describe('PERF-03 — 父组件 rerender 不重挂 Markdown 子树', () => {
  it('连续 rerender 10 次：<pre> DOM 节点同一（mount 仅 1 次）', async () => {
    const { container, rerender } = await mountSettled()
    const pre = container.querySelector('pre')
    expect(pre).toBeTruthy()

    for (let i = 1; i <= 10; i++) rerender(<Parent tick={i} />)

    expect(container.querySelector('pre')).toBe(pre)
  })

  it('流式期间折叠态稳定：展开后 rerender 10 次仍是展开态', async () => {
    const { container, rerender } = await mountSettled()
    const pre = container.querySelector('pre') as HTMLPreElement
    // 初始折叠：maxHeight 内联样式在场
    expect(pre.style.maxHeight).not.toBe('')

    fireEvent.click(toggle(container))
    expect(pre.style.maxHeight, '点开后应取消折叠（MAXH 高度清空）').toBe('')

    for (let i = 1; i <= 10; i++) rerender(<Parent tick={i} />)

    // 旧实现：components 字面量每次重建 → 子树重挂 → useState 重置回折叠
    expect(container.querySelector('pre')).toBe(pre)
    expect(pre.style.maxHeight).toBe('')
  })
})
