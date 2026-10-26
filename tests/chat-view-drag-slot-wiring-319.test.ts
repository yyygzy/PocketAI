// V4-Iter-319（接线面·源码级闸门）：每个可拖按钮一格，且 pointerdown 与 dragstart 必须指向同一格。
//
// 为什么这一面只做源码级闸门：jsdom 里挂不上第二个按钮——多选导出那颗长在批量操作栏里，
// 而那块要 `selectedIds.size > 0` 才出现；选择只能由消息卡片上的勾选产生，`VirtualMessageList`
// 在 jsdom 下一张卡片都不渲染（挂载面边界记在台账 §253／记忆）。所以"哪个按钮挂哪一格"只能读源码判，
// 格子自己的规矩（代次守卫）由同批的行为用例 tests/drag-slot-correlation-319.test.ts 守。
//
// 改前的形状就是这一族的标准犯法现场：一格 `dragPathRef`、两颗按钮共用，
// 两颗的 pointerdown 都往同一格里写、两个 dragstart 都从同一格里读。迟到的预写响应只会看见"那一格"，
// 于是长图那一轮把路径写进多选刚填好的格子 ⇒ 拖出去的是另一种内容，界面毫无异常。
//
// 四条口径都是量过才定的：
//   · **格子按声明判**：`useRef<DragSlot>` 的标识符就是格子名，判据里所有"哪一格"都用它表达；
//   · **配对要两头同轴**：pointerdown 体内引用到的格子必须与 dragstart 体内引用到的**同一个**，
//     且各自只能引用一个（引用到两个＝又在共用）；两对之间必须**不同格**；
//   · **代次要真的来自 beginDrag**：`commitDrag` 的第二参必须是本体内 `= beginDrag(...)` 那个标识符，
//     写成 `commitDrag(slot, 0, p)` 这种"看着有守卫其实恒不成立／恒成立"的都不算；
//   · **不许绕过 helper 直接写格**：全文件不得出现 `<格子>.current.path =`（写只准走 commitDrag）。
// 用例④把前三条各演一遍漏杀对照（真文件改出来的三份假源码），用例⑤是反向钉：
// 新添一颗正确配对的按钮要进名单，新添一颗配错格的要当场判红。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const FILE = path.resolve(__dirname, '../src/renderer/src/modules/chat/ChatView.tsx')

interface DragPair {
  /** onPointerDown 的 handler 名（可及名会随文案漂，handler 名不会） */
  pd: string
  /** onDragStart 的 handler 名 */
  ds: string
  /** pointerdown 体内引用到的格子 */
  pdSlots: string[]
  /** dragstart 体内引用到的格子 */
  dsSlots: string[]
  /** dragstart 是不是读 `<格>.current.path` */
  readsPath: boolean
  /** commitDrag 的代次参数取自本体内 `= beginDrag(...)` 的那个标识符 */
  genWired: boolean
}

interface Scan {
  slots: string[]
  pairs: DragPair[]
  /** 绕过 helper 的直接写：原文 */
  directWrites: string[]
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** handler 名 → 函数体（只认 `const X = useCallback(...)` 这一种声明形状） */
function bodiesOf(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>()
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name)) return
    const init = n.initializer
    if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return
    if (init.expression.text !== 'useCallback') return
    const fn = init.arguments[0]
    if (fn) out.set(n.name.text, fn)
  })
  return out
}

/** JSX 元素上 `{标识符}` 形状的回调属性值 */
function handlerNameOf(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, attr: string): string | undefined {
  for (const p of el.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== attr) continue
    const init = p.initializer
    if (!init || !ts.isJsxExpression(init) || !init.expression) return undefined
    if (!ts.isIdentifier(init.expression)) return `__EXPR__:${init.expression.getText()}`
    return init.expression.text
  }
  return undefined
}

