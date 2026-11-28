// PERF-03：plugins / components 引用稳定性 —— 相同 props 下传给 ReactMarkdown 的
// remarkPlugins / rehypePlugins / components 引用不变（引用一变 react-markdown 就
// 全量重解析并卸载重挂整棵子树）。用 mock 的 ReactMarkdown 直接捕获 props 断言。
//
// sup 组件按 citationCount 分桶（onCitation 走 ref）：citationCount 不变时 components
// 引用稳定；父组件传内联 onCitation 也不会破坏稳定性。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act, render } from '@testing-library/react'
import { Markdown } from '../src/renderer/src/modules/chat/Markdown'

// katex 懒加载 ready 后 rehypePlugins 会换桶（一次预期内的引用变化）；
// 用桩让它确定性 resolve，并在捕获前先等它落定（见各用例里的 mountSettled）。
vi.mock('rehype-katex', () => ({ default: () => () => {} }))
vi.mock('katex/dist/katex.min.css', () => ({}))

interface CapturedProps {
  remarkPlugins?: unknown
  rehypePlugins?: unknown
  components?: unknown
}

const captured: CapturedProps[] = []

vi.mock('react-markdown', () => ({
  default: function MockMarkdown(props: {
    remarkPlugins?: unknown
    rehypePlugins?: unknown
    components?: unknown
    children?: React.ReactNode
  }) {
    captured.push({
      remarkPlugins: props.remarkPlugins,
      rehypePlugins: props.rehypePlugins,
      components: props.components
    })
    return <div>{props.children}</div>
  },
  // Markdown.tsx 顶层还引用了 defaultUrlTransform（真实实现收口危险协议），
  // mock 里给恒等版即可——本文件只判 props 引用，不判 URL 行为
  defaultUrlTransform: (v: string) => v
}))

// vi.mock 会被提升到 import 之前，Markdown.tsx 拿到的是上面替换后的 react-markdown

beforeEach(() => {
  captured.length = 0
})

/** 首渲染并等 katex 懒加载换桶落定（换桶产生的历史快照不参与断言，取最后一发做基线） */
async function mountSettled(ui: React.ReactElement): Promise<ReturnType<typeof render>> {
  const r = render(ui)
  await act(async () => {})
  return r
}

/** 换桶落定后的最近一次快照（基线） */
const last = (): CapturedProps => captured[captured.length - 1]!

describe('PERF-03 — plugins / components 引用稳定性', () => {
  it('相同 props 连续 rerender：remarkPlugins / rehypePlugins / components 引用不变', async () => {
    const onCitation = (): void => {}
    const { rerender } = await mountSettled(<Markdown content="a" citationCount={0} onCitation={onCitation} />)
    const baseline = last()
    // content 变化（流式追加的真实形态）不该影响 options 引用
    rerender(<Markdown content="ab" citationCount={0} onCitation={onCitation} />)
    rerender(<Markdown content="abc" citationCount={0} onCitation={onCitation} />)

    for (const snap of captured.slice(captured.indexOf(baseline) + 1)) {
      expect(snap.remarkPlugins).toBe(baseline.remarkPlugins)
      expect(snap.rehypePlugins).toBe(baseline.rehypePlugins)
      expect(snap.components).toBe(baseline.components)
    }
  })

  it('citationCount 分桶：0 → N 时 components 引用换桶，N 稳定时保持不变', async () => {
    const { rerender } = await mountSettled(<Markdown content="x" citationCount={0} />)
    const baseline0 = last().components
    // 换桶（sup 组件闭包里的 citationCount 变了）
    rerender(<Markdown content="x" citationCount={3} onCitation={() => {}} />)
    const baselineN = last().components
    expect(baselineN).not.toBe(baseline0)
    // 同桶：内联 onCitation 每次都是新引用，也不能动摇 components 稳定性（ref 收口）
    rerender(<Markdown content="x" citationCount={3} onCitation={() => {}} />)
    expect(last().components).toBe(baselineN)
  })

  it('citationCount > 0 时 remarkPlugins 换成带引用插件的那一桶，且保持稳定', async () => {
    const { rerender } = await mountSettled(<Markdown content="x" citationCount={0} />)
    const base = last().remarkPlugins
    rerender(<Markdown content="x" citationCount={2} />)
    const citations = last().remarkPlugins
    expect(citations).not.toBe(base)
    rerender(<Markdown content="x" citationCount={2} />)
    expect(last().remarkPlugins).toBe(citations)
  })
})
