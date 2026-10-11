// theme.css 令牌一致性：代码里 var(--x) 引用的变量必须真的存在
//
// 起因是实机报「提示词片段弹层背景透明、影响阅读」——查下来是 `--color-bg-elevated`
// 被 7 处引用却从未在 theme.css 定义过。CSS 对未定义且无兜底值的 var() 的处理是
// 让整条声明失效（不是回退成透明那么温和），所以 `bg-[...]` 等于没写。
// 这类漂移 TS/构建都不报，只有眼睛看得见 ⇒ 交给 CI 盯。
//
// 口径：
// - 带兜底值的（`var(--font-mono, monospace)`）不算 bug，跳过；
// - 剩下的已知漂移列进 KNOWN_DRIFT，**只许变短**：修完一处就把名字删掉，
//   名字不再被引用时本用例会主动失败提醒清账（不允许留悬空条目）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RENDERER_ROOT = path.join(process.cwd(), 'src', 'renderer', 'src')
const THEME_CSS = path.join(RENDERER_ROOT, 'theme.css')

/** 已知漂移（应为空；临时容忍某条时写在这里，值 = 该名字当前被无兜底引用的处数）。 */
const KNOWN_DRIFT: Record<string, number> = {}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 取 `:root {` / `html.light {` 这类顶层块里定义的变量名 */
function definedIn(css: string, selector: string): Set<string> {
  const start = css.indexOf(selector)
  expect(start, `theme.css 里找不到 ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return new Set([...css.slice(start, end).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!))
}

const css = fs.readFileSync(THEME_CSS, 'utf8')
const dark = definedIn(css, ':root')
const light = definedIn(css, 'html.light')

/** 收集所有「无兜底值」且未定义的 var() 引用 */
function undefinedRefs(): Map<string, string[]> {
  const hits = new Map<string, string[]>()
  for (const file of listFiles(RENDERER_ROOT)) {
    if (file.endsWith('theme.css')) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)(\s*,[^)]*)?\)/g)) {
      const name = m[1]!
      const hasFallback = Boolean(m[2])
      if (hasFallback || dark.has(name) || light.has(name)) continue
      const line = text.slice(0, m.index).split('\n').length
      hits.set(name, [...(hits.get(name) ?? []), `${path.relative(process.cwd(), file)}:${line}`])
    }
  }
  return hits
}

describe('theme.css 令牌', () => {
  it('暗色与亮色两套定义的变量名完全对等（漏一套 = 另一套主题下声明失效）', () => {
    const onlyDark = [...dark].filter((v) => !light.has(v))
    const onlyLight = [...light].filter((v) => !dark.has(v))
    expect({ onlyDark, onlyLight }).toEqual({ onlyDark: [], onlyLight: [] })
  })

  it('回归点：--color-bg-elevated 两主题都有且不透明（弹层不许再是透明）', () => {
    for (const set of [dark, light]) {
      expect(set.has('--color-bg-elevated')).toBe(true)
    }
    const values = [...css.matchAll(/--color-bg-elevated:\s*([^;]+);/g)].map((m) => m[1]!.trim())
    expect(values).toHaveLength(2)
    // 十六进制不透明色；rgba(...) 或 transparent 都会让浮层重新透出底下内容
    for (const v of values) expect(v).toMatch(/^#[0-9a-f]{3,8}$/i)
  })

  it('无兜底的未定义变量只剩 KNOWN_DRIFT 里那几个（新增即失败；修完请删条目）', () => {
    const refs = undefinedRefs()
    const unexpected = [...refs.keys()].filter((n) => !(n in KNOWN_DRIFT))
    expect(unexpected.map((n) => [n, refs.get(n)])).toEqual([])
  })

  it('KNOWN_DRIFT 每条都还在被引用、处数没偷偷变多（变少就更新数字）', () => {
    const refs = undefinedRefs()
    for (const [name, count] of Object.entries(KNOWN_DRIFT)) {
      const sites = refs.get(name)
      expect(sites, `${name} 已不再被无兜底引用，请把条目从 KNOWN_DRIFT 删掉`).toBeDefined()
      expect(
        sites!.length,
        `${name} 引用处数变成 ${sites!.length}（记录是 ${count}）：修完了就更新 KNOWN_DRIFT`
      ).toBeLessThanOrEqual(count)
    }
  })
})