function scan(src: string): Scan {
  const sf = ts.createSourceFile('scan.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const slots: string[] = []
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name)) return
    const init = n.initializer
    if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return
    if (init.expression.text !== 'useRef') return
    const ta = init.typeArguments
    if (ta?.some((t) => t.getText().includes('DragSlot'))) slots.push(n.name.text)
  })
  const slotSet = new Set(slots)

  const bodies = bodiesOf(sf)

  const isSlotPathRead = (node: ts.Node): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'path') return false
    const inner = node.expression
    return (
      ts.isPropertyAccessExpression(inner) &&
      inner.name.text === 'current' &&
      ts.isIdentifier(inner.expression) &&
      slotSet.has(inner.expression.text)
    )
  }

  const directWrites: string[] = []
  walk(sf, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
    if (isSlotPathRead(n.left)) directWrites.push(n.getText())
  })

  const pairs: DragPair[] = []
  walk(sf, (n) => {
    if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return
    const pd = handlerNameOf(n, 'onPointerDown')
    const ds = handlerNameOf(n, 'onDragStart')
    if (!pd || !ds) return
    const referenced = (name: string): string[] => {
      const body = bodies.get(name)
      if (!body) return []
      const hits: string[] = []
      walk(body, (inner) => {
        if (ts.isIdentifier(inner) && slotSet.has(inner.text) && !hits.includes(inner.text)) hits.push(inner.text)
      })
      return hits
    }
    const pdBody = bodies.get(pd)
    let readsPath = false
    if (pdBody === undefined || !bodies.get(ds)) return
    walk(bodies.get(ds)!, (inner) => {
      if (isSlotPathRead(inner)) readsPath = true
    })
    // 代次对账：本体内 `const g = beginDrag(...)` 的 g，必须是 commitDrag 的第二参
    const genNames: string[] = []
    const commitArgs: string[] = []
    walk(pdBody!, (inner) => {
      if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && inner.initializer &&
        ts.isCallExpression(inner.initializer) && ts.isIdentifier(inner.initializer.expression) &&
        inner.initializer.expression.text === 'beginDrag') {
        genNames.push(inner.name.text)
      }
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) &&
        inner.expression.text === 'commitDrag') {
        const gen = inner.arguments[1]
        if (gen && ts.isIdentifier(gen)) commitArgs.push(gen.text)
      }
    })
    pairs.push({
      pd,
      ds,
      pdSlots: referenced(pd),
      dsSlots: referenced(ds),
      readsPath,
      genWired: commitArgs.length > 0 && commitArgs.every((g) => genNames.includes(g))
    })
  })

  return { slots, pairs, directWrites }
}

const SRC = fs.readFileSync(FILE, 'utf8')
// 按行手术，不按整串 replace：这棵树现在工作副本是 LF，但 autocrlf 之后会翻成 CRLF，
// 那时含换行的字符串锚点会静默不命中 ⇒ 三份假源码都等于原文件、对照全废（§309 同款教训）。
const nl = SRC.includes('\r\n') ? '\r\n' : '\n'
const scanLines = (arr: string[]): Scan => scan(arr.join(nl))
const replaceLine = (lines: string[], pred: (l: string) => boolean, next: (l: string) => string): string[] => {
  const idx = lines.findIndex(pred)
  if (idx < 0) throw new Error('漏杀对照的锚点找不到（源码形状变了，对照要跟着改）')
  const out = [...lines]
  out[idx] = next(lines[idx]!)
  return out
}

