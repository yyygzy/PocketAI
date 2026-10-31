// V4-Iter-378 闸门：`formatBytes` 的两档不许再被合回去。
//
// 病（§377 真机撞出、本枚收）：helper 里 `n <= 0` 与"非有限值"共用一个 '-' ⇒ "确实没有"（回收 0 字节、附件为空、
// 新装机器的七个体积格）与"读不到"在屏上长成同一个串；而 `DataHealthPanel.onClearCache` 还额外借 `formatBytes(0)`
// 当"没有报告"的哨兵（那颗键只在 `!report` 那道门之后才存在＝分支根本走不到）。
//
// 判据要能钉住"回到改前"的两种写法，所以三面都带漏杀对照：
//   A helper 第一句必须只挡「非有限 或 负数」，不许把 0 一起挡；
//   B 全仓不许再出现 `formatBytes(0)` 这种借 0 当哨兵的写法（B1），也不许在消费面写
//     「假值 ⇒ '-'」的本地兜底把两档就地合回去（B2）；
//   C `onClearCache` 的第一句必须是 `if (!report) return`（三元哨兵的替代品，删了就等于把哨兵请回来）。
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf-8').replace(/\r\n/g, '\n')

const FORMAT = read('renderer/src/utils/format.ts')
const PANEL = read('renderer/src/modules/settings/DataHealthPanel.tsx')

/** 剥块注释与行尾注释（注释里提到旧写法不该被算成"又用了一次"；引号里的 // 不吃） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(String.fromCharCode(10))
    .map((line) => {
      let quote = ''
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (quote) {
          if (c === '\\') i++
          else if (c === quote) quote = ''
          continue
        }
        if (c === "'" || c === '"' || c === '`') quote = c
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
      }
      return line
    })
    .join(String.fromCharCode(10))
}

const sf = (name: string, src: string): ts.SourceFile => ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** 取 `export function name(...)` / `const name = ... => {}` 那个节点（按名字找函数声明或箭头函数） */
function findFn(file: ts.SourceFile, name: string): ts.Node | undefined {
  let hit: ts.Node | undefined
  walk(file, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) hit = n
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isArrowFunction(n.initializer)) hit = n.initializer
  })
  return hit
}

const bodyTextOf = (file: ts.SourceFile, name: string): string => {
  const fn = findFn(file, name)
  if (!fn) throw new Error(`找不到 ${name}（读法失效，不是代码失效）`)
  const body = ts.isFunctionDeclaration(fn) ? fn.body : (fn as ts.ArrowFunction).body
  if (!body) throw new Error(`${name} 没有块体`)
  return body.getText(file)
}

const firstStatementOf = (file: ts.SourceFile, name: string): ts.Statement => {
  const fn = findFn(file, name)
  if (!fn) throw new Error(`找不到 ${name}（读法失效，不是代码失效）`)
  const body = ts.isFunctionDeclaration(fn) ? fn.body : (fn as ts.ArrowFunction).body
  if (!body || !ts.isBlock(body)) throw new Error(`${name} 的体不是块语句（形状变了，判据要跟着改）`)
  const first = body.statements[0]
  if (!first) throw new Error(`${name} 的体是空的（读法读不到任何守卫）`)
  return first
}

/** 逐行扫全仓 src（剥注释后按行匹配，命中给「相对路径:行号」） */
function srcHits(re: RegExp): string[] {
  const dir = path.resolve(__dirname, '..', 'src')
  const hits: string[] = []
  const scan = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) scan(p)
      else if (/\.tsx?$/.test(e.name)) {
        stripComments(read(path.relative(dir, p)))
          .split(String.fromCharCode(10))
          .forEach((line, i) => {
            if (re.test(line)) hits.push(`${path.relative(path.resolve(__dirname, '..'), p)}:${i + 1}  ${line.trim()}`)
          })
      }
    }
  }
  scan(dir)
  return hits
}

