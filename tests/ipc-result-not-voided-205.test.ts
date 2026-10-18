// V4-Iter-205：把类型改诚实只是第一步——**类型拦不住 `void r`**。
// `noUnusedParameters` 恰恰会被 `void r` 糊弄过去（那正是"用了形参"），而本仓没有把 eslint 接进 CI
// （package.json 里没有 lint 脚本）。所以 196/204 那一族真正的兜底是一条**形状闸门**：
// 全渲染层不许把 `.then` 回调的返回值 `void` 掉。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8')
// 注释里举反例（"以前写的是 .then((r) => { void r })"）不算违规
const codeOf = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !/^(\/\/|\*|\/\*)/.test(l.trim()))
    .join('\n')

/** 找出所有"回值被 void 掉"的 .then：块体 `{ void r }` 与表达式体 `=> void r` 两种形状 */
function voidedThenCallbacks(src: string): string[] {
  const hits: string[] = []
  const lineOf = (idx: number): number => src.slice(0, idx).split('\n').length
  const block = /\.then\(\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\{/g
  let m: RegExpExecArray | null
  while ((m = block.exec(src))) {
    const name = m[1]!
    const open = block.lastIndex - 1
    let depth = 0
    let i = open
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const body = src.slice(open + 1, i)
    if (new RegExp(`void\\s+${name}\\b`).test(body)) hits.push(`块体第 ${lineOf(m.index)} 行（void ${name}）`)
  }
  const expr = /\.then\(\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*void\s+\1\b/g
  while ((m = expr.exec(src))) hits.push(`表达式体第 ${lineOf(m.index)} 行（=> void ${m[1]}）`)
  return hits
}

describe('形状闸门：不许把 .then 的回值 void 掉', () => {
  it('正向对照：扫描器真能认出两种形状（否则"全绿"是没牙）', () => {
    const fixture = [
      'a.then((r) => {',
      '  void r',
      '})',
      "b.then((res) => void res).catch(() => {})",
      // 这两条是**合法**的：判了返回值 / void 的是另一个调用
      "c.then((r) => { if (hasIpcFailed(r)) fail(r.error) })",
      'd.then(() => { void reloadConversations() })'
    ].join('\n')
    expect(voidedThenCallbacks(fixture)).toEqual([
      '块体第 1 行（void r）',
      '表达式体第 4 行（=> void res）'
    ])
  })

  it('全渲染层 0 命中', () => {
    const root = path.resolve(__dirname, '../src/renderer')
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(ent.name)) {
          for (const h of voidedThenCallbacks(codeOf(read(p)))) found.push(`${path.relative(root, p)} ${h}`)
        }
      }
    }
    walk(root)
    expect(found).toEqual([])
  })
})

describe('preload 三条发起通道的类型带上了失败分支（V4-Iter-205）', () => {
  const pre = read('../src/preload/index.ts')

  for (const chan of ['sendMessage', 'regenerateMessage', 'resendMessage']) {
    it(`${chan} 声明的是"无值 ∪ 失败"，不是裸 Promise<void>`, () => {
      // 逐通道判自己那一行：文件级 toContain 正是 196 闸门被撑绿的方式（见本批的姊妹闸门）
      const line = pre.split('\n').find((l) => l.trimStart().startsWith(`${chan}: (`))
      expect(line, `找不到 ${chan} 的声明行`).toBeTruthy()
      expect(line!).toContain('Promise<void | { ok: false; error: string }>')
      expect(line!).not.toContain('): Promise<void> =>')
    })
  }

  it('全文件只剩 reportPerf 一条真·fire-and-forget 仍声明 Promise<void>', () => {
    const bare = pre.split('\n').filter((l) => l.includes('): Promise<void> =>'))
    expect(bare.map((l) => l.trim().split(':')[0])).toEqual(['reportPerf'])
  })
})