describe('§319 ChatView 拖拽槽的接线（源码级闸门）', () => {
  it('格子恰好两格、可拖按钮恰好两对（新增了就得进来判一遍）', () => {
    const s = scan(SRC)
    expect(s.slots).toEqual(['pngDragRef', 'mdDragRef'])
    expect(s.pairs.map((p) => `${p.pd}→${p.ds}`)).toEqual([
      'handleImageDragPointerDown→handleImageDragStart',
      'handleMessagesDragPointerDown→handleMessagesDragStart'
    ])
  })

  it('每对 pointerdown 与 dragstart 同格、两对不同格，且都真读 .current.path、代次真取自 beginDrag', () => {
    const s = scan(SRC)
    const bad = s.pairs.filter(
      (p) =>
        p.pdSlots.length !== 1 ||
        p.dsSlots.length !== 1 ||
        p.pdSlots[0] !== p.dsSlots[0] ||
        !p.readsPath ||
        !p.genWired
    )
    expect(bad, `配对不同轴／没读路径／代次没接上：${JSON.stringify(bad)}`).toEqual([])
    const used = s.pairs.map((p) => p.pdSlots[0])
    expect(new Set(used).size, `两颗按钮共用同一格（改前形状）：${used.join('/')}`).toBe(used.length)
  })

  it('没有绕过 commitDrag 的直接写格', () => {
    expect(scan(SRC).directWrites, `出现 <格>.current.path = 的赋值：${scan(SRC).directWrites.join('；')}`).toEqual([])
  })

  it('漏杀对照：共用一格／绕开代次直接写／代次写死常量——三种都得判红', () => {
    const lines = SRC.split(nl)

    // ① 改前的形状：多选那颗按钮的 dragstart 换回长图那个 handler（两对同格）
    const shared = scanLines(
      replaceLine(lines, (l) => l.trim() === 'onDragStart={handleMessagesDragStart}', () => '              onDragStart={handleImageDragStart}')
    )
    const mdPair = shared.pairs.find((p) => p.pd === 'handleMessagesDragPointerDown')
    expect(mdPair?.dsSlots, '共用一格时必须看得见 dragstart 读的是别人的格子').toEqual(['pngDragRef'])
    expect(mdPair && mdPair.pdSlots[0] !== mdPair.dsSlots[0], '共用一格必须判成不同轴').toBe(true)

    // ② 绕开 helper 直接写格（代次守卫就此失效）
    const direct = scanLines(
      replaceLine(lines, (l) => l.includes('commitDrag(slot, gen, p)'), (l) => l.replace('commitDrag(slot, gen, p)', 'mdDragRef.current.path = p'))
    )
    expect(direct.directWrites.length, '直接写格要数得出来').toBe(1)
    expect(direct.pairs.find((p) => p.pd === 'handleMessagesDragPointerDown')?.genWired, '没 commitDrag 就没代次对账').toBe(false)

    // ③ 留着那句调用、代次却是写死的 0（守卫恒不成立 ⇒ 永远写不进；只数 token 的判据对这种是瞎的）
    const frozen = scanLines(
      replaceLine(lines, (l) => l.includes('commitDrag(slot, gen, p)'), (l) => l.replace('commitDrag(slot, gen, p)', 'commitDrag(slot, 0, p)'))
    )
    expect(frozen.pairs.find((p) => p.pd === 'handleMessagesDragPointerDown')?.genWired, '代次写死必须判成没接上').toBe(false)
  })

  it('反向对照：新添一颗按钮要进名单——配对了就两判据都绿、配错格就当场红', () => {
    const ok = `${SRC}${nl}const probeDragRef = useRef<DragSlot>({ gen: 0, path: null })${nl}` +
      `const __probeDown = useCallback(() => { const s = probeDragRef.current; const g = beginDrag(s); commitDrag(s, g, 'x') }, [])${nl}` +
      `const __probeStart = useCallback((e: React.DragEvent) => { if (!probeDragRef.current.path) e.preventDefault() }, [])${nl}` +
      `const __probeJsx = <button onPointerDown={__probeDown} onDragStart={__probeStart} />${nl}`
    const s = scan(ok)
    expect(s.slots.length, '第三格要数得到').toBe(3)
    expect(s.pairs.length, '第三对要进名单').toBe(3)
    const probe = s.pairs[2]!
    expect([probe.pdSlots, probe.dsSlots, probe.genWired, probe.readsPath], '正确配对的new站点要判绿').toEqual([
      ['probeDragRef'],
      ['probeDragRef'],
      true,
      true
    ])

    // 配错格：pointerdown 写 probe 那格、dragstart 读长图那格 ⇒ 同一条判据要判红
    const wrong = ok.replace('if (!probeDragRef.current.path)', 'if (!pngDragRef.current.path)')
    const w = scan(wrong).pairs[2]!
    expect([w.pdSlots, w.dsSlots], '配错格的新站点要看得见两两不同轴').toEqual([['probeDragRef'], ['pngDragRef']])
  })
})
