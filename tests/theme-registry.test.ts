// 主题注册表闸门（L1：主题从二元改成 id 集合）
//
// 把"某一套预设"的四处事实钉在一起：注册表、theme.css、首帧脚本、窗口底色。
// 少任何一处对不上，用户看到的都会是"页面一套颜色、窗口底另一套"，或者在某个预设下
// 有一段声明整块失效（CSS 变量漏定义）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_UI_THEME,
  isUiTheme,
  normalizeUiTheme,
  themeClassName,
  themeIdFromClasses,
  UI_THEME_IDS,
  UI_THEMES
} from '../src/shared/themes'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const ROOT = process.cwd()
const THEME_CSS = path.join(ROOT, 'src', 'renderer', 'src', 'theme.css')
const THEME_INIT = path.join(ROOT, 'src', 'renderer', 'public', 'theme-init.js')

const css = fs.readFileSync(THEME_CSS, 'utf8')
/** it.each 需要可变数组（注册表里的 id 是 readonly 元组） */
const IDS = UI_THEME_IDS.slice()

/** 取某个选择器块的变量（只收 --color- 与 --hljs- 前缀，`:root` 里的字号档位不参与比对） */
function blockVars(selector: string): Map<string, string> {
  // 必须连 `{` 一起找：文件头部注释里也写着这些选择器名，只按名字 indexOf 会落在注释上
  const m = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{').exec(css)
  expect(m, `theme.css 里找不到 ${selector} {`).toBeTruthy()
  const start = m!.index
  const end = css.indexOf('}', start)
  const body = css.slice(start, end)
  const out = new Map<string, string>()
  for (const mm of body.matchAll(/(--(?:color|hljs)-[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(mm[1]!, mm[2]!.trim())
  }
  return out
}

function parseColor(v: string): { rgb: [number, number, number]; alpha: number } {
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1]!
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number], alpha: 1 }
  }
  const rgba = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4])
    }
  }
  throw new Error(`无法解析颜色：${v}`)
}