describe('读法自证（先证明这套读法读得到东西，也认得改前那一形）', () => {
  it('formatBytes 的体读得到、第一句就是那道挡非有限值的守卫', () => {
    const text = bodyTextOf(sf('format.ts', FORMAT), 'formatBytes')
    expect(text).toContain('Number.isFinite')
    expect(firstStatementOf(sf('format.ts', FORMAT), 'formatBytes').getText(sf('format.ts', FORMAT))).toContain('Number.isFinite')
  })

  it('onClearCache 的体读得到（它是 const 箭头函数，不是 function 声明）', () => {
    expect(bodyTextOf(sf('panel.tsx', PANEL), 'onClearCache')).toContain('clearBrowserCache')
  })

  it('漏杀对照①：把 helper 写成改前的 `n <= 0`，这套读法必须判它"把 0 一起挡了"', () => {
    const before = sf('x.ts', 'export function formatBytes(n: number): string {\n  if (!Number.isFinite(n) || n <= 0) return \'-\'\n  return \'x\'\n}')
    const first = firstStatementOf(before, 'formatBytes').getText(before)
    expect(/n\s*<=\s*0/.test(first), '改前那一形没被认出（这条判据就是空的）').toBe(true)
    const now = sf('y.ts', FORMAT)
    expect(/n\s*<=\s*0/.test(firstStatementOf(now, 'formatBytes').getText(now)), '现在的写法还在挡 0').toBe(false)
  })

  it('漏杀对照②：`formatBytes(0)` 那种哨兵写法，扫描读法读得出来', () => {
    const before = 'const shown = report ? formatBytes(report.sizes.browserCacheBytes) : formatBytes(0)'
    expect((before.match(/formatBytes\(0\)/g) ?? []).length).toBe(1)
  })

  it('漏杀对照③：消费面把「假值」兜成 -（`? formatBytes(x) : -`）这一形，扫描读法也读得出来', () => {
    const dash = "const v = sizes.dbBytes ? formatBytes(sizes.dbBytes) : '-'"
    expect(/formatBytes\([^()]*\)\s*:\s*'-'/.test(dash), '改前那形的消费面翻版没被认出').toBe(true)
    const ok = "const v = g.memory ? formatBytes(g.memory) : ''"
    expect(/formatBytes\([^()]*\)\s*:\s*'-'/.test(ok), '把空串兜底误杀了（那是现存的合法形状）').toBe(false)
  })
})

describe('A：helper 的两档不许合回去', () => {
  it('第一句只挡「非有限 或 负数」——条件里不许出现 <= 0 / < 1 / === 0 这类把 0 归到"拿不到"的写法', () => {
    const file = sf('format.ts', FORMAT)
    const first = firstStatementOf(file, 'formatBytes').getText(file)
    expect(first).toMatch(/!\s*Number\.isFinite\(\s*n\s*\)/)
    expect(first, '0 又和"拿不到"共用一个破折号了：' + first).not.toMatch(/n\s*<=\s*0/)
    expect(first, '把 0 挡成"拿不到"的其它写法（< 1 / === 0）也不许回来：' + first).not.toMatch(/n\s*(<\s*1|===\s*0)/)
  })

  it('体里不许另开一条「0 ⇒ \'-\'」的分支（换个地方把两档合回去）', () => {
    const text = bodyTextOf(sf('format.ts', FORMAT), 'formatBytes')
    expect(text, 'helper 里出现了把 0 直接映射成 \'-\' 的分支').not.toMatch(/n\s*(===\s*0|<\s*1)[\s\S]{0,40}return\s*'-'/)
  })

  it('负数那一档仍然是"拿不到"（本枚只分 0，不许顺手把读失败的产物也变成 0 B）', () => {
    expect(FORMAT).toMatch(/n\s*<\s*0/)
  })
})

describe('B：全仓不许再把「确实没有」写成「拿不到」', () => {
  it('B1 src 里 formatBytes(0) 的出现次数＝0（借 0 当"没有数据"的哨兵）', () => {
    const hits = srcHits(/formatBytes\(\s*0\s*\)/)
    expect(hits.join('\n'), '又有人用 formatBytes(0) 演"没有报告"：' + hits.join('、')).toBe('')
  })

  it("B2 src 里不许有「假值 ⇒ '-'」的本地兜底（在消费面把两档就地合回去）", () => {
    const hits = srcHits(/formatBytes\([^()]*\)\s*:\s*'-/)
    expect(hits.join('\n'), '消费面又出现把 0 画成破折号的兜底：' + hits.join('、')).toBe('')
  })
})

describe('C：哨兵那处的替代品必须真的在那儿', () => {
  it('onClearCache 的第一句是 `if (!report) return`（不是三元，也不是不判）', () => {
    const file = sf('panel.tsx', PANEL)
    const first = firstStatementOf(file, 'onClearCache')
    expect(ts.isIfStatement(first), 'onClearCache 第一句不是 if：' + first.getText(file)).toBe(true)
    const cond = (first as ts.IfStatement).expression
    expect(ts.isPrefixUnaryExpression(cond) && cond.operand.getText(file) === 'report', '判的不是 report：' + cond.getText(file)).toBe(true)
    expect((first as ts.IfStatement).thenStatement.getText(file), '那一支不是早退').toContain('return')
  })
})
