// §364 闸门：jsdom 用例里「门等的是别的东西、断言却同步读屏」这一族（会假红的那一档）
//
// 来路＝§361 全量第一趟在 992s 负载窗里红两条 → §362 用**延迟到货的桩**确定性复现（不是重造负载）→
// §363 收第三处 → 本批横扫全仓把这一面钉住。判据口径（三条都要满足才算候选）：
//   ① 语句是 `await waitFor(cb)`；
//   ② cb **没把屏等到变**——判据不是「门体里有没有读屏的字面量」，而是**逐条看门里 expect 的极性**：
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
  /** 门按「存在」读了屏 ⇒ 放行 */
  domGates: number
  /** 门只断不存在、但同块更早已把那样东西断上屏 ⇒ 等它退场，放行 */
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
    const hit = (n: ts.Node): boolean => expectsIn(n).some((x) => readsDom(x) && !isAbsence(x))
    if (hit(node)) return true
    const txt = node.getText(sf)
    return decls.some((d) => hit(d.node) && callRe(d.name).test(txt))
  }

  const out: Scan = { positive: [], absenceOnly: [], domGates: 0, transitionGates: 0, silent: 0, awaits: 0 }
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
        const block = blockOf(node)
        if (readsPresent) {
          out.domGates += 1
        } else if (absenceReads.length > 0 && retractOf(block, node)) {
          out.transitionGates += 1
        } else if (block) {
          let pushed = false
          const stmts = block.statements
          const at = stmts.indexOf(node)
          for (let i = at + 1; i < Math.min(stmts.length, at + 6); i++) {
            const s = stmts[i]
            const prev = stmts[i - 1]
            if (!s || !prev) break
            if (i > at + 1 && /await\s/.test(prev.getText(sf))) break
            const txt = s.getText(sf)
            if (!/^expect\(/.test(txt.trim())) continue
            if (!readsDom(txt)) continue
            if (/findBy/.test(txt)) break // findBy 自己会等
            const cand: Cand = {
              file: fileName, gateLine: lineOf(node), domLine: lineOf(s),
              gate: (src[lineOf(node) - 1] ?? '').trim().slice(0, 90),
              dom: txt.replace(/\s+/g, ' ').slice(0, 90)
            }
            if (isAbsence(txt)) out.absenceOnly.push(cand)
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

function scanAll(): Scan {
  const merged: Scan = { positive: [], absenceOnly: [], domGates: 0, transitionGates: 0, silent: 0, awaits: 0 }
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
    merged.positive.push(...one.positive)
    merged.absenceOnly.push(...one.absenceOnly)
    merged.domGates += one.domGates
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
  it('读法自证：全仓在等的 waitFor 有多少、各桶多少（分类器坏了这里先红）', () => {
    // 五桶**互斥且守恒**（一颗门只进一格）。现数 2026-10-30（§369 加了两份新用例之后）＝awaits 983／按存在读屏 530／
    // 等退场 75／门后没有读屏断言 360／会假红 0／只会假绿 18。逐颗钉死＝新增任何一格都要人工过目。
    //   §369 这 6 颗的来路（不是搬运，是净新增）：recovery-carry-notice-369 里 6 发 waitFor＝
    //   5 颗门按"那行字上屏"读（落进 按存在读屏 525→530）＋1 颗门等的是 notices.length（非 DOM 信号）、
    //   门后先 settle 再读负向句（落进 门后没有读屏断言 359→360）——后者正是本闸门第一趟把那颗门抓出来之后
    //   按 §365 的"先落定再读负向句"改的形状；改之前它是 会假红 那一档的第一手样本。
    //   75/359 这一格在 268 那颗改造后搬运过一颗：那句「点那一格＝重发这一发」的计数门后面紧跟的不再是
    //   同步读屏断言，而是另起一颗把到货见证写在里面的门⇒它从「等退场」落到「门后没有读屏断言」。
    expect(ALL.awaits, `现数 ${ALL.awaits} 个 await waitFor`).toBe(983)
    expect([ALL.domGates, ALL.transitionGates, ALL.silent, ALL.positive.length, ALL.absenceOnly.length].join('/'),
      `现数 按存在/等退场/无紧随断言/会假红/只会假绿 ＝ ${ALL.domGates}/${ALL.transitionGates}/${ALL.silent}/${ALL.positive.length}/${ALL.absenceOnly.length}`).toBe('530/75/360/0/18')
    expect(ALL.domGates + ALL.transitionGates + ALL.silent + ALL.positive.length + ALL.absenceOnly.length,
      '五桶必须守恒：对不上＝出现了分类器不认的门形状').toBe(ALL.awaits)
  })

  it('正向候选＝0：门不等屏、紧随其后却是"要求屏上存在"的断言，一处都不许留', () => {
    expect(ALL.positive.map(where), `会假红的形状：\n${ALL.positive.map(detail).join('\n')}`).toEqual([])
  })

  it('只会假绿那一档（要求「不存在」）＝18 颗逐条判过的名单，逐字钉死：漂了要人工过目并补判语', () => {
    // §365 判语（分组，位置按现数名单）：
    //   ①「在飞那一帧」本身就是判据对象——负向句读的是"发出之后、落地之前"，折进门里反而把判据废掉：
    //     load-fail-read-retry-350／352／354（"还在加载那一支既没有那句也没有那颗键"）、
    //     renderer-agent-sub-session-refresh-245（挂载那次读到的是空表）、renderer-file-open-332（关窗那一瞬）、
    //     stale-read-notice-347（切 tab 后在飞那一帧）、skill-market-fetch-debounce-322（两发都在飞）
    //   ②弹与不弹由**同一次 handler** 决定（发通道与 setState 同批落地）⇒ 计数门放行时那一帧已定：
    //     renderer-channel-b3 三颗、renderer-websearch-b3、renderer-provider-http-confirm 两颗、
    //     renderer-provider-settings、renderer-mcp-none-mode-save、renderer-wizard-328
    //   ③头顶已有到货锚（同块更早把该屏断成存在）⇒ 负向句读的是到货后的帧：backup-cloud-time-327
    //   ④门等的"空态消失"本身就是到货转换（到货前空态必在）⇒ 有牙：renderer-image-read-256
    //   另一档「错画要等落地」（renderer-data-health-perf 两颗、renderer-kb-doc-actions-331 导入那颗、
    //   renderer-kb-eval-panel 取消那颗、update-panel-restart-312 成功那颗）本批已改＝负向句一律挪到落定之后，
    //   故不在名单里；ipc-composer-list-read-268 那颗更是方向搞反（撤横幅要等落地⇒它其实会假红），已折进门里。
    //   为什么这一档不再另立机器判据：「门放行时那句『不在场』成没成真」取决于**产品那边什么时候画**（同步 handler
    //   还是响应落地），源码里看不出来——同一种形状（计数门＋先前上过屏＋现在要求不在）在 268 是会假红、在 347
    //   是设计内的在飞帧。⇒ 只能逐条判＋把名单钉死，别再试着用 subject 交集自动化（本批试过，见台账 §365）。
    const VERDICTS = [
      'tests/backup-cloud-time-327.test.tsx:73 -> :75',
      'tests/load-fail-read-retry-350.test.tsx:97 -> :99',
      'tests/load-fail-read-retry-352.test.tsx:90 -> :91',
      'tests/load-fail-read-retry-354.test.tsx:91 -> :92',
      'tests/renderer-agent-sub-session-refresh-245.test.tsx:151 -> :152',
      'tests/renderer-channel-b3.test.tsx:109 -> :110',
      'tests/renderer-channel-b3.test.tsx:117 -> :119',
      'tests/renderer-channel-b3.test.tsx:127 -> :128',
      'tests/renderer-file-open-332.test.tsx:107 -> :109',
      'tests/renderer-image-read-256.test.tsx:84 -> :85',
      'tests/renderer-mcp-none-mode-save.test.tsx:59 -> :60',
      'tests/renderer-provider-http-confirm.test.tsx:58 -> :59',
      'tests/renderer-provider-http-confirm.test.tsx:64 -> :65',
      'tests/renderer-provider-settings.test.tsx:249 -> :250',
      'tests/renderer-websearch-b3.test.tsx:81 -> :82',
      'tests/renderer-wizard-328.test.tsx:211 -> :212',
      'tests/skill-market-fetch-debounce-322.test.tsx:159 -> :160',
      'tests/stale-read-notice-347.test.tsx:159 -> :160'
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
  })
})
