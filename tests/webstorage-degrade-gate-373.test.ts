// V4-Iter-373 的常驻闸门：webstorage 五发「坏 JSON⇒保守降级」这一簇的关账钉子。
//
// 背景：§367 把 107 发 JSON.parse 扫完，判这五发是「设计内」（坏⇒空历史／不跳转），
// 但只写进了台账判语、没有钉子——所以每次换面 hunt 都可能被重新扫成"新缺陷"。
// 本闸门把这簇永久关账：钉住"坏 JSON 时这五处到底做什么"，谁要改这个降级方向就得先过这里。
//
// 三条不变量：
//  A（五发都要）：消费／读取函数体内**不许 throw**——坏 JSON 只能降级（返回空／null），
//     绝不把 SyntaxError 上抛（上抛＝渲染期抛错，可能把整块送进 error boundary 白屏）。
//  B（四处 pending 消费）：坏 blob **必须被清掉**（函数体内有 removeItem）——否则一个坏值
//     会赖在 sessionStorage 里被每次挂载反复读、反复失败。
//  C（loadHistory）：坏 JSON ⇒ 返回空数组 `[]`（终端式 ↑ 历史读不出来就当没有，下次写自愈）。
//
// 一律用 AST 读，不用含斜杠的正则（§367 教训：`//…` 会让词法器在正则里看到"注释"）。
// 读法先自证：能读出 throw／removeItem／空数组 return 这三样，再把改坏的夹具喂进同一套读法，必须各报出来。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true)
}

/** 具名函数（声明或 const 箭头）的名字 → 函数体文本 */
function functionBodies(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.set(n.name.text, n.body.getText())
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && ts.isArrowFunction(d.initializer) && d.initializer.body) {
          out.set(d.name.text, d.initializer.body.getText())
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(parse(text))
  return out
}

interface Shape {
  found: boolean
  hasThrow: boolean
  hasRemoveItem: boolean
  catchReturnsEmptyArray: boolean
}

function analyze(bodyText: string | undefined): Shape {
  if (bodyText === undefined) return { found: false, hasThrow: false, hasRemoveItem: false, catchReturnsEmptyArray: false }
  let hasThrow = false
  let hasRemoveItem = false
  let catchReturnsEmptyArray = false
  const walk = (n: ts.Node): void => {
    if (ts.isThrowStatement(n)) hasThrow = true
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'removeItem') hasRemoveItem = true
    if (ts.isCatchClause(n) && n.block) {
      const inner = (m: ts.Node): void => {
        if (ts.isReturnStatement(m) && m.expression && ts.isArrayLiteralExpression(m.expression) && m.expression.elements.length === 0) {
          catchReturnsEmptyArray = true
        }
        ts.forEachChild(m, inner)
      }
      inner(n.block)
    }
    ts.forEachChild(n, walk)
  }
  // 从函数体本身当根，遍历（bodyText 是 "{...}" 形式，包一层表达式让 parser 认）
  const wrapped = parse('const _f = () => ' + bodyText)
  walk(wrapped)
  return { found: true, hasThrow, hasRemoveItem, catchReturnsEmptyArray }
}

const R = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8')

const FILES = {
  history: R('../src/renderer/src/utils/input-history.ts'),
  palette: R('../src/renderer/src/utils/palette-nav.ts'),
  usage: R('../src/renderer/src/modules/settings/usage-jump.ts'),
  source: R('../src/renderer/src/modules/knowledge/source-jump.ts')
}

// 五发：函数名 → 该函数所在文件 + 该函数该有的形状
const SITES: Array<{ fn: string; file: keyof typeof FILES; clearsPending: boolean; emptyArrayFallback: boolean }> = [
  { fn: 'loadHistory', file: 'history', clearsPending: false, emptyArrayFallback: true },
  { fn: 'consumePendingOpenConversation', file: 'palette', clearsPending: true, emptyArrayFallback: false },
  { fn: 'consumePendingKb', file: 'palette', clearsPending: true, emptyArrayFallback: false },
  { fn: 'consumePendingUsageJump', file: 'usage', clearsPending: true, emptyArrayFallback: false },
  { fn: 'consumePendingSourceJump', file: 'source', clearsPending: true, emptyArrayFallback: false }
]

describe('§373 webstorage 五发「坏 JSON⇒保守降级」闸门', () => {
  // —— 读法自证（不先证读法，下面的"没有 throw""有 removeItem"都可能是分类器瞎了）——
  it('读法自证：throw／removeItem／catch 返回空数组 三样都读得到，且能区分有无', () => {
    const good = analyze(functionBodies('const f = () => { try { JSON.parse(x); storage.removeItem(k); return [] } catch { storage.removeItem(k); return [] } }').get('f'))
    expect([good.found, good.hasThrow, good.hasRemoveItem, good.catchReturnsEmptyArray], '好形状四样').toEqual([true, false, true, true])
    // 三颗"改坏"的夹具各只动一样，读法要各报出那一样
    const withThrow = analyze('() => { try { JSON.parse(x) } catch { throw new Error("bad") } }')
    expect([withThrow.hasThrow, withThrow.hasRemoveItem, withThrow.catchReturnsEmptyArray], 'throw 夹具').toEqual([true, false, false])
    const noClear = analyze('() => { try { const d = JSON.parse(x); return d } catch { return null } }')
    expect([noClear.hasThrow, noClear.hasRemoveItem], '不清 pending 的夹具').toEqual([false, false])
    const nonEmpty = analyze('() => { try { return JSON.parse(x) } catch { return [1] } }')
    expect(nonEmpty.catchReturnsEmptyArray, 'catch 返回非空数组不算空兜底').toBe(false)
  })

  // —— 五发逐个钉 ——
  for (const s of SITES) {
    it(`${s.fn}：坏 JSON 只降级、不 throw${s.clearsPending ? '、且清掉坏 blob' : ''}${s.emptyArrayFallback ? '、兜底是空数组' : ''}`, () => {
      const shape = analyze(functionBodies(FILES[s.file]).get(s.fn))
      expect(shape.found, `${s.fn} 这个函数读得到（改名/删掉要先过这里）`).toBe(true)
      expect(shape.hasThrow, `${s.fn} 体内不许 throw：坏 JSON 上抛会白屏`).toBe(false)
      if (s.clearsPending) expect(shape.hasRemoveItem, `${s.fn} 必须清掉坏 pending（否则赖着被反复读）`).toBe(true)
      if (s.emptyArrayFallback) expect(shape.catchReturnsEmptyArray, `${s.fn} 坏 JSON 兜底必须是空数组 []`).toBe(true)
    })
  }

  // —— 反向钉：这五发的存储读点确实各带一个 try/catch（不是"其实没兜底、分析器对着没有 catch 的函数放行"）——
  it('五发各自真的包在 try/catch 里（catch 存在＝降级有出处；不是空转）', () => {
    for (const s of SITES) {
      const body = functionBodies(FILES[s.file]).get(s.fn) ?? ''
      expect(/catch/.test(body), `${s.fn} 里要看得见 catch`).toBe(true)
      expect(/JSON\.parse/.test(body), `${s.fn} 里要看得见 JSON.parse（本闸门盯的就是它的坏输入）`).toBe(true)
    }
  })
})
