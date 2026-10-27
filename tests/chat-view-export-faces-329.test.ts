// V4-Iter-329（ChatView 面·源码级闸门）：导出长图的两张脸
//
// 为什么这一面只做源码级闸门：那颗「多选导出长图」的按钮长在批量操作栏里，而那块要 `selectedIds.size > 0`
// 才出现，选择只能由消息卡片产生，`VirtualMessageList` 在 jsdom 下一张卡片都不渲染
// （挂载面边界记在台账 §253／记忆「清单零覆盖待补」）⇒ 同 §319 的接线面一个待遇。
//
// 两条判据各守一形状：
//   · **catch 要真的说话**：两个 handler 的 catch 体内必须有 `toast.error(...)`——改前只有
//     `console.error('export image failed')`，spinner 收回、屏上零句 ⇒「点了没反应」。
//     只数 `toast` 这个词不算：判据读的是 CatchClause 里的调用节点，写成
//     `console.error(toast)`（把 toast 传进去而不调用）必须算没说话（用例④的漏杀对照之一）。
//   · **截断方向要与图上那句话同轴**：图内印的是 `chat.exportImageTooLong`「仅导出最近 500 条消息」
//     （`utils/export-image.tsx:90`），所以两处截断都得是 `slice(-LIMIT)`（一元负号＋LIMIT 标识符）。
//     改前多选那路写的是 `slice(0, LIMIT)` ⇒ 拿的是**最前** 500 条，图上却写着"最近"。
//     判据读结构：`slice(-1 * LIMIT)`、`slice(0 - LIMIT)` 这些"看着像其实不是"的都不算（用例④）。
// 用例⑤是反向钉：全文件不许再出现 `slice(0, LIMIT)`，而两处 `slice(-LIMIT)` 都在＝数量钉到 2。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const FILE = path.resolve(__dirname, '../src/renderer/src/modules/chat/ChatView.tsx')
const HANDLERS = ['handleExportImage', 'handleExportSelectedImage']

interface Face {
  handler: string
  /** catch 体里有没有 `toast.error(...)` 这一发调用 */
  toastsError: boolean
  /** 体内的截断写法（`slice(-LIMIT)` 为合规形状） */
  slices: string[]
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** `slice(...)` 的实参原文（`-LIMIT` / `0, LIMIT` / `-1 * LIMIT`…），用来判形状而不是数关键词 */
function sliceShape(call: ts.CallExpression): string {
  return call.arguments
    .map((a) => a.getText())
    .join(', ')
}

/** 找 `const <name> = useCallback(...)` 的整个 initializer 节点 */
function findHandler(src: string, name: string): ts.Node | null {
    const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true)
  let found: ts.Node | null = null
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== name) return
    if (!n.initializer) return
    found = n.initializer
  })
  return found
}

function inspect(src: string): Face[] {
  return HANDLERS.map((handler) => {
    const node = findHandler(src, handler)
    expect(node, `找不到 ${handler} 的定义（改名或整段被搬走 ⇒ 闸门要看一眼）`).toBeTruthy()
    const catchCalls: string[] = []
    const slices: string[] = []
    walk(node!, (n) => {
      if (ts.isCatchClause(n) && n.block) {
        walk(n.block, (m) => {
          if (ts.isCallExpression(m)) catchCalls.push(m.expression.getText())
        })
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'slice'
      ) {
        slices.push(sliceShape(n))
      }
    })
    return { handler, toastsError: catchCalls.includes('toast.error'), slices }
  })
}

const src = fs.readFileSync(FILE, 'utf8')

describe('329 导出长图：catch 要说话、截断方向要对', () => {
  it('两个 handler 的 catch 都在往屏上说话（不是只有 console.error）', () => {
    for (const f of inspect(src)) {
      expect(f.toastsError, `${f.handler} 的 catch 里没有 toast.error ⇒ 失败又是一次「点了没反应」`).toBe(true)
    }
  })

  it('两处截断都是 `slice(-LIMIT)`，与图上那句「仅导出最近 500 条」同轴', () => {
    for (const f of inspect(src)) {
      expect(f.slices.length, `${f.handler} 该有一处截断`).toBe(1)
      expect(f.slices[0], `${f.handler} 的截断写法：${f.slices[0]}`).toBe('-LIMIT')
    }
  })

  it('反向钉：全文件不许再出现 `slice(0, LIMIT)`，而 `slice(-LIMIT)` 恰好两处（多选那路的旧写法不能留）', () => {
    expect(src.replace(/\r/g, '')).not.toContain('slice(0, LIMIT)')
    // 数 AST 里的调用，不数原文：注释里提到 `slice(-LIMIT)` 不该被算成一处截断
    const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true)
    const shapes: string[] = []
    walk(sf, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'slice'
      ) shapes.push(sliceShape(n))
    })
    expect(shapes.filter((s) => s === '-LIMIT'), `全文件的截断写法：${JSON.stringify(shapes)}`).toHaveLength(2)
    expect(shapes.filter((s) => s === '0, LIMIT')).toHaveLength(0)
  })

  it('漏杀对照：三份真文件改出来的假源码都得被判红', () => {
    const noToast = src.replace(
      "      console.error('export image failed', e)\n      toast.error(",
      "      console.error('export image failed', e)\n      console.error(toast)\n      void ("
    )
    expect(noToast, '手术没落到盘上＝这一份对照无效').not.toBe(src)
    expect(inspect(noToast)[0]!.toastsError, '`console.error(toast)` 把 toast 传进去而没调用，不许算说话').toBe(false)

    const fakeZero = src.replace('slice(-LIMIT) : slice', 'slice(0, LIMIT) : slice')
    expect(fakeZero).not.toBe(src)
    expect(inspect(fakeZero)[1]!.slices[0]).toBe('0, LIMIT')

    const fakeMinusOne = src.replace('slice(-LIMIT)', 'slice(-1 * LIMIT)')
    expect(fakeMinusOne).not.toBe(src)
    expect(inspect(fakeMinusOne)[0]!.slices[0], '`-1 * LIMIT` 看着像负号，读结构要能认出来').not.toBe('-LIMIT')
  })

  it('手术落回原样 ⇒ 同一份判据重新放行（证明上一条红的是形状，不是闸门恒判红）', () => {
    const faces = inspect(src)
    expect(faces.every((f) => f.toastsError)).toBe(true)
    expect(faces.every((f) => f.slices[0] === '-LIMIT')).toBe(true)
  })
})
