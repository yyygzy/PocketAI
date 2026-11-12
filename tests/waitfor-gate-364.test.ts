// §364 闸门：jsdom 用例里「门等的是别的东西、断言却同步读屏」这一族（会假红的那一档）
//
// 来路＝§361 全量第一趟在 992s 负载窗里红两条 → §362 用**延迟到货的桩**确定性复现（不是重造负载）→
// §363 收第三处 → 本批横扫全仓把这一面钉住。判据口径（三条都要满足才算候选）：
//   ① 语句是 `await waitFor(cb)`；
//   ② cb **没把屏等到变**——判据不是「门体里有没有读屏的字面量」，而是**逐条看门里 expect 的极性**
//      （**屏有两类**，§400 补第二半：DOM 屏＝下面说的字面量＋闭包 helper；hook 屏＝`result.current`。
//       门按「存在」读了 hook 屏 ⇒ 同样放行，只是另记一格 hookGates，不占 domGates）：
//      · 有一条「读屏 且 要求存在」⇒ 门确实在等屏，放行（domGates）。
//      · 「读屏却只要求不存在」（`toEqual([])`／`toBeNull()`／`toHaveLength(0)`／`toBeFalsy()`）＝空极门：
//        单看它 t=0 就为真、门立刻放行 ⇒ §363 那一发（等「没有 alert」再去读历史按钮）就是这个形状。
//        但同块里更早已把屏上某样东西断成存在（先验失败横幅 ⇒ 点重试 ⇒ 再等它退场；上屏也可能发生在被调用的
//        本地 helper 体内）时，这一发是「等退场」＝有牙的转换门 ⇒ 另记一桶（transitionGates）放行。
//        这一半是**粗判、不比对象**（比对象会把 264 那两颗"先前用 bodyText() 读到横幅、门等 alerts() 变空"判成假阳）。
//      · 双否定要还原形：`not.toBeNull()`／`not.toBeUndefined()`／`not.toBeFalsy()`／`not.toEqual([])`／
//        `not.toHaveLength(0)` 都是**要求存在**（第一版把 `.not.` 一律算不存在 ⇒ 两颗 presence 门被误当候选）。
//      · 读屏字面量 = screen／document／container／querySelector／textContent／*By* 查询／innerHTML，
//        外加本地读屏 helper 的**传递闭包**（`shown()`→`sel()`→`screen`：第一版只认直接摸 DOM 那一层，
//        于是 228 那颗门被读成「不读屏」＝假阳）；标识符边界不能用 `\b`（中文标识符在它下面不成立——
//        这是扫描第一版把 208 条当候选的另一处假阳成因）。
//        §401 又补两半：`result`／`result.current` 的**别名**（`const { result: r } = renderHook(...)`、
//        `const st = result.current`）也当读屏；以及**门后把屏读进本地量、紧随的 `expect` 只断那颗本地量**
//        （那句 expect 自己没有任何读屏字面量＝旧版看不见，见 `locals` 那段）。
//      · `expect(...)` 的文本要**爬到链顶**再取：`expect(a()).toEqual([])` 只取 `expect(a())` 会把 matcher 丢掉，
//        于是全仓的「只断不存在」门一律读成「断存在」＝整面无声变宽（第一趟实测 absence 型门 0 颗就是这么来的）。
//   ③ 紧随其后（同块、中间没有第二次 await）是一条 `expect(...)` 且读屏，且它要求「存在」
//      （`findBy*` 自己会等⇒安全；要求「不存在」的那一档进 absenceOnly——**注意这一桶方向不单一**：
//       若那句"不在场"要等响应落地才成立（撤横幅），它其实**会假红**；若是"成功路径根本不该画"，它只会漏报。
//       方向取决于产品何时画，源码看不出来 ⇒ §365 的处理＝逐条判、把名单连判语钉死，不再自动化。）
// 两头钉：正向候选必须 0；改前形状喂进同一个分类器必须逐条报出来（不然"0"只是分类器失明）。
// 已知盲区（如实记，本批不收）：
//   · 门按"存在"读了 X、紧随的断言读的却是另一颗更晚到货的 Y ⇒ 放行。要收这一档得比"门读的那颗==断言读的那颗"，
//     会把大量「门等加载完、断言查内容」的正常写法判成候选。
//   · 转换门依赖「撤横幅与画新数据落在同一批 setState」——React 18 自动批处理下成立，逐处再验要读产品码的写序。
//   · 「读屏」认**两类**屏（§400 收的就是第二半）：DOM 屏＝`screen`／`textContent`／闭包 helper；
//     hook 屏＝`result.current`。真 hook 夹具（`renderHook`＋`result.current`）读的是渲染层状态、
//     同样要等响应落地才有值，但它不碰 DOM⇒旧版一律落进「门后没有读屏断言」，这一面看不见。
//     §398 全量第一趟就是这么红了一颗（门等 `getRunStats` 的**调用计数**、紧随同步读
//     `result.current.runStats`＝计数门 t=0 就放行，读的是落地之前那一帧）——同族在 §380／§396 已各摆七颗／九颗，
//     只是那次没撞上。§400 把它当成第二类屏收干：门里按「存在」读 `result.current`⇒另记一桶（hookGates）放行，
//     门不等任何屏、紧随的同步断言读 `result.current` 且要求存在⇒照旧进「会假红」；「无紧随读屏」那一格
//     因此从 400 搬到 309（现查）。当时留下的两档**与 DOM 半同形**的盲区，§401 收掉两半、新记一条边界：
//     – （§401 已收）**别名**：`const { result: r } = renderHook(...)` 之后的 `r.current.x`、
//       `const st = result.current` 之后的 `st.x` 也算读 hook 屏（readsHook 现查别名表）。
//       现查全仓 44 处 `renderHook` 都直接写 `result.current`⇒**0 处真样本**，这一半今天不动任何桶，
//       净效果只是"分类器认得这种写法"，由两条 fixture 钉住（漏杀对照②＝`r.current` 当候选、反向对照③＝`st.x` 当门在读屏）。
//     – （§401 已收）门后先把屏读进**本地量**、紧随的 `expect` 只断那颗本地量（句子里没有任何读屏字面量）＝
//       间接读屏。这一半现查**1 处真样本**＝`ipc-stop-silent-266.test.tsx` 改前 :141→:145，
//       按 §364 口径折进同一道门后从「无紧随读屏」搬进「按存在读屏」（588／308，见下面的现数注释）。
//     – （§401 **有意不收**的边界，fixture 钉住＝反向对照④）屏读发生在第二次 await **之前**、断言在其后⇒本面
//       不报（那道门保护不到它，门等的是另一件事）；收它要按语句顺序重排"屏读落在哪一帧"，成本另计。
//     – hook 屏与 DOM 屏之间仍**不比对象**：门按存在读了 `result.current.a`、紧随断言读更晚到货的 `result.current.b`
//       ⇒ 放行（与第一条盲区同一条口子，收它要把两颗取值比成同一颗，会把大量正常写法判成候选）。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const DOM_BASE = /\b(screen|document|container)\b|querySelector|textContent|getBy[A-Za-z]+|queryBy[A-Za-z]+|getAllBy[A-Za-z]+|toHaveTextContent|toBeInTheDocument|innerHTML/
const ABSENCE = /(?:^|[^A-Za-z])\.not\.|toBeNull\(\)|toEqual\(\[\]|toHaveLength\(0\)|toBeFalsy\(\)/
/** 双否定＝要求存在：`.not.` 后面跟的正是「不存在」型 matcher */
const NOT_ABSENT = /\.not\.(toBeNull|toBeUndefined|toBeFalsy|toEqual\(\[\]\)|toHaveLength\(0\))/
/** 这一句断的是「屏上没有」吗（`not.toBeNull()` 这类双否定不算） */
const isAbsence = (s: string): boolean => ABSENCE.test(s) && !NOT_ABSENT.test(s)
/**
 * §400 第二份屏：真 hook 夹具（`renderHook`）读的是 `result.current.*`＝渲染层状态，
 * 同样要等响应落地才有值，但它不碰 DOM。§398 全量第一趟就是这么红了一颗（门等**调用计数**、
 * 紧随同步读 `result.current.runStats`＝计数门 t=0 就放行，读的是落地之前那一帧），
 * 而本面当时把它记成「门后没有读屏断言」＝看不见。⇒ 读屏 ＝ 读 DOM **或** 读 hook 状态。
 */
const HOOK = /\bresult\.current\b/

interface Cand {
  file: string
  gateLine: number
  domLine: number
  gate: string
  dom: string
}
interface Scan {
  /** 门不等屏、紧随其后要求屏上存在 ⇒ 负载窗里会假红（这一桶要收干） */
  positive: Cand[]
  /** 门不等屏、紧随其后要求不存在 ⇒ 方向要逐条判（撤除型会假红、恒不画型只会漏报），名单连判语钉死 */
  absenceOnly: Cand[]
  /** 门按「存在」读了 DOM ⇒ 放行 */
  domGates: number
  /** §400：门按「存在」读了 hook 状态（`result.current.*`）⇒ 放行；与 `domGates` 分开数＝证明这一半不是空枪 */
  hookGates: number
  /** 门只断不存在、但同块更早已把那样东西断上屏（DOM 或 hook 都算）⇒ 等它退场，放行 */
  transitionGates: number
  /** 门放行之后没有"紧随的读屏断言"（这一发不构成本面的形状） */
  silent: number
  awaits: number
}

/** 在一个源文件里找候选；text/文件名可以随便给（漏杀对照就是拿假源码喂它） */
function scanSource(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(fileName, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true)
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const src = text.replace(/\r\n/g, '\n').split('\n')

  // 本地读屏 helper：取**传递闭包**（自己不摸 DOM、但调了摸 DOM 的 helper 也算）
  const decls: { name: string; body: string; node: ts.Node }[] = []
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /=>|function/.test(n.initializer.getText(sf))) {
      decls.push({ name: n.name.text, body: n.initializer.getText(sf), node: n.initializer })
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body) decls.push({ name: n.name.text, body: n.body.getText(sf), node: n.body })
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const callRe = (h: string): RegExp => new RegExp('(?<![' + '\\w' + '$])' + h + '\\s*\\(')
  const helpers = new Set<string>()
  for (let pass = 0; pass < 8; pass++) {
    const grew: string[] = []
    for (const d of decls) {
      if (helpers.has(d.name)) continue
      if (DOM_BASE.test(d.body) || [...helpers].some((h) => callRe(h).test(d.body))) grew.push(d.name)
    }
    if (grew.length === 0) break
    grew.forEach((g) => helpers.add(g))
  }
  const readsDom = (s: string): boolean =>
    DOM_BASE.test(s) || [...helpers].some((h) => callRe(h).test(s))
  /** §401 第一半：`result`／`result.current` 的**别名**也算读 hook 屏。两种写法（现查全仓 0 处，收它是把这一档
   *  从"理论盲区"变成"分类器认得"——不认它，将来一份夹具写 `const { result: r } = renderHook(...)` 就整半变瞎）：
   *   · `const { result: r } = renderHook(...)` ⇒ `r.current.x` 是读屏
   *   · `const st = result.current`（或 `= r.current`）⇒ `st.x` 是读屏
   *  标识符边界仍不许用 `\b` 起头（中文标识符在它下面不成立，§364 第一版就栽在这里），用 `(?<![\w$])`。 */
  const aliasResult: string[] = []
  const aliasState: string[] = []
  const collectAlias = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer.getText(sf).trim()
      if (ts.isObjectBindingPattern(n.name) && /renderHook\s*\(/.test(init)) {
        for (const el of n.name.elements) {
          if (ts.isBindingElement(el) && el.propertyName && ts.isIdentifier(el.name) && el.propertyName.getText(sf) === 'result') {
            aliasResult.push(el.name.text)
          }
        }
      }
      if (ts.isIdentifier(n.name) && /\.current$/.test(init)) aliasState.push(n.name.text)
    }
    ts.forEachChild(n, collectAlias)
  }
  collectAlias(sf)
  /** 标识符边界（照 `callRe` 那把尺子，只是这里比的不是调用而是取值） */
  const idRe = (x: string): RegExp => new RegExp('(?<![' + '\\w' + '$])' + x)
  const readsHook = (s: string): boolean =>
    HOOK.test(s) ||
    aliasResult.some((a) => idRe(a + '\\.current\\b').test(s)) ||
    aliasState.some((a) => idRe(a + '\\.').test(s))
  /** 本面的"屏"有两份：DOM 与 hook 状态（§400 收的那一半，§401 把别名写法也认进来） */
  const readsScreen = (s: string): boolean => readsDom(s) || readsHook(s)

  /** 子树里每一条 `expect(...)` 的**整条链**文本（爬到链顶，matcher 才不会丢） */
  const expectsIn = (node: ts.Node): string[] => {
    const out: string[] = []
    const chainTop = (n: ts.Node): ts.Node => {
      const p = n.parent
      if (!p) return n
      if (ts.isPropertyAccessExpression(p) || (ts.isCallExpression(p) && p.expression === n)) return chainTop(p)
      return n
    }
    const v = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const e = n.expression
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ''
        if (name === 'expect') {
          out.push(chainTop(n).getText(sf))
          return // 子树里再没有别的顶层 expect（参数里套 expect 的写法全仓没有）
        }
      }
      ts.forEachChild(n, v)
    }
    v(node)
    return out
  }
  /** 一段语句（含它调用的、体内会断存在的本地 helper）有没有把屏上某样东西断成存在过。
   *
   * **不比对象**，这是本面的粗判，两处实测逼出来的：
   *  · 要比"有没有"而不是"是不是同一颗"——264 那两颗门先前那句用 `bodyText()` 读到横幅、门等的是 `alerts()` 变空，
   *    按对象比是两回事 ⇒ 假阳（横幅确实上过屏，退场确实是要等的那件事）。
   *  · 也因此认不出"等错了东西"那一档——kb-doc-actions 那两发的门等的是一句**从来没上过屏**的成功 toast，
   *    粗判会把它放行；本批不靠这条判据兜它们，是把到货的见证直接折进门里（折完它们不再是候选）。
   *    留下的盲区写进文件头：新增一颗「先读过屏、再等另一样东西不在」的门会放行 ⇒ 用现数钉住、加一颗要人工过目。 */
  const putsOnScreen = (node: ts.Node): boolean => {
    const hit = (n: ts.Node): boolean => expectsIn(n).some((x) => readsScreen(x) && !isAbsence(x))
    if (hit(node)) return true
    const txt = node.getText(sf)
    return decls.some((d) => hit(d.node) && callRe(d.name).test(txt))
  }

  const out: Scan = { positive: [], absenceOnly: [], domGates: 0, hookGates: 0, transitionGates: 0, silent: 0, awaits: 0 }
  const blockOf = (n: ts.Node): ts.Block | null => (n.parent && ts.isBlock(n.parent) ? n.parent : null)
  /** 这一发空极门之前，同块里（或经由它调的本地 helper）确有东西上过屏 ⇒ 它是「等退场」，不是「没牙」 */
  const retractOf = (block: ts.Block | null, gate: ts.Statement): boolean => {
    if (!block) return false
    const stmts = block.statements
    const at = stmts.indexOf(gate)
    for (let i = 0; i < at; i++) {
      const st = stmts[i]
      if (st && putsOnScreen(st)) return true
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)) {
      const call = node.expression.expression
      const isWaitFor = ts.isCallExpression(call) &&
        ((ts.isIdentifier(call.expression) && call.expression.text === 'waitFor') ||
          (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'waitFor'))
      if (isWaitFor && call.arguments[0]) {
        out.awaits += 1
        const gate = call.arguments[0]
        const es = expectsIn(gate)
        // 门里一句 expect 都没有（`() => { foo() }`／`async () => { await … }`）⇒ 回落到整段文本判读屏
        const readsPresent = es.length > 0 ? es.some((x) => readsDom(x) && !isAbsence(x)) : readsDom(gate.getText(sf))
        const absenceReads = es.filter((x) => readsDom(x) && isAbsence(x))
        // §400：门按「存在」读了 hook 状态＝它等的就是那一帧落地，放行，但单独记一桶（与 DOM 那桶数不同＝证明这一半不是空枪）
        const hookPresent = es.some((x) => !readsDom(x) && readsHook(x) && !isAbsence(x))
        const block = blockOf(node)
        if (readsPresent) {
          out.domGates += 1
        } else if (hookPresent) {
          out.hookGates += 1
        } else if ((absenceReads.length > 0 || es.some((x) => !readsDom(x) && readsHook(x))) && retractOf(block, node)) {
          out.transitionGates += 1
        } else if (block) {
          let pushed = false
          const stmts = block.statements
          const at = stmts.indexOf(node)
          /** §401 第二半：门后先把屏读进**本地量**（`const btn = screen.getByTestId(…)`／`const st = result.current`），
           * 紧随的 `expect` 只读那颗本地量＝句子里没有任何读屏字面量 ⇒ 旧版整发落「无紧随读屏」＝看不见，
           * 而它读的仍是"落地之前那一帧"。记名只在本条门的窗口内有效，窗口里出现第二次 await 照旧断（同既有口径）。 */
          const locals: string[] = []
          for (let i = at + 1; i < Math.min(stmts.length, at + 6); i++) {
            const s = stmts[i]
            const prev = stmts[i - 1]
            if (!s || !prev) break
            if (i > at + 1 && /await\s/.test(prev.getText(sf))) break
            const txt = s.getText(sf)
            const t = txt.trim()
            if (!/^expect\(/.test(t)) {
              const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(t)
              if (m && m[1] && readsScreen(m[2] ?? '')) locals.push(m[1])
              continue
            }
            // 这条断言自己没读屏，但读的是门后刚取下来的那颗本地量＝同一帧的间接读屏
            const viaLocal = !readsScreen(t) && locals.some((x) => idRe(x).test(t))
            if (!readsScreen(t) && !viaLocal) continue
            if (/findBy/.test(t)) break // findBy 自己会等
            const cand: Cand = {
              file: fileName, gateLine: lineOf(node), domLine: lineOf(s),
              gate: (src[lineOf(node) - 1] ?? '').trim().slice(0, 90),
              dom: (viaLocal ? '[读本地量 ' + locals.join(',') + '] ' : '') + t.replace(/\s+/g, ' ').slice(0, 90)
            }
            if (isAbsence(t)) out.absenceOnly.push(cand)
            else out.positive.push(cand)
            pushed = true
            break
          }
          if (!pushed) out.silent += 1
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** §436 新判据的数据面：每个测试文件自己有几颗 await waitFor（scanAll 填） */
const PER_FILE_AWAITS: Record<string, number> = {}

function scanAll(): Scan {
  const merged: Scan = { positive: [], absenceOnly: [], domGates: 0, hookGates: 0, transitionGates: 0, silent: 0, awaits: 0 }
  const files: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(test|spec)\.(ts|tsx)$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'tests'))
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    if (rel === 'tests/waitfor-gate-364.test.ts') continue // 本文件的 fixture 文本不参与（它们也不是真语句）
    const one = scanSource(rel, fs.readFileSync(f, 'utf8'))
    if (one.awaits > 0) PER_FILE_AWAITS[rel] = one.awaits
    merged.positive.push(...one.positive)
    merged.absenceOnly.push(...one.absenceOnly)
    merged.domGates += one.domGates
    merged.hookGates += one.hookGates
    merged.transitionGates += one.transitionGates
    merged.silent += one.silent
    merged.awaits += one.awaits
  }
  return merged
}

const ALL = scanAll()
const where = (c: Cand): string => `${c.file}:${c.gateLine} -> :${c.domLine}`
const detail = (c: Cand): string => `${where(c)}  ${c.gate}  ||  ${c.dom}`

describe('§364 闸门：waitFor 的门不许等 A、断言却读 B（屏）', () => {
  it('读法自证：逐文件上限＋新文件必须登记（总量只作参考，不再钉死）', () => {
    // 六桶**互斥且守恒**（一颗门只进一格）。现数 2026-10-31（§381 又加了一份挂载用例；§380 那趟记的 1006/545 已被顶掉）＝awaits 1018／按存在读屏 557／
    // 等退场 75／门后没有读屏断言 360／会假红 0／只会假绿 18。逐颗钉死＝新增任何一格都要人工过目。
    //   §369 这 6 颗的来路（不是搬运，是净新增）：recovery-carry-notice-369 里 6 发 waitFor＝
    //   5 颗门按"那行字上屏"读（落进 按存在读屏 525→530）＋1 颗门等的是 notices.length（非 DOM 信号）、
    //   门后先 settle 再读负向句（落进 门后没有读屏断言 359→360）——后者正是本闸门第一趟把那颗门抓出来之后
    //   按 §365 的"先落定再读负向句"改的形状；改之前它是 会假红 那一档的第一手样本。
    //   75/359 这一格在 268 那颗改造后搬运过一颗：那句「点那一格＝重发这一发」的计数门后面紧跟的不再是
    //   同步读屏断言，而是另起一颗把到货见证写在里面的门⇒它从「等退场」落到「门后没有读屏断言」。
    //   §377 把这格抬到 990／537（净新增 7 颗，全在 renderer-steward-vacuum-377：① 两颗「整格逐值等于那一句」、
    //   ② 三颗（两颗同上＋一颗等到 toast 里有那句话）、③ 两颗「未知／SSD 那一档上屏」）：
    //   七颗的到货见证都写在门里第一句、门后不再另读屏⇒全部落进「按存在读屏」，其余四桶一格未动。
    //   §378 再抬到 994／541（净新增 4 颗、不是搬运）：data-health-zero-bytes-378 三颗（② 里两颗门等"确认框那颗
    //   「确认」真在"＋一颗门等回执那句话上 toast 屏）＋ renderer-steward-vacuum-377 里 §378 补的那颗（门等
    //   「回收 0 B」整值上屏）；四颗的到货见证都写在门里第一句⇒全部落进「按存在读屏」，其余四桶一格未动。
    //   §380 再抬到 1006／545／76／367（净新增 12 颗、不是搬运，两份新挂载用例都是 §380 自己写的）：
    //   renderer-steward-ollama-liveness-380 四颗（② 三颗＋badge() 助手那颗，门等都写着"推荐那一格上屏"＝
    //   到货见证在第一句）落进 按存在读屏 541→545；renderer-ollama-panel-liveness-380 七颗门等的是
    //   `callsOf('getOllamaStatus')` 这个**调用计数**（非 DOM 信号）、门后先 settle 再读屏⇒落进
    //   门后没有读屏断言 360→367；剩一颗是"重试到货后那句当场收回"的 `alerts()).toEqual([])`＝等退场 75→76。
    //   会假红与只会假绿两桶一格未动（0／18）。
    //   §381 再抬到 1018／557（净新增 12 颗、不是搬运，全在本枚新写的 renderer-settings-webdav-undecryptable-381）：
    //   那 12 颗的到货见证都写在门里第一句（「那句解不开」上屏、「同步状态」卡上屏、「已保存 WebDAV 配置」回执上屏、
    //   「增量备份完成」那一行上屏），门后不再另读屏⇒全部落进「按存在读屏」；两处负向句（保存后那句收回、正常档零 alert）
    //   都排在"等到货"的门之后，不是新形状。其余四桶一格未动（等退场 76／无紧随断言 367／会假红 0／只会假绿 18）。
    //   §385 再抬到 1026／565（净新增 8 颗、不是搬运，全在本枚新写的 renderer-rotate-undecryptable-faces-385）：
    //   四张脸各两颗——一颗门等"同屏正向对照上屏"（回执那句／✅ 那一格／成功页标题）、一颗门等"要演的到货本身"
    //   （toast 里那句话、卡片内那句告警）；到货见证都写在门里第一句、门后不再另读屏⇒全部落进「按存在读屏」；
    //   四颗反向对照读的是 `expectNoRotateNotice()`／`not.toContain` 的**同步**负向句、都排在"等到货"的门之后
    //   （§365 那句"先落定再读负向句"），不是新的门形状；`findByText` 那颗不计（分类器只认 `await waitFor`）。
    //   其余四桶一格未动（等退场 76／无紧随断言 367／会假红 0／只会假绿 18）。
    //   §395 再抬到 1027／566（净新增 1 颗、不是搬运，在 renderer-task-last-ok-face-395 的 mountTasks 助手）：
    //   那颗门的到货见证写在第一句（两行任务各自挂上 title 才放行），门后只做同步读屏⇒落进「按存在读屏」。
    //   其余四桶一格未动（等退场 76／无紧随断言 367／会假红 0／只会假绿 18）。
    //   §396 再抬到 1036／566／76／376／0／18（净新增 9 颗 awaits、不是搬运，全在 `renderer-run-stats-unread-396`
    //   一份真 hook 用例里）：这份夹具没有屏可读——门等的是 hook 状态（`conversationId` 到位）与
    //   `getLatestRunStats` 的**调用计数**／`result.current` 的值，门后也不读屏⇒九颗全落「门后没有读屏断言」
    //   （367→376），「按存在读屏」那一格一格未动。⇒ 与 §380 那七颗同一形状：**hook 层的接线用例天然走计数门**。
    //   §398 再抬到 1049／566／76／389／0／18（净新增 13 颗 awaits、不是搬运，全在 `agent-run-stats-scope-398`
    //   一份真 hook 用例里）：这份夹具与 §396 同一形状——门等的是 hook 状态（`conversationId` 到位）／两发读取的
    //   **调用计数**／`result.current` 的值，门后一律不读屏⇒13 颗全落「门后没有读屏断言」（376→389），
    //   其余四桶一格未动（会假红 0／只会假绿 18 名单只有一颗随本枚插行漂了位置，判语一字未动）。
    //   §398 的**第二段**（同一枚里补的「分步明细那一面」）再抬到 1055／395：本文件新写 6 颗，仍是同一形状
    //   ——门等调用计数（`getRunTraces`／`getLatestRunTraces` 被问了几次）与 `result.current` 的值、门后不读屏
    //   ⇒全部落「门后没有读屏断言」（389→395），其余四桶未动。
    //   §399① 再抬到 1064／571／80／395／0／18（净新增 9 颗 awaits、不是搬运，全在 `renderer-agent-composer-plus-399`
    //   一份真挂载用例里）：这九颗读的都是**屏**（`data-testid` 那颗菜单在不在、片段弹层里那一行、外面那句 alert）
    //   ⇒ 5 颗落「按存在读屏」（566→571）；另外 4 颗是"点完键等那层菜单收掉"＝同块更早已把它断上屏的**转换门**
    //   ⇒ 落「等退场」（76→80）。「门后没有读屏断言」那一格一格未动（§398 记的那条 hook 盲区本枚没踩：
    //   这份夹具读的是 DOM，不读 `result.current`）。会假红／只会假绿两桶仍为 0／18。
    //     · 同一枚里后补的两颗（「Esc 不越级」与「mousedown 再 click」那两例）再抬到 1066／572／81：
    //       一颗门等"片段那一层里那一行上屏"＝按存在读屏（571→572）、一颗门等"那一层收掉"＝等退场（80→81）；
    //       「mousedown 再 click」那例根本不写门（点完同步读），不进任何一格。
    //   §399②a 再抬到 1086／584／84／400／0／18（净新增 20 颗 awaits、不是搬运，只动两份测试：
    //   `renderer-agent-text-protocol-badge` +9、`renderer-agent-composer-plus-399` +6、`ipc-agent-config-unread-257` +5；
    //   其余文件逐份现数一字未动）：
    //   · badge 那份原来**一颗门都不写**（旧的落点是顶栏常驻徽标，挂载即画完、同步读屏就够），搬进「+」之后
    //     每一例都要先等那一行上屏⇒8 颗「门等那一行存在」＝按存在读屏（572→584 里的 8 颗）、1 颗等"菜单收掉"＝等退场；
    //   · 399 那份新增 4 颗读的是浮层外面那句 alert（到货见证写在第一句、门后只做同步读屏）、2 颗等菜单收＝等退场
    //     （81→84）；
    //   · 257 那份 ④ 的五颗读的是 `result.current`（真 hook 夹具，屏上没有这一格）⇒ 分类器看不见 DOM 之外的读屏，
    //     全部落「门后没有读屏断言」（395→400）＝§398 记下的那条 hook 盲区**第二次踩到**，形状与 §396／§398 同：
    //     门自己等的就是到货那一帧，门后同步读的是同一个值，不是「门等 A、断言读 B」。
    //   会假红仍 0、只会假绿仍 18。
    //   §399②b 再抬到 1094／587／89／400／0／18（净新增 8 颗 awaits，全在 `renderer-agent-composer-plus-399` 那 12 颗新用例里：
    //   3 颗「门等那一层/那一句存在」＋5 颗「等那一层收掉」＝等退场；`ipc-agent-config-unread-257` 那份重写后逐字仍是 16 颗）：
    //   · 同一枚把 `renderer-websearch-b3` 的那颗「只会假绿」从 :81→:82 搬成 :79→:80（去掉「先点开展开」那两行，判语一字未动）
    //     ⇒ 又一次印证「改过判据所在文件就要重取这面闸门的数字」，名单里带行号的条目会随夹具改动漂移。
    //   会假红仍 0、无紧随读屏仍 400（②b 没往 hook 夹具里加门）。
    //   §400＝**只改分桶、不新增门**：awaits 一字未动（仍 1094），"读屏"从只认 DOM 扩成 DOM＋hook 两类
    //   （第二类的字面判据＝`result.current`）⇒「门后没有读屏断言」那一格搬出 91 颗（400→309），
    //   去向＝81 颗门自己按「存在」读了 hook 屏＝新格 hookGates、9 颗门等的是 hook 屏上那句"收回"＝等退场
    //   （89→98）、1 颗门后读的是 hook 屏上的"不在场"＝进假绿名单（18→19）。
    //   · **搬完第一趟就红了两颗真的会假红**（此前它们一直藏在 309 那一格）＝
    //     `renderer-agent-zero-call-notice` 的两处：门等 `getAgentTextProtocol` 的**调用计数**（发出即放行）、
    //     紧随同步读 `result.current.providerId`／`.textProtocolForced`，而后者是渲染层推导
    //     （`src/renderer/src/modules/agent/hooks/useAgentChat.ts:314` 取 `textProtocolModels`＝响应落地才有值）
    //     ⇒ §398 记的那条盲区的第一手样本。修法按本文件口径＝把到货的见证（`textProtocolForced` 翻真）折进
    //     同一道门、排第一句，那句计数降为第二句（门仍有牙＝初值 false；两份用例 9 例改后仍全绿）。
    //   · 假绿名单多那一颗＝`renderer-run-stats-unread-396:194 -> :195`（旧版看不见它读的那份屏）：判语见那颗
    //     条目旁的注释，方向＝**只会漏报**（那一颗只在响应回来的失败分支点亮，成功／读到 null 那一发什么都不点，
    //     所以门放行时那句"不在场"恒真，不会因迟到到货而假红）。
    //   · 「按存在读 DOM」那一格 587 一格未动＝这一枚没动任何 DOM 判据，只把 hook 那半收进来。
    //   §401＝再补两半：①`result`／`result.current` 的**别名**写法（`const { result: r } = renderHook(...)`
    //     之后的 `r.current.x`、`const st = result.current` 之后的 `st.x`）＝readsHook 现查别名表；
    //     ②门后把屏读进**本地量**、紧随的 `expect` 只断那颗本地量（句子本身没有任何读屏字面量⇒旧版看不见）。
    //     终态＝**1094／588／81／98／308／0／19**：
    //      · 别名那半现查 **0 处真样本**（全仓 44 处 `renderHook` 都直接写 `result.current`）⇒今天一个桶都没动，
    //        净效果只是"分类器认得这种写法"，由两条 fixture 钉住（漏杀对照②＝`r.current` 当候选、反向对照③＝`st.x` 当门在读屏；
//        V3／V4 各只打中其中一条⇒两支的牙是分开验的，不是同一颗牙数两遍）。
    //      · 本地量那半现查 **1 处真样本**＝`ipc-stop-silent-266.test.tsx` 改前 :141→:145：那道门等的是
    //        `sel!.value`——上一句 `fireEvent.change` 已经把它设成 'p1'＝t=0 就为真＝**门本身没牙**，紧随的
    //        `expect(go, '生成键在场').toBeTruthy()` 读的却是 `const go = Array.from(document.querySelectorAll('button'))…`
    //        取下来的那颗本地量（换过服务商之后才长出来的键）⇒旧版整发落「无紧随读屏」。修法按 §364 口径＝
    //        把到货的见证（那颗键在场）折进同一道门、排第一句⇒这颗门从 silent 搬进按存在读屏
    //        （587→588、309→308），会假红仍归零、判据一句没删也没放宽。
    //      · **有意放行的边界**（fixture 钉住＝反向对照④）：屏读发生在第二次 await **之前**，门保护不到它⇒本面
    //        不报；收它要按语句顺序重排"屏读落在哪一帧"，成本另计、本枚不收。
    //   §407（＝补 SearXNG 那一支的挂载用例，台账第一百六十九次）净新增 17 颗 awaits，全在
    //     `tests/renderer-websearch-searxng-407.test.tsx` 一份新挂载用例里（九例，每例先等到货再读屏）。
    //     17 颗**全落「按存在读屏（DOM）」＝588→605**：那三个新件的取法一律写成读屏 helper
    //     （`urlLabel()`／`allowBox()`／`keyInput()`，分类器按传递闭包认），其中两道门等的是
    //     `allowBox().disabled`／`.checked` 这种**初值≠终值**的自己会变的属性＝真到货见证，不是恒真门；
    //     余下五桶一格未动，「会假红」仍归零，「只会假绿」19 颗名单一字未动（本枚不改 `renderer-websearch-b3`）。
    //   §410（＝修 truncate 裁掉行内说明那句安全限定语，台账第一百七十二次）净新增 **2 颗 awaits**，都在
    //     新挂载用例 `tests/renderer-hint-title-410.test.tsx`（六例里只有两例用 `await waitFor`，
    //     其余四例的到货见证走 `findByText`＝自带等待，不落在这面的计数里）。
    //     两颗都落「按存在读屏（DOM）」＝**605→607**：门读的是 `el.textContent` 换成下一张脸那一颗
    //     （关 🌐 那句换「未启用」／日历那颗勾换「未启用」），初值≠终值＝真到货见证（§407 那条通则的又一处），
    //     紧随的 `title` 那句读的是同一份 state、同一帧⇒不需要额外落定。
    //     余下四桶未动，「会假红」仍归零、「只会假绿」19 颗名单一字未动（本枚不改那两份兄弟用例）。
    //   §412（＝技能装完即用：向导补 skillIds 那一发＋编辑器拦停用绑定＋市场就地绑定，台账第一百七十三次）
    //     净新增 **11 颗 awaits**，全在三份新挂载用例里（`renderer-wizard-412` 8 例／`assistant-editor-skill-bind-412` 4 例／
    //     `skill-market-bind-412` 9 例）。分两桶：
    //     · **按存在读屏（DOM）＝607→615** 八颗＝市场七颗（两颗「绑好了」那句到货、一颗失败原因句、重试后长出那颗键、
    //       reject 面那句到货、reject 重试后长出键、迟到那条不许抹掉 ✓ 之前先等 ✓ 出现）
    //       ＋编辑器挂载门一颗 `querySelector('[data-skill-chip]')`（技能那一读是挂载后发的，
    //       不等 chip 到货就同步读屏＝本面当初要抓的形状）；
    //     · **无紧随读屏＝298→301** 三颗＝两份 harness 的「等那一发 saveAssistant 落地」helper（门读的是调用记录不是屏）
    //       ＋向导那一例等 `onClose` 被调（同理）。
    //     「会假红」仍归零；「只会假绿」19 颗名单只漂了一行：§412 给 `skill-market-fetch-debounce-322` 的 stub 补了一发
    //     `listAssistants`（技能市场挂载时多一发读），那份文件里那一格整体下移一行，判语未变。
    //   §415（＝P0-2a 纯文案与空态：用量屏单价空态／Linux 取词标注／三句运行前提，台账第一百七十六次）
    //     净新增 **9 颗 awaits**，全在新挂载用例 `tests/renderer-p0-2a-copy-415.test.tsx` 的用量屏那一组里
    //     （其余用例的到货见证走 `findByTestId`／`findByText`＝自带等待，不落在这面的计数里）。
    //     9 颗**全落「按存在读屏（DOM）」＝615→624**：三颗读预算卡那格标题（`getByText(「预算」)`，
    //     找不到会抛＝真到货见证），两颗读 `budgetRowText()` 那枚 helper 的返回值——helper 自己走
    //     `screen.getByText` 往上爬层、分类器按传递闭包认成读屏（§407 那条通则的又一处），等的是
    //     「¥1.23」「¥80.00」这种**初值（`—`）≠终值**的那串到货；三颗读 `querySelectorAll` 出来的
    //     趋势柱 `title` 与明细弹窗合计格（同样初值 `—` ≠ 终值 `¥0.4000`）；一颗等明细那两颗眼睛到货。
    //     余下四桶未动，「会假红」仍归零，「只会假绿」19 颗名单一字未动（本枚不改那两份兄弟用例）。
    //   「货架式助手」本批：Agent 恢复用例新增一颗门（等 `result.current.assistantId` 停在原值）
    //     ⇒ 按存在读 hook 那一桶 81→82，总数 1120→1121。
    //   §417＋§418 两批新增 **4 颗**，全落「按存在读屏（DOM）」624→628：
    //     工具策略屏 3 颗（挂载后等 fs_read、等失败句、重试后等 fs_read 回来）＋技能预算屏 1 颗
    //     （挂载后等 `[data-skill-chip]` 到货，技能那一读是挂载后才发的）。总数 1121→1125。
    //   P0-3c「当前助手生效面」把工具策略屏那枚从 3 颗改写到 7 颗（+4，全落「按存在读屏（DOM）」）：
    //     默认落点空态 1 颗、切注册表后等 fs_read 1 颗、自建助手横幅 1 颗、内置助手横幅 1 颗、
    //     失败句与重试后的空态各 1 颗 ⇒ 628→632，总数 1125→1129。
    // §436 换判据：不再钉「全仓总量」。那数字每加一个测试就要改，拦不住任何真实回归。
    // 新判据＝**逐文件上限＋新文件必须登记**：
    //   · 拦得住：既有文件里多加 waitFor（超过该文件上限）；新测试文件用了 waitFor 却没登记；
    //   · 拦不住：把 waitFor 从 A 删掉同时在 B 加同样多（总量守恒型搬运）——这一类交给下面两条身份判据
    //     （absenceOnly 名单逐颗认身份、positive 必须为 0）与四桶守恒兜；
    //   · 上限＝登记时的现数，不留余量：要加一颗就得在这里 +1 并写理由，评审能看见；
    //   · 单文件现数最高 42（renderer-kb-detail-batch）——那是一个文件的上限，不是总量。
    // 现数参考（仅供人看，不参与断言）：awaits＝1143（2026-11-10）。
    const AWAIT_CAP: Record<string, number> = {
      // 同会话并发守卫（P2 / V4-Iter-459）：第一轮必须先真正挂到 LLM 闸门上（用户消息落库），
      // 此时再起第二轮才能断言「被拒且没有第二条用户消息」；不等这一颗会在并发窗口外读到只有 0 条。
      // 上限＝现数 1，不留余量。
      'tests/agent-conversation-guard-459.test.ts': 1,
      // 父中止 ⇒ 子 run 一起停（V4-Iter-468）：停写批次后 conversations.status 不再是事实源，
      // 子 run 被中止后要等它的助手消息落到 aborted 终态，才能证明「确实一起停了」而不是正常 done。
      // 上限 2→3，上限＝现数，不留余量。
      'tests/agent-delegation-real-chain.test.ts': 3,
      'tests/agent-interject-ipc-238.test.ts': 1,
      'tests/agent-role-concurrency-chain.test.ts': 1,
      // 轮次检查器（P2 / V4-Iter-459）：展开后先等 getRunTraces 那一发真的发出（断言 beforeEach 的空账本
      // 不会把「未调用」判成通过），再等异步 trace 到货、inspector 挂上，才能读步骤行与变更清单。
      // 上限＝现数 2，不留余量。
      'tests/agent-run-inspector-459.test.tsx': 2,
      'tests/approval-audit-panel-p0-2c-3.test.tsx': 4,
      'tests/assistant-editor-skill-bind-412.test.tsx': 2,
      // V4 交互改造：助手编辑页「提示词」两页签——先等片段清单落地再点、再等插完切回系统页。
      // 上限＝现数 2，不留余量。
      'tests/assistant-editor-prompt-tabs.test.tsx': 2,
      'tests/backup-cloud-time-327.test.tsx': 4,
      'tests/backup-late-response-324.test.tsx': 27,
      'tests/backup-merge-stopped-notice-315.test.tsx': 6,
      'tests/backup-stale-banner-325.test.tsx': 15,
      // §429：技能市场孤儿文件删除后，四份按它源码约定写的用例整体迁到能力中心（文件随之改名），
      // 上限＝迁移后的现数，不留余量；绑定那一份里两条靠"切 tab 叠两发在飞读"的并发用例因触发路径消失而删除
      // （在线索引那份的并发契约没有丢，②③⑤合并重写仍在上表）。
      // 同批新增 capability-mcp-stop-429（停止按钮三条：成功退场／失败不动状态／迟到事件重读）。
      // v58（删 mcp_servers.enabled）修该文件的授权数竞态：新增 1 颗门（先等「已授权 N 个助手」到货再断言，
      // 否则后面的「停后消失」恒真）；「停后授权数消失」并进「起键就绪」那同一颗门里，不另开第二颗。
      'tests/capability-bind-412.test.tsx': 7,
      // 默认索引地址断言：点「联网加载」后只有一发 fetchSkillIndex，先等那一发真的发出（urls 收到 1 条）
      // 才能断言地址；没有这颗门会在桩调用前读到空数组，默认地址断言变成假红。上限＝现数 1，不留余量。
      'tests/capability-default-registry.test.tsx': 1,
      'tests/capability-mcp-stop-429.test.tsx': 4,
      'tests/capability-online-seq-322.test.tsx': 8,
      'tests/capability-row-residue-326.test.tsx': 4,
      'tests/capability-visibility-428.test.tsx': 6,
      // V4 交互改造：模型三项搬进「+ → 模型」后，断言要先等菜单里的行挂上再读元信息（新增 1 颗门）。
      // 上限＝现数 6，不留余量。
      'tests/chat-model-extras-461.test.tsx': 6,
      // P5 批次 1：run 索引 hook 搬到 `chat/` 后新开的行为用例——两发读库都是挂载后才落地，
      // 门要等 `runs`／`sessionStats`／`sessionUnread` 真的写进 hook 状态再断言；不等会在落地前读到空态。
      // 上限＝现数 4，不留余量。
      'tests/chat-agent-run-insights-463.test.tsx': 4,
      // §461 深搜提示：quick／auto 两档要等 `getWebSearchConfig` 那一发真的发出，再读判定结果与屏；
      // 不等这一颗会在候选态之前读到初始 false，负向断言变成假绿。上限＝现数 7，不留余量。
      'tests/chat-deep-search-running-461.test.tsx': 7,
      'tests/chat-send-failure-visible-204.test.tsx': 0,
      // 续跑提示（运行检查点那一批新增）：文案由 store 播种后异步落到 DOM，3 颗门都按「存在」读
      // 同一颗 `conversation-runtime-resume` 再断文案（第 3 颗等的是列表行），门后的负向句读的是另一档。
      // 上限＝现数 3，不留余量。
      'tests/conversation-runtime-resume-label.test.tsx': 3,
      'tests/data-health-cold-243.test.tsx': 1,
      'tests/data-health-zero-bytes-378.test.tsx': 3,
      'tests/glossary-add-failure-211.test.tsx': 6,
      'tests/ipc-agent-config-unread-257.test.tsx': 3,
      'tests/ipc-assistant-editor-list-read-270.test.tsx': 16,
      'tests/ipc-badvalue-pair-262.test.tsx': 15,
      'tests/ipc-chat-list-read-260.test.tsx': 2,
      'tests/ipc-composer-list-read-268.test.tsx': 18,
      'tests/ipc-defaults-lists-read-274.test.tsx': 8,
      'tests/ipc-envelope-prefs-258.test.tsx': 8,
      'tests/ipc-failure-behavior-218.test.tsx': 3,
      'tests/ipc-failure-behavior-220.test.tsx': 0,
      'tests/ipc-failure-behavior-221.test.tsx': 1,
      'tests/ipc-failure-behavior-222.test.tsx': 2,
      'tests/ipc-failure-behavior-223.test.tsx': 1,
      'tests/ipc-failure-behavior-224.test.tsx': 3,
      'tests/ipc-failure-behavior-225.test.tsx': 6,
      'tests/ipc-failure-behavior-226.test.tsx': 9,
      'tests/ipc-failure-behavior-227.test.tsx': 6,
      'tests/ipc-failure-behavior-228.test.tsx': 11,
      'tests/ipc-failure-behavior-229.test.tsx': 3,
      'tests/ipc-failure-behavior-230.test.tsx': 8,
      'tests/ipc-failure-settings-tier-216.test.tsx': 1,
      'tests/ipc-failure-t1-214.test.tsx': 6,
      'tests/ipc-jump-read-263.test.tsx': 13,
      'tests/ipc-jump-read-264.test.tsx': 10,
      'tests/ipc-kb-ask-list-read-272.test.tsx': 31,
      'tests/ipc-kb-read-takeover-254.test.tsx': 3,
      'tests/ipc-list-read-259.test.tsx': 7,
      'tests/ipc-market-lists-read-273.test.tsx': 24,
      'tests/ipc-provider-lists-read-271.test.tsx': 16,
      'tests/ipc-sidebar-popup-read-275.test.tsx': 6,
      'tests/ipc-stop-not-sent-265.test.tsx': 7,
      'tests/ipc-stop-silent-266.test.tsx': 21,
      'tests/ipc-stop-silent-267.test.tsx': 11,
      'tests/ipc-translate-list-read-269.test.tsx': 16,
      'tests/kb-ask-send-envelope-318.test.tsx': 6,
      'tests/kb-ask-session-envelope-330.test.tsx': 2,
      'tests/keyboard-submit-340.test.tsx': 3,
      'tests/load-fail-read-retry-350.test.tsx': 10,
      'tests/load-fail-read-retry-351.test.tsx': 5,
      'tests/load-fail-read-retry-352.test.tsx': 7,
      'tests/load-fail-read-retry-354.test.tsx': 10,
      'tests/load-fail-read-retry-355.test.tsx': 35,
      // V4-Iter-469：手工试运行加固——展开工具列表等 2 颗、forceConfirm 弹窗/确认调用 2 颗、
      // 普通工具直接调用 1 颗、示例值写回 1 颗、结果落屏 1 颗……合计 8 颗，全部按「存在」读屏。
      // 上限＝现数，不留余量。
      'tests/mcp-manual-run-469.test.tsx': 8,
      'tests/mcp-manager.test.ts': 1,
      'tests/popup-payload-owner-321.test.tsx': 3,
      'tests/recovery-carry-notice-369.test.tsx': 6,
      'tests/reminder-generation-348.test.tsx': 7,
      'tests/renderer-agent-fs-write-231.test.tsx': 12,
      'tests/renderer-app-error-boundary.test.tsx': 3,
      // V4-Iter-472：docx 预览失败面用例——点「预览正文」后等 [role=status]
      // 的失败文案到货，按存在读屏；仅此 1 颗，上限＝现数，不留余量。
      'tests/renderer-artifact-docx-preview-472.test.tsx': 1,
      // V4-Iter-476：md 产物「导出 PDF」用例——等 toast 上屏 / 等按钮离开 busy 态，
      // 分别是成功、取消静默、导出失败、读全文超限四条；仅 4 颗，上限＝现数，不留余量。
      'tests/renderer-artifact-pdf-button-476.test.tsx': 4,
      'tests/renderer-assistant-editor-tool-groups.test.tsx': 1,
      'tests/renderer-channel-b3.test.tsx': 7,
      'tests/renderer-data-health-perf.test.tsx': 2,
      'tests/renderer-encryption-panel.test.tsx': 1,
      'tests/renderer-file-open-332.test.tsx': 25,
      'tests/renderer-first-run-wizard.test.tsx': 14,
      'tests/renderer-hint-title-410.test.tsx': 2,
      'tests/renderer-image-read-256.test.tsx': 11,
      'tests/renderer-kb-ask-search-332.test.tsx': 26,
      'tests/renderer-kb-ask-title-331.test.tsx': 8,
      'tests/renderer-kb-detail-batch.test.tsx': 42,
      'tests/renderer-kb-doc-actions-331.test.tsx': 12,
      'tests/renderer-kb-eval-panel.test.tsx': 20,
      'tests/renderer-kb-jump-focus-282.test.tsx': 8,
      'tests/renderer-kb-retrieval-panel.test.tsx': 1,
      'tests/renderer-kb-switch-332.test.tsx': 5,
      'tests/renderer-late-response-owner-311.test.tsx': 14,
      'tests/renderer-local-judgement-panel.test.tsx': 13,
      'tests/renderer-mcp-import-templates-mount.test.tsx': 2,
      'tests/renderer-mcp-none-mode-save.test.tsx': 4,
      // 2026-11-07（settle 假等待修复）9→11，**+2 全在 332③#3**，不是写多了：
      //   原 9 处断言前都只有 `settle()`（setTimeout 0）当屏障——React 提交走 `setImmediate`，
      //   全量多 worker 下 timer 先到就断言，反向对照那条会停在初值空态「还没有笔记」＝偶发假红。
      //   9 处全部改成"等正向前提真的落到 DOM"：①×2（notes.loadFail／甲笔记）、②（新建失败）、
      //   ③#1（自动保存失败）、③#2（已经不在了）、④×2（删除失败／成功退编辑态的「选择左侧笔记…」）、
      //   ⑤（置顶失败）这 8 处用 `findByText`（RTL 自带等待，本分类器只认 `await waitFor`，故不计）；
      //   只剩 ③#3 必须写两颗门：那一发成功回包在屏上**没有新文案**（与旧副本同形），单点文本「上次保存」
      //   在选中笔记那一刻就已存在、拿它当门会在到货前就放行＝假通过；唯一可观测的是「保存中…」的
      //   **在场→退场**过渡 ⇒ 第一颗等它上屏（在飞那一帧）、第二颗等它退场（到货），两段缺一不可。
      'tests/renderer-notes-332.test.tsx': 11,
      'tests/renderer-ollama-panel-liveness-380.test.tsx': 8,
      'tests/renderer-p0-2a-copy-415.test.tsx': 9,
      'tests/renderer-pip-source-confirm.test.tsx': 1,
      'tests/renderer-provider-http-confirm.test.tsx': 3,
      'tests/renderer-provider-settings.test.tsx': 7,
      'tests/renderer-reminder-busy-332.test.tsx': 7,
      'tests/renderer-reminders-modal-reschedule.test.tsx': 3,
      'tests/renderer-reminders-modal-rule.test.tsx': 1,
      'tests/renderer-rotate-undecryptable-faces-385.test.tsx': 8,
      'tests/renderer-settings-webdav-undecryptable-381.test.tsx': 12,
      'tests/renderer-sidebar-badge-250.test.tsx': 1,
      'tests/renderer-sidebar-nav.test.tsx': 2,
      'tests/renderer-skill-resident-236.test.tsx': 1,
      'tests/renderer-steward-ollama-liveness-380.test.tsx': 4,
      // 既有漂移补登记（工具面治理批发现）：`9a1082a`（备份验证三态并入故障诊断卡）新增 3 颗门未抬上限，
      // 现数 11；新增的三颗都按「存在」读屏（PROBE-PICK／verifyBackupNow／VERIFY_IO toast）。
      // 上限＝现数 11，不留余量。
      'tests/renderer-steward-read-255.test.tsx': 11,
      'tests/renderer-steward-vacuum-377.test.tsx': 8,
      'tests/renderer-task-last-ok-face-395.test.tsx': 1,
      'tests/renderer-terminal-truncated-hint.test.tsx': 2,
      'tests/renderer-unlock-rate-limit.test.tsx': 7,
      'tests/renderer-websearch-b3.test.tsx': 7,
      'tests/renderer-websearch-searxng-407.test.tsx': 17,
      'tests/renderer-wizard-328.test.tsx': 6,
      'tests/renderer-wizard-412.test.tsx': 1,
      'tests/sandbox-meta-envelope-326.test.tsx': 13,
      'tests/search-late-response-353.test.tsx': 8,
      'tests/settings-enc-copy-344.test.tsx': 1,
      'tests/settings-license-copy-346.test.tsx': 3,
      'tests/skill-budget-ui-418.test.tsx': 1,
      'tests/stale-read-notice-345.test.tsx': 14,
      'tests/stale-read-notice-347.test.tsx': 25,
      'tests/terminal-frame-epoch-320.test.tsx': 4,
      // 结构化契约层（新增）：主进程用例，5 颗门全是 `vi.waitFor` 等桩调用计数（`H.calls`／`H.renamed`），
      // 门后不读任何屏 ⇒ 与「门等 A、断言读 B」不同族。上限＝现数 5，不留余量。
      'tests/title-gen-structured.test.ts': 5,
      // V4-Iter-467：新增「高成本只展示」用例——挂载后等空态、切注册表后等 web_search 到货，
      // 两颗都按存在读屏；上限 7→9，上限＝现数，不留余量。
      'tests/tool-policy-screen-417.test.tsx': 9,
      'tests/update-panel-restart-312.test.tsx': 3,
      // 记忆来源面板（既有缺口，本次补登记）：列表与「来自会话」两发读库都在挂载后落地。
      // 上限＝现数 4，不留余量。
      'tests/user-memory-panel-provenance.test.tsx': 4
    }
    const sum = Object.values(PER_FILE_AWAITS).reduce((a, b) => a + b, 0)
    expect(sum, '逐文件合计必须等于总量（两套读法同源）').toBe(ALL.awaits)
    const unregistered = Object.keys(PER_FILE_AWAITS).filter((f) => !Object.prototype.hasOwnProperty.call(AWAIT_CAP, f)).sort()
    expect(unregistered.map((f) => `  + ${f}：${PER_FILE_AWAITS[f]} 颗`).join('\n'),
      `新文件用了 await waitFor 却没登记上限：\n${unregistered.map((f) => '  + ' + f).join('\n')}`).toBe('')
    const over = Object.keys(AWAIT_CAP)
      .filter((f) => (PER_FILE_AWAITS[f] ?? 0) > (AWAIT_CAP[f] ?? 0))
      .sort()
    expect(over.map((f) => `  ${f}：现 ${PER_FILE_AWAITS[f] ?? 0} > 上限 ${AWAIT_CAP[f] ?? 0}`).join('\n'),
      'waitFor 超过本文件上限：加了就抬上限并写理由').toBe('')
    // 六桶**互斥且守恒**：分类器不认的门形状会让守恒式先红
    expect(ALL.domGates + ALL.hookGates + ALL.transitionGates + ALL.silent + ALL.positive.length + ALL.absenceOnly.length,
      '六桶必须守恒：对不上＝出现了分类器不认的门形状').toBe(ALL.awaits)
  })

  it('正向候选＝0：门不等屏、紧随其后却是"要求屏上存在"的断言，一处都不许留', () => {
    expect(ALL.positive.map(where), `会假红的形状：\n${ALL.positive.map(detail).join('\n')}`).toEqual([])
  })

  it('只会假绿那一档（要求「不存在」）＝21 颗逐条判过的名单，逐字钉死：漂了要人工过目并补判语', () => {
    // §365 判语（分组，位置按现数名单）：
    //   ①「在飞那一帧」本身就是判据对象——负向句读的是"发出之后、落地之前"，折进门里反而把判据废掉：
    //     load-fail-read-retry-350／352／354（"还在加载那一支既没有那句也没有那颗键"）、
    //     renderer-agent-sub-session-refresh-245（挂载那次读到的是空表）、renderer-file-open-332（关窗那一瞬）、
    //     stale-read-notice-347（切 tab 后在飞那一帧）、capability-online-seq-322（两发都在飞）
    //   ②弹与不弹由**同一次 handler** 决定（发通道与 setState 同批落地）⇒ 计数门放行时那一帧已定：
    //     renderer-channel-b3 三颗、renderer-websearch-b3、renderer-provider-http-confirm 两颗、
    //     renderer-provider-settings、renderer-mcp-none-mode-save、renderer-wizard-328
    //   ③头顶已有到货锚（同块更早把该屏断成存在）⇒ 负向句读的是到货后的帧：backup-cloud-time-327
    //   ④门等的"空态消失"本身就是到货转换（到货前空态必在）⇒ 有牙：renderer-image-read-256
    //   ⑤门只等「配置那一发发出」，紧随的负向句读的是判定结果（quick／auto 不亮）：配置 promise 未必已落地
    //     ⇒ 只会假绿、不会假红，三档判定由 chat-deep-search-running-461 的纯函数单测兜底
    //   另一档「错画要等落地」（renderer-data-health-perf 两颗、renderer-kb-doc-actions-331 导入那颗、
    //   renderer-kb-eval-panel 取消那颗、update-panel-restart-312 成功那颗）本批已改＝负向句一律挪到落定之后，
    //   故不在名单里；ipc-composer-list-read-268 那颗更是方向搞反（撤横幅要等落地⇒它其实会假红），已折进门里。
    //   为什么这一档不再另立机器判据：「门放行时那句『不在场』成没成真」取决于**产品那边什么时候画**（同步 handler
    //   还是响应落地），源码里看不出来——同一种形状（计数门＋先前上过屏＋现在要求不在）在 268 是会假红、在 347
    //   是设计内的在飞帧。⇒ 只能逐条判＋把名单钉死，别再试着用 subject 交集自动化（本批试过，见台账 §365）。
    const VERDICTS = [
      'tests/approval-audit-panel-p0-2c-3.test.tsx:237 -> :238', // §436 新入名单（本批导出测试）：门等「正在导出」消失（那一发已落地），紧随断言成功/失败提示都不在 ⇒ 读的是落地后的帧，有牙；没进「等退场」桶是因为门前的 fireEvent 不读屏（retractOf 只看同一块里的 expect）。
      'tests/backup-cloud-time-327.test.tsx:73 -> :75',
      'tests/load-fail-read-retry-350.test.tsx:97 -> :99',
      'tests/load-fail-read-retry-352.test.tsx:90 -> :91',
      'tests/load-fail-read-retry-354.test.tsx:91 -> :92',
      'tests/renderer-channel-b3.test.tsx:109 -> :110',
      'tests/renderer-channel-b3.test.tsx:117 -> :119',
      'tests/renderer-channel-b3.test.tsx:127 -> :128',
      'tests/renderer-file-open-332.test.tsx:107 -> :109',
      'tests/renderer-image-read-256.test.tsx:84 -> :85',
      // v58（删 mcp_servers.enabled）：该用例记录夹具少了一行 `enabled`，整块下移，故门与断言各上移一行（判语本身不变）。
      'tests/renderer-mcp-none-mode-save.test.tsx:58 -> :59',
      'tests/renderer-provider-http-confirm.test.tsx:58 -> :59',
      'tests/renderer-provider-http-confirm.test.tsx:64 -> :65',
      'tests/renderer-provider-settings.test.tsx:249 -> :250',
      'tests/renderer-websearch-b3.test.tsx:89 -> :90', // §404 现量＋10：补搜索深度三档（档位选择与行内说明）插在上方，形状与判语一字未动
      'tests/renderer-wizard-328.test.tsx:211 -> :212',
      'tests/capability-visibility-428.test.tsx:103 -> :104', // §429 迁移（原 §436 判语沿用）：门等 `reads === 1`（失败那一发已发出、渲染已重跑），紧随断言网格没长出假 0；门与断言读同一屏、失败落屏与计数条件同批 ⇒ 只会漏报，不会假红。
      'tests/chat-deep-search-running-461.test.tsx:191 -> :192', // §461 深搜提示：门等 getWebSearchConfig 那一发发出，紧随断言「quick 档屏上没有深搜提示」；门放行时配置 promise 未必已落地 ⇒ 只会假绿，判定本身由 judgeDeepSearchRunning 的三档单测兜底。
      'tests/chat-deep-search-running-461.test.tsx:198 -> :199', // §461 同上：auto 档末步没带 deepSearch，断言提示不在场。
      'tests/stale-read-notice-347.test.tsx:159 -> :160',
      // 补登记（工具面治理批发现）：门等 `listConversations` 第二发真的发出（调用计数），
      // 紧随却断言「来自会话」不在场；会话读不到时产品根本不画指向 ⇒ 门放行时即便响应未落地
      // 只会漏报（假绿），不会假红。
      'tests/user-memory-panel-provenance.test.tsx:69 -> :70'
    ]
    // 比对用整串而非数组：数组的 diff 只印第一颗漂的，剩下几颗得跑好几趟才看得见（本批就撞过）
    const now = ALL.absenceOnly.map(where).sort()
    const pinned = [...VERDICTS].sort()
    const gone = pinned.filter((x) => !now.includes(x))
    const fresh = now.filter((x) => !pinned.includes(x))
    expect(now.join('\n'),
      `名单漂了（现数 ${now.length}／钉着 ${pinned.length}）\n` +
      `  判语作废、要重写或改位置：\n${gone.map((x) => '   - ' + x).join('\n')}\n` +
      `  新冒出来、要补判语：\n${fresh.map((x) => '   + ' + x).join('\n')}`).toBe(pinned.join('\n'))
  })

  it('漏杀对照：§362／§363／§353 三种改前形状喂进同一个分类器，逐条报得出（"0"不是瞎的）', () => {
    const LABELS = ['§362 计数门', '§363 空门', '§353 派发门'] as const
    // ①门等调用次数（根本不读屏）
    const countGate = scanSource('fx-count-gate.tsx', `
      it('t', async () => {
        await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
        expect(historyBtn().textContent).toBe('历史')
      })`)
    // ②门只断「没有 alert」，此前没有任何一句把它断上屏 ⇒ t=0 就为真＝没牙
    const emptyGate = scanSource('fx-empty-gate.tsx', `
      const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
      it('t', async () => {
        await waitFor(() => expect(alerts()).toEqual([]))
        expect(screen.getByText('好了')).toBeTruthy()
      })`)
    // ③门等本地派发计数（顺带钉中文标识符的边界）
    const dispatchGate = scanSource('fx-dispatch-gate.tsx', `
      it('t', async () => {
        await waitFor(() => expect(dispatches('甲乙')).toBe(1))
        expect(screen.getByText('搜索中')).toBeTruthy()
      })`)
    const three = [countGate, emptyGate, dispatchGate]
    three.forEach((one, i) => {
      expect(one.positive.length, `${LABELS[i]} 没被分类器报出来（awaits ${one.awaits}、读屏门 ${one.domGates}、转换门 ${one.transitionGates}）`).toBe(1)
      expect(one.absenceOnly.length, `${LABELS[i]} 走错了桶`).toBe(0)
    })

    // 反向对照①：门按「存在」读屏 ⇒ 放行
    const domGate = scanSource('fx-dom-gate.tsx', `
      it('t', async () => {
        await waitFor(() => expect(screen.getByText('加载中')).toBeTruthy())
        expect(screen.getByText('好了')).toBeTruthy()
      })`)
    expect(domGate.positive).toEqual([])
    expect(domGate.domGates).toBe(1)
    // 反向对照②：断言用 findBy（自己会等）⇒ 放行
    const findByGate = scanSource('fx-findby.tsx', `
      it('t', async () => {
        await waitFor(() => expect(calls.x).toBe(1))
        expect(await screen.findByText('好了')).toBeTruthy()
      })`)
    expect(findByGate.positive).toEqual([])
    // 反向对照③：紧随的断言要求不存在 ⇒ 只进假绿那一桶
    const absenceGate = scanSource('fx-absence.tsx', `
      it('t', async () => {
        await waitFor(() => expect(calls.x).toBe(1))
        expect(screen.queryByText('坏了')).toBeNull()
      })`)
    expect(absenceGate.positive).toEqual([])
    expect(absenceGate.absenceOnly.length).toBe(1)
    // 反向对照④：中间又等了一次 ⇒ 断言读的是那一次之后的屏 ⇒ 放行
    const twoGates = scanSource('fx-two.tsx', `
      it('t', async () => {
        await waitFor(() => expect(calls.x).toBe(1))
        await waitFor(() => expect(screen.getByText('好了')).toBeTruthy())
      })`)
    expect(twoGates.positive).toEqual([])
    // 反向对照⑤：先上屏、点重试、再等它退场（§345~§355 那一族的正规写法）⇒ 转换门，不许当候选
    const retractGate = scanSource('fx-retract.tsx', `
      const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
      it('t', async () => {
        await waitFor(() => expect(alerts()).toEqual([FAILED('读不到')]), MOUNT_BUDGET)
        fireEvent.click(screen.getByTestId('x-retry'))
        await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
        expect(bodyText()).toContain('PROBE-数据')
      })`)
    expect(retractGate.positive, `转换门被误判成候选：\n${retractGate.positive.map(detail).join('\n')}`).toEqual([])
    expect(retractGate.transitionGates, '这一发要落在「等退场」那一桶，否则现数 75 是虚的').toBe(1)
    // 反向对照⑥：`not.toBeNull()` 是双否定＝要求存在 ⇒ 算读屏门，不算候选
    const doubleNegative = scanSource('fx-double-neg.tsx', `
      it('t', async () => {
        await waitFor(() => expect(screen.queryByText('80%')).not.toBeNull())
        expect(screen.getByText('好了')).toBeTruthy()
      })`)
    expect(doubleNegative.domGates, 'not.toBeNull() ＝ 要求存在 ⇒ 门在读屏').toBe(1)
    expect(doubleNegative.positive).toEqual([])
    // 反向对照⑦：helper 传递闭包（`shown()`→`sel()`→`screen`）⇒ 门读的是屏，不算候选
    const chainedHelper = scanSource('fx-chain-helper.tsx', `
      const sel = (): HTMLSelectElement => screen.getByTestId('auto-lock') as HTMLSelectElement
      const shown = (): string => sel().options[sel().selectedIndex]?.text ?? '(没有选中项)'
      it('t', async () => {
        await waitFor(() => expect(shown()).toBe('1 分钟'))
        expect(screen.queryByText('已保存')).not.toBeNull()
      })`)
    expect(chainedHelper.positive, `闭包 helper 没认出来：\n${chainedHelper.positive.map(detail).join('\n')}`).toEqual([])
    expect(chainedHelper.domGates).toBe(1)
    // §365①：计数门＋紧随"要求不存在"⇒ 必须落进假绿那一桶（这一档的名单有牙的前提＝它真能被数出来）
    const countThenAbsence = scanSource('fx-count-absence.tsx', `
      const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
      it('t', async () => {
        await waitFor(() => expect(callsOf('listSkills')).toBe(2))
        expect(alerts()).toEqual([])
      })`)
    expect(countThenAbsence.absenceOnly.length, '计数门后那句负向断言没被数进假绿桶＝名单是瞎的').toBe(1)
    // §365②：修法（负向句挪到"落定之后"）要真的改变形状，而不是把判据藏起来——两句都还在，只是位置在落定后
    const afterSettle = scanSource('fx-settled.tsx', `
      const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
      it('t', async () => {
        await waitFor(() => expect(callsOf('listSkills')).toBe(2))
        await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
        expect(alerts()).toEqual([])
        expect(callsOf('listSkills')).toBe(2)
      })`)
    expect(afterSettle.positive).toEqual([])
    expect(afterSettle.absenceOnly.length, '中间多一次落定 ⇒ 这一发不再算候选（修法生效的机器证据）').toBe(0)
    expect(afterSettle.silent, '它要落在"门后无紧随读屏断言"那一格').toBe(1)

    // §400 漏杀对照（第二份屏）：真 hook 夹具的改前形状——门等**调用计数**、门后同步读 `result.current`。
    // 这一颗本枚在真源码里抓到了两颗（`renderer-agent-zero-call-notice` 那两处），喂进分类器必须照样报出来，
    // 否则「hookGates 81」只是把门换了一格、不是这一半真有牙。
    const hookCountGate = scanSource('fx-hook-count-gate.tsx', `
      it('t', async () => {
        await waitFor(() => expect(callsOf('getAgentTextProtocol')).toBe(1))
        expect(result.current.textProtocolForced).toBe(true)
      })`)
    expect(hookCountGate.positive.length, '门等调用计数、紧随同步读 result.current ⇒ 这一族没被第二类屏认出来＝hook 半是瞎的').toBe(1)
    expect(hookCountGate.hookGates, '它不该被算成"门在读屏"').toBe(0)
    expect(hookCountGate.silent, '也不该再留在"无紧随读屏"那一格').toBe(0)
    // §400 反向对照①：门自己按「存在」读 `result.current`（§396／§398／②a 那三份 hook 夹具的正规写法）⇒ 放行
    const hookPresenceGate = scanSource('fx-hook-gate.tsx', `
      it('t', async () => {
        await waitFor(() => expect(result.current.conversationId).toBe('c1'))
        expect(result.current.runStats).toBeNull()
      })`)
    expect(hookPresenceGate.positive).toEqual([])
    expect(hookPresenceGate.hookGates, '按存在读 hook 屏 ⇒ 要落在新格，不能仍算"门不等屏"').toBe(1)
    // §400 反向对照②：更早已把那个值断成存在、门等它收回（在飞那一帧的收旧值写法）⇒ 转换门，不算候选
    const hookRetractGate = scanSource('fx-hook-retract.tsx', `
      it('t', async () => {
        expect(result.current.runStatsUnread).not.toBeNull()
        await waitFor(() => expect(result.current.runStatsUnread).toBeNull())
        expect(result.current.runStats?.stepCount).toBe(2)
      })`)
    expect(hookRetractGate.positive).toEqual([])
    expect(hookRetractGate.transitionGates, '这句"收回"是要等的那件事 ⇒ 落「等退场」').toBe(1)
    // §400 反向对照③：门后那句读 hook 屏但要求「不存在」⇒ 只进假绿那一桶（名单里有牙的前提＝它数得出来）
    const hookThenAbsence = scanSource('fx-hook-absence.tsx', `
      it('t', async () => {
        await waitFor(() => expect(callsOf('getLatestRunStats')).toBe(1))
        expect(result.current.runStatsUnread).toBeNull()
      })`)
    expect(hookThenAbsence.positive).toEqual([])
    expect(hookThenAbsence.absenceOnly.length).toBe(1)
    // §401 漏杀对照①（第二半·读进本地量）：计数门 → 把屏读进本地量 → 只断那颗本地量"在场"。
    // 旧版看不见它（那句 expect 里没有任何读屏字面量）＝整发落「无紧随读屏」，而它读的还是落地之前那一帧。
    const localReadGate = scanSource('fx-local-read.tsx', `
      it('t', async () => {
        await waitFor(() => expect(callsOf('listModels')).toBe(1))
        const go = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('生成'))
        expect(go, '生成键在场').toBeTruthy()
      })`)
    expect(localReadGate.positive.length, '门后把屏读进本地量、紧随只断那颗本地量＝这一族没被认出来＝本地量那半是瞎的').toBe(1)
    expect(localReadGate.silent, '它不该再留在"无紧随读屏"那一格').toBe(0)
    // §401 反向对照①：门后把屏读进本地量、紧随断的是"不在场"⇒ 只进假绿那一桶
    const localAbsenceGate = scanSource('fx-local-absence.tsx', `
      const alerts = (): Element[] => Array.from(document.querySelectorAll('[role="alert"]'))
      it('t', async () => {
        await waitFor(() => expect(callsOf('listModels')).toBe(1))
        const rows = alerts()
        expect(rows).toEqual([])
      })`)
    expect(localAbsenceGate.positive).toEqual([])
    expect(localAbsenceGate.absenceOnly.length, '这句"不在场"读的是本地量 ⇒ 要进假绿名单（名单才有牙）').toBe(1)
    // §401 反向对照②：门自己按存在读了屏（后面那颗本地量只是同一帧的复用）⇒ 放行，不许算候选
    const gateReadsFirst = scanSource('fx-gate-reads-first.tsx', `
      it('t', async () => {
        await waitFor(() => expect(screen.getByText('生成')).toBeTruthy())
        const go = screen.getByTestId('image-generate')
        expect(go).toBeTruthy()
      })`)
    expect(gateReadsFirst.positive, '门在读屏，本地量只是复用 ⇒ 报出来就是假阳：' + gateReadsFirst.positive.map(detail).join(' / ')).toEqual([])
    expect(gateReadsFirst.domGates).toBe(1)
    // §401 漏杀对照②（第一半·别名）：`const { result: r } = renderHook(...)` 之后计数门＋只断 `r.current.x` 在场
    const aliasHookGate = scanSource('fx-alias-hook.tsx', `
      const { result: r } = renderHook(() => useAgentChat(P, A))
      it('t', async () => {
        await waitFor(() => expect(callsOf('getAgentTextProtocol')).toBe(1))
        expect(r.current.textProtocolForced).toBe(true)
      })`)
    expect(aliasHookGate.positive.length, 'result 改名解构 ⇒ 分类器要认得这种写法（现查全仓 0 处，钉住的是将来）').toBe(1)
    // §401 反向对照③：别名门自己按存在读屏 ⇒ 落 hookGates，不算候选
    const aliasPresenceGate = scanSource('fx-alias-presence.tsx', `
      const st = result.current
      it('t', async () => {
        await waitFor(() => expect(st.conversationId).toBe('c1'))
        expect(st.runStats).toBeNull()
      })`)
    expect(aliasPresenceGate.positive).toEqual([])
    expect(aliasPresenceGate.hookGates, '整份状态取进本地量（const st = result.current）之后 st.x＝读 hook 屏').toBe(1)
    // §401 反向对照④（**有意放行的边界**，如实记）：屏读发生在第二次 await **之前**，
    // 门保护不到它⇒本面不报（收它要按语句顺序重排"屏读落在哪一帧"＝成本另计，本枚不收）
    const localThenSecondAwait = scanSource('fx-local-two-await.tsx', `
      it('t', async () => {
        await waitFor(() => expect(callsOf('listModels')).toBe(1))
        const go = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '生成')
        await waitFor(() => expect(callsOf('generateImage')).toBe(1))
        expect(go, '那颗键在场').toBeTruthy()
      })`)
    expect(localThenSecondAwait.positive).toEqual([])
  })
})
