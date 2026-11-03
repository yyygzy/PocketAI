// @vitest-environment jsdom
// §399②b：`FloatingPanel` 那颗 `align` 的算术（第二层不许盖住父菜单上面那几行）
//
// 为什么这份用例值得单独存在：上一枚的"被不被 `overflow-hidden` 裁切"确实只有真机量得出来（jsdom 里所有矩形都是 0），
// 但**我们自己算的那个 left** 是纯算术——把锚点合成为一份带矩形的 ref、把 `window.innerWidth` 改掉，
// 就能在 CI 里钉住三支各走哪条：①默认（`'start'`）＝左沿贴锚点；②`'right'` 且右侧放得下＝并排在锚点右边；
// ③`'right'` 但右侧放不下＝**翻到左边**，而不是被那道 clamp 拉回来自家父菜单上面
//   （真机在 788 宽的窗口上撞到的就是这一形：外层 472..724，右侧只剩 64px，摆"右侧"会被夹回 480＝照旧盖住）。
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { render, screen, type RenderResult } from '@testing-library/react'
import { FloatingPanel } from '../src/renderer/src/components/FloatingPanel'

const W = 300
const originalW = window.innerWidth
const originalH = window.innerHeight

/** 锚点合成成"只被原语用到那两个方法"的对象（`getBoundingClientRect` ＋`contains`），不必真在 DOM 里有尺寸 */
const anchor = (left: number, right: number): React.RefObject<HTMLElement> =>
  ({
    current: {
      getBoundingClientRect: () =>
        ({ left, right, top: 300, bottom: 330, width: right - left, height: 30 }) as DOMRect,
      contains: () => false
    }
  }) as unknown as React.RefObject<HTMLElement>

let last: RenderResult | null = null
function mount(a: React.RefObject<HTMLElement>, width: number = W, align?: 'right'): void {
  last?.unmount()
  last = render(
    <FloatingPanel
      anchorRef={a}
      width={width}
      onClose={() => { /* 只看位置 */ }}
      data-testid="fx-panel"
      {...(align ? { align } : {})}
    >
      <div>内容</div>
    </FloatingPanel>
  )
}
const style = (): CSSStyleDeclaration => screen.getByTestId('fx-panel').style
const leftPx = (): number => Number(style().left.replace('px', ''))
const bottomPx = (): number => Number(style().bottom.replace('px', ''))

function setViewport(w: number, h: number = 570): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
}

afterEach(() => {
  setViewport(originalW, originalH)
})

describe('align 的三支（数值全是现算的，不是抄屏上的）', () => {
  it('默认那一形＝左沿贴锚点（改前那个行为，别把既有两处弹层一起改了）', () => {
    setViewport(1300)
    mount(anchor(472, 724))
    expect(leftPx(), '默认支：left 就是锚点左沿').toBe(472)
  })

  it('右侧放得下⇒并排在锚点右边（472..724 的锚点，1300 宽的屏⇒摆到 728）', () => {
    setViewport(1300)
    mount(anchor(472, 724), W, 'right')
    expect(leftPx()).toBe(728)
  })

  it('右侧放不下⇒翻到锚点左侧（真机在 788 宽量到的那一形：右侧只剩 64px）', () => {
    setViewport(788)
    mount(anchor(472, 724), W, 'right')
    expect(leftPx(), '翻侧＝472 − 间距 4 − 宽 300；被 clamp 拉回 480 那一形＝照旧盖住父菜单').toBe(168)
  })

  it('两侧都放不下⇒退回那道 clamp（不许算出负数把面板推出屏）', () => {
    setViewport(320)
    mount(anchor(472, 724), W, 'right')
    // 翻侧算出 168，但 320 宽的屏只容得下 `left ≤ 320−300−8＝12` ⇒ 夹到 12（面板右沿正好贴边）
    expect(leftPx()).toBe(12)
    setViewport(240)
    mount(anchor(472, 724), W, 'right')
    expect(leftPx(), '屏比面板还窄⇒夹到 EDGE，不是负数').toBe(8)
  })

  it('竖直方向与 align 无关：两种摆法都还是"底边坐在锚点上沿之上"（向上长）', () => {
    setViewport(1300)
    mount(anchor(472, 724), W, 'right')
    const rightBottom = bottomPx()
    mount(anchor(472, 724))
    expect(bottomPx(), '换 align 不许动竖直位置').toBe(rightBottom)
    expect(rightBottom, 'innerHeight 570 − 锚点 top 300 ＋ 间距 4').toBe(274)
  })

  it('反向对照：默认支在窄屏上照样被夹住（同一份 clamp，不是只有右侧那一支有兜底）', () => {
    setViewport(200)
    mount(anchor(472, 724))
    expect(leftPx(), '200 − 300 − 边距＝负数 ⇒ 夹到 8').toBe(8)
  })
})
