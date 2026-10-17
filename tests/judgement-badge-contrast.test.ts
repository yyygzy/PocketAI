// 判据屏三档徽标的字色对比度闸门（V4-Iter-165）
//
// 为什么要有这条：149 那次给三档加了"填充 + 边框样式 + 记号"三条冗余通道，解决的是**分不分得开**；
// 但**看不看得见**一直没人算过。164 我用 CDP 现量才发现两档不达标（「没读到 ○」亮 3.07 / 暗 2.47，
// 「保守默认 ▲」亮 1.90——那一档本机根本不出现，所以从 146 上线起没人撞见过），
// 而字号是 `text-[10px]` ⇒ WCAG 要 4.5:1。
//
// 这条用例不抄我的结论：色值从 `theme.css` 现读，用哪支 var 从组件源码现读，半透明底按卡片实际底色合成。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CSS = fs.readFileSync(path.join(__dirname, '../src/renderer/src/theme.css'), 'utf-8')
const PANEL = fs.readFileSync(
  path.join(__dirname, '../src/renderer/src/modules/settings/LocalJudgementPanel.tsx'),
  'utf-8'
)

const BLOCKS = { dark: ':root', light: 'html.light' } as const
type Theme = keyof typeof BLOCKS

/** 取出某个选择器块里的全部 CSS 自定义属性（块内没有嵌套大括号） */
function varsOf(theme: Theme): Record<string, string> {
  const start = CSS.indexOf(BLOCKS[theme] + ' {')
  expect(start, `theme.css 里找不到 ${BLOCKS[theme]} 块`).toBeGreaterThanOrEqual(0)
  const body = CSS.slice(start, CSS.indexOf('\n}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1]
    if (name) out[name] = (m[2] ?? '').trim()
  }
  return out
}

const parse = (v: string): [number, number, number, number] => {
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = hex[1] ?? ''
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), 1]
  }
  const rgb = v.match(/rgba?\(([^)]+)\)/)
  if (!rgb) throw new Error(`不认识的颜色写法：${v}`)
  const p = (rgb[1] ?? '').split(',').map((x) => parseFloat(x.trim()))
  const [r = 0, g = 0, b = 0, a = 1] = p
  return p.length >= 4 ? [r, g, b, a] : [r, g, b, 1]
}

const lum = (c: number[]) => {
  const f = (v: number) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0)
}
const contrast = (fg: number[], bg: number[]) => {
  const hi = Math.max(lum(fg), lum(bg))
  const lo = Math.min(lum(fg), lum(bg))
  return (hi + 0.05) / (lo + 0.05)
}
/** 半透明前景按 alpha 合成到不透明底上 */
const over = (top: number[], bottom: number[]) => {
  const a = top[3] ?? 1
  return [0, 1, 2].map((i) => Math.round((top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)))
}

/** 组件里那三档各自用哪支字色 / 哪支填充——从源码现读，不在这里重抄一遍 */
function tonesFromSource(): Record<string, { text: string; fill: string | null }> {
  const block = PANEL.slice(PANEL.indexOf('const SOURCE_TONE'), PANEL.indexOf('}\n', PANEL.indexOf('const SOURCE_TONE')))
  const out: Record<string, { text: string; fill: string | null }> = {}
  for (const m of block.matchAll(/['"]?([a-z][a-z-]*)['"]?\s*:\s*'([^']+)'/g)) {
    const cls = m[2] ?? ''
    const text = cls.match(/text-\[var\((--[\w-]+)\)\]/)
    const fill = cls.match(/bg-\[var\((--[\w-]+)\)\]/)
    if (!m[1]) continue
    out[m[1]] = { text: text?.[1] ?? '', fill: fill?.[1] ?? null }
  }
  return out
}

/** 取一个必须存在的 var：缺了就直接抛，别让它变成 `undefined` 往下传 */
function need(v: Record<string, string>, name: string): string {
  const x = v[name]
  if (!x) throw new Error(`theme.css 里没有 ${name}`)
  return x
}

const TONES = tonesFromSource()
const CODES = ['measured', 'no-measurement', 'unavailable']
/** 组件里那一档的 class 解析结果；缺了就是组件被改坏，直接抛 */
const tone = (c: string) => {
  const t = TONES[c]
  if (!t) throw new Error(`SOURCE_TONE 里没解析出 ${c}`)
  return t
}

describe('判据屏三档徽标：字色必须过 WCAG 小字线（4.5:1）', () => {
  it('组件里三档都各自写了字色 var（不许漏成继承色）', () => {
    for (const c of CODES) expect(tone(c).text, `${c} 没写 text-[var(...)]`).toBeTruthy()
  })

  it('三档的字色 var 互不相同（"只靠一条通道区分"就是这次要修的毛病）', () => {
    const used = CODES.map((c) => tone(c).text)
    expect(new Set(used).size, `三档共用了字色：${used.join(' / ')}`).toBe(3)
  })

  for (const theme of ['light', 'dark'] as Theme[]) {
    it(`${theme}：每一档的字对"合成后的那一档底色"都 ≥ 4.5:1`, () => {
      const v = varsOf(theme)
      const card = parse(need(v, '--color-surface'))
      const report: string[] = []
      for (const c of CODES) {
        const t = tone(c)
        const fill = t.fill ? parse(need(v, t.fill)) : null
        const bg = fill && fill[3] < 1 ? over(fill, card) : fill ? [fill[0], fill[1], fill[2]] : card
        const ratio = contrast(parse(need(v, t.text)), bg)
        report.push(`${c}=${ratio.toFixed(2)}`)
        expect(ratio, `${theme} 的「${c}」字色对比只有 ${ratio.toFixed(2)}（底 ${bg.join(',')}）`).toBeGreaterThanOrEqual(4.5)
      }
      console.log(`  ${theme}: ${report.join('  ')}`)
    })

    it(`${theme}：解释正文用的 muted 不许被顺手改亮（它是徽标对比度的参照系）`, () => {
      const v = varsOf(theme)
      const card = parse(need(v, '--color-surface'))
      // muted 用在大段解释文字上，字号比徽标大，线给到 3:1；这里只防"有人把它调得更浅"
      expect(contrast(parse(need(v, '--color-text-muted')), card), `${theme} muted`).toBeGreaterThanOrEqual(3)
    })
  }
})