function over(fg: string, bg: string): string {
  const f = parseColor(fg)
  const b = parseColor(bg)
  const mix = f.rgb.map((c, i) => Math.round(c * f.alpha + b.rgb[i]! * (1 - f.alpha)))
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

function luminance(v: string): number {
  const { rgb } = parseColor(v)
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe('注册表自身', () => {
  it('id / class / 窗口底色各自唯一（新增预设不许悄悄覆盖别的一套）', () => {
    expect(new Set(IDS).size).toBe(IDS.length)
    expect(new Set(IDS.map((id) => UI_THEMES[id].className)).size).toBe(IDS.length)
    expect(new Set(IDS.map((id) => UI_THEMES[id].windowBackground)).size).toBe(IDS.length)
  })

  it('白名单只认注册过的 id；旧值 light/dark 仍然合法，脏值落默认深色', () => {
    for (const id of IDS) expect(isUiTheme(id)).toBe(true)
    expect(isUiTheme('light')).toBe(true)
    expect(isUiTheme('dark')).toBe(true)
    expect(isUiTheme('#ff0000')).toBe(false)
    expect(isUiTheme('')).toBe(false)
    expect(isUiTheme(null)).toBe(false)
    expect(DEFAULT_UI_THEME).toBe('dark')
    expect(normalizeUiTheme('bogus')).toBe('dark')
    expect(normalizeUiTheme('ocean')).toBe('ocean')
  })

  it('themeIdFromClasses 与 class 映射互逆；无 class/未知 class 落默认', () => {
    for (const id of IDS) {
      const cls = themeClassName(id)
      const set = new Set(cls ? [cls] : [])
      expect(themeIdFromClasses({ contains: (c) => set.has(c) })).toBe(id)
    }
    expect(themeIdFromClasses({ contains: () => false })).toBe('dark')
    expect(themeIdFromClasses({ contains: (c) => c === 'unknown-theme' })).toBe('dark')
  })

  it('预设名四语齐全（labelKey 在四本字典里都有非空值）', () => {
    const dicts = { zh, en, ja, ko } as const
    for (const id of UI_THEME_IDS) {
      const key = UI_THEMES[id].labelKey
      for (const [lang, dict] of Object.entries(dicts)) {
        expect((dict as Record<string, string>)[key], `${lang}.${key}`).toBeTruthy()
      }
    }
  })
})

describe('theme.css 每个预设都是完整一套', () => {
  const base = blockVars(':root')

  it.each(IDS)('%s 的 token 集合与 :root 完全一致（漏一个 = 该主题下声明失效）', (id) => {
    const selector = id === 'dark' ? ':root' : `html.${UI_THEMES[id].className}`
    const vars = blockVars(selector)
    expect([...vars.keys()].filter((k) => !base.has(k))).toEqual([])
    expect([...base.keys()].filter((k) => !vars.has(k))).toEqual([])
  })

  it.each(IDS)('%s 的窗口底色等于该预设的 --color-surface（首帧不露出第二条底色）', (id) => {
    const selector = id === 'dark' ? ':root' : `html.${UI_THEMES[id].className}`
    expect(blockVars(selector).get('--color-surface')?.toLowerCase()).toBe(UI_THEMES[id].windowBackground)
  })

  it.each(IDS)('%s 的正文/次一级文字/强调色对比度达标', (id) => {
    const selector = id === 'dark' ? ':root' : `html.${UI_THEMES[id].className}`
    const vars = blockVars(selector)
    const surface = vars.get('--color-surface')!
    const bg = vars.get('--color-bg')!
    expect(contrast(vars.get('--color-text')!, surface), `${id} text/surface`).toBeGreaterThanOrEqual(4.5)
    expect(contrast(vars.get('--color-text')!, bg), `${id} text/bg`).toBeGreaterThanOrEqual(4.5)
    expect(contrast(vars.get('--color-text-weak')!, surface), `${id} text-weak/surface`).toBeGreaterThanOrEqual(4.5)
    expect(contrast(vars.get('--color-accent')!, vars.get('--color-on-accent')!), `${id} accent/on-accent`).toBeGreaterThanOrEqual(4.5)
    // 徽标用的 warning-strong 必须压在半透明 warning-bg（叠在 surface 上）之后仍可读
    const warnBg = over(vars.get('--color-warning-bg')!, surface)
    expect(contrast(vars.get('--color-warning-strong')!, warnBg), `${id} warning-strong/warning-bg`).toBeGreaterThanOrEqual(4.5)
  })

  it.each(IDS)('%s 的浮层底色不透明（否则底下内容会透上来）', (id) => {
    const selector = id === 'dark' ? ':root' : `html.${UI_THEMES[id].className}`
    expect(blockVars(selector).get('--color-bg-elevated')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('theme-init.js 的首帧映射与注册表一致', () => {
  const text = fs.readFileSync(THEME_INIT, 'utf8')
  const literal = text.match(/var THEME_CLASSES = \{([^}]*)\}/)
  const mapping = new Map<string, string>()
  for (const m of (literal?.[1] ?? '').matchAll(/([a-zA-Z]+)\s*:\s*'([^']*)'/g)) mapping.set(m[1]!, m[2]!)

  it('脚本里能解析出注册表的每一条', () => {
    expect(mapping.size, 'theme-init.js 的 THEME_CLASSES 解析失败').toBe(UI_THEME_IDS.length)
    for (const id of UI_THEME_IDS) {
      expect(mapping.get(id), `theme-init.js 缺少 ${id}`).toBe(UI_THEMES[id].className)
    }
  })

  it('脚本不再按"是不是 light"取反，而是按 id 查表', () => {
    expect(text).not.toMatch(/===\s*'light'\s*\?/)
    expect(text).toContain('THEME_CLASSES')
  })
})
