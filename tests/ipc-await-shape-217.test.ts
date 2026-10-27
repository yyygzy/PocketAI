// V4-Iter-217：IPC 返回值面的形状闸门（全渲染层，**没有豁免名单**）。
//
// 背景：`safeHandle` 把主进程抛错与 zod 入参校验失败都转成 **resolve 的 `{ok:false,error}`**（§196）。
// 于是「只挂 .catch」等于没接失败：轻则静默，重则把失败对象当数据写进 state（§214 那两条 TypeError 白屏）。
// 214／215／216 按档逐点修完之后，这一批把"以后别静默"从人工对账换成 CI：
// **每个 `await window.pocketai.X(...)`（X 对应的通道走 safeHandle）都必须要么判返回值、要么被自己的 try…catch 包着。**
//
// 为什么用 TypeScript 的 AST 而不是正则扫行：
//   ① 判据可能写在包围块的任意深度（函数体里），正则的"区域"必须靠括号配对，而 JS 的括号在字符串／模板／JSX 里都会出现；
//   ② §216 实测过一次：按 `\n` 切行的扫描器会被**孤立 CR 行尾**骗（运行期没事、切行把守卫并进上一行的注释里）；
//   ③ 判据可以被搬进同文件的助手（§215 的 `failOp`、§217 回读时遇到的 `handleRestoreResult`）——
//      那要求"变量→形参→助手本体"这条链能跟着走，AST 才走得动。
//
// 口径的三条刻意选择（都不是疏忽，写清楚免得后来人当成漏洞）：
//   · **try…catch 算合格**，哪怕 catch 是空的：safeHandle 的失败根本不会被 catch 接到，"包着"只是"这一发既不崩也不谎报"
//     的既有形状（§213 数的 63 处"只有 catch"就是这一档，把它们全逼成判据是几十个点的产品改动，不属于"闸门"这批）。
//     闸门单独把「同函数别处的 catch」挑出来算**不合格**——那连包着都算不上，是对讲机的错觉（本批开局有 3 处，已清零）。
//   · 但 catch **护不住"把结果当数据读"**（§219 加的一档）：`setX(r.items)`、`build(r)`、`{ ...p, models }`、`return r`
//     这些读法在失败时读到的是 `{ok:false,error}` 的字段，界面照样谎报，所以判据没读过失败面的点一旦被当数据用就红，
//     不管它在不在 try 里。仓库里这一档开局 17 处，已在 §219 全部清完。
//   · 读 `r.data`／`r.list` 不算判据：那正是"把失败当数据"。判据只认失败面字段（`ok`/`error`/`code`/`canceled`/`locked`）
//     与仓库里那几个判据函数。
//
// §223 在这两面上又各收了一档，并修了这根闸门**自己的两处假绿**（方向都是"把没判的点读成判了"）：
//   · await 面新档 `value-use`：结果没绑变量却被当值用（`setX(await f())`、`(await f()).mode`、
//     `if (!(await f()))`、`convs ?? (await f())`）——以前绑定失败 ⇒ bound 为 null ⇒ 只看"有没有包 try…catch"，
//     于是这一族全绿；可 catch 接不到 resolve 的失败，`.map`／`.length` 当场崩，`!` 那一形更把真值的失败对象读成"开启"。
//   · 链根统一成 `chainRootMethod`：`await X().catch(h)`（以前整条看不见）与 `const p = X(); p.then(cb)`
//     （§221 明文"不追"，但仓库里有两处真实实例）现在都在口径内。
//   · 唯一的假绿根因：真值判那条式子 `if\s*\(\s*!?name` **不要求右括号** ⇒ `if (list.length === 0)` 被读成
//     "判了 list"。收紧成 `if (name)`／`if (!name)` 之后当场多逼出 8 个点（其中 6 个 data-ignored）。
//     另有一版曾加"字符串抹白"（怕日志标签里的通道名被当成判据），M223c 证明它**零可观测效果**
//     （`list` 咬不动 `'chat.listThings'`，后面紧跟大写不算词边界）⇒ 撤掉，不留没有证据的加固。
//   共 20 个点因此进入视野（15 个由两档新判据逼出、5 个由链根识别补上，其中 1 个本来就判对了），当场清完 19 个。
//   改后读数：await 面 **278 点**（判 232 ＋ 经同文件助手 3 ＋ 只包 catch 43 ＋ 当数据用 0 ＋ 当值用 0 ＋ 裸奔 0）、
//   `.then` 面 **123 点全部判过**，两面无豁免名单。
//
// §221 把同一条闸门扩到 **`.then(...)` 那条面**（`window.pocketai.X(...).then(cb)`，同样只认走 safeHandle 的通道）。
// 开局量到 121 个点，其中 92 个不合格（52 个 `.then(setX)`、35 个回调里把结果当数据读、5 个回调根本不接结果），
// 分 28 文件／55 通道，**没有一个落在"设计内 `ok:false`"的那 51 条通道上**（§212 数过的那批），
// 所以这一面可以放心用统一形状收，不会把业务分支吃成"空列表"。`.then` 面与 await 面有三处刻意的口径差，见 ④。
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** 注释替换成等长空白：偏移不变，`getText()` 里就不会藏着注释（§214／§216 两次都是注释把闸门喂绿的） */
function blankComments(src: string, rel: string): string {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ESNext, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out = src.split('')
  const fill = (a: number, b: number) => {
    for (let i = a; i < b && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
  }
  const visit = (node: ts.Node): void => {
    for (const c of [...(ts.getLeadingCommentRanges(src, node.pos) ?? []), ...(ts.getTrailingCommentRanges(src, node.end) ?? [])]) fill(c.pos, c.end)
    node.forEachChild(visit)
  }
  sf.statements.forEach(visit)
  return out.join('')
}

const walk = (node: ts.Node, fn: (n: ts.Node) => void): void => {
  fn(node)
  ts.forEachChild(node, (c) => walk(c, fn))
}
const filesIn = (dir: string): string[] => {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir.split(path.sep).join('/'), e.name)
    if (e.isDirectory()) out.push(...filesIn(rel))
    else if (/\.tsx?$/.test(e.name)) out.push(rel)
  }
  return out.sort()
}
const chanNameOf = (arg: ts.Expression | undefined): string | null =>
  !arg ? null : ts.isPropertyAccessExpression(arg) ? arg.name.text : ts.isStringLiteral(arg) ? arg.text : null

/** preload：`foo: (…) => ipcRenderer.invoke(IPC.CONST, …)` ⇒ 方法名 → 通道常量 */
export function preloadMethods(src: string): Map<string, string> {
  const ast = ts.createSourceFile('preload.ts', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const map = new Map<string, string>()
  walk(ast, (n) => {
    if (!ts.isPropertyAssignment(n) || !ts.isIdentifier(n.name)) return
    let chan: string | null = null
    const find = (node: ts.Node): void => {
      if (chan) return
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'invoke') {
        chan = chanNameOf(node.arguments[0])
      }
      node.forEachChild(find)
    }
    find(n.initializer)
    if (chan) map.set(n.name.text, chan)
  })
  return map
}

/** 主进程：哪些常量是 `safeHandle(IPC.CONST, …)` 注册的（`ipcMain.handle` 只有 safe-handle.ts 那一处） */
export function safeHandleChannels(sources: string[]): Set<string> {
  const set = new Set<string>()
  for (const src of sources) {
    const ast = ts.createSourceFile('h.ts', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    walk(ast, (n) => {
      if (!ts.isCallExpression(n)) return
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ''
      const c = chanNameOf(n.arguments[0])
      if (c && callee === 'safeHandle') set.add(c)
    })
  }
  return set
}

const JUDGE_FUNCS = ['hasIpcFailed', 'isIpcFail', 'ipcFailText', 'ipcFailureText', 'chatSendFailureText', 'reportIpcError', 'logIpcError', 'errText', 'failOp', 'failAction', 'unwrapIpc', 'toast.error', 'setNotice', 'setError', 'setErr']
const esc = (s: string): string => s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
const JUDGE_ALT = JUDGE_FUNCS.map(esc).join('|')
/**
 * 只认失败面字段；`x.data` 这种"当数据用"绝不算判过。
 * §223 收紧了真值判那一式：`if\s*\(\s*!?name` 不要求右括号 ⇒ `if (list.length === 0)` 会被读成"判了 list"，
 * 这是本闸门唯一一处**实测到的假绿**（收紧后当场多逼出 8 个点）。改成 `if (name)`／`if (!name)` 才算。
 */
const judgeFor = (name: string): RegExp =>
  new RegExp(
    [
      `(?:${JUDGE_ALT})\\s*\\([^)]{0,80}?\\b${esc(name)}\\b`,
      `\\b${esc(name)}\\.ok\\b`,
      `'ok'\\s+in\\s*${esc(name)}\\b`,
      `\\b${esc(name)}\\.(?:error|code|canceled|locked)\\b`,
      `if\\s*\\(\\s*!?${esc(name)}\\s*\\)`,
      `\\b${esc(name)}\\s*(&&|\\?\\?|===|!==)`,
    ].join('|'),
  )

const isFnNode = (n: ts.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

export type SiteKind = 'judged' | 'judged-via-helper' | 'try-catch' | 'data-ignored' | 'value-use' | 'naked'
export interface Site {
  rel: string
  line: number
  method: string
  chan: string
  bound: string | null
  kind: SiteKind
  via?: string
  dataUse?: string
  valueUse?: string
}

/** 一个文件里的 await 点分类（渲染层与内联桩共用这一份逻辑，桩才有资格说"扫描器有牙"） */
export function classifySource(rel: string, rawSrc: string, methods: Map<string, string>, safeChans: Set<string>): Site[] {
  const clean = blankComments(rawSrc, rel)
  const ast = ts.createSourceFile(rel, clean, ts.ScriptTarget.ESNext, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const parents = new Map<ts.Node, ts.Node>()
  const link = (n: ts.Node): void => {
    n.forEachChild((c) => {
      parents.set(c, n)
      link(c)
    })
  }
  link(ast)
  const ancestor = (n: ts.Node, pred: (p: ts.Node) => boolean): ts.Node | null => {
    let p = parents.get(n)
    while (p) {
      if (pred(p)) return p
      p = parents.get(p)
    }
    return null
  }
  const locals = new Map<string, { params: string[]; body: string }>()
  const register = (name: string, node: ts.Node): void => {
    const fn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ? node : null
    if (!fn) return
    locals.set(name, {
      params: fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '')),
      body: fn.body ? fn.body.getFullText(ast) : '',
    })
  }
  walk(ast, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) register(n.name.text, n)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFnNode(n.initializer)) register(n.name.text, n.initializer)
  })

  const out: Site[] = []
  walk(ast, (n) => {
    if (!ts.isAwaitExpression(n) || !ts.isCallExpression(n.expression)) return
    // §223：`await X().catch(h)` 这类尾链以前整条看不见（只认 `await window.pocketai.X()` 那一种形状）
    const method = chainRootMethod(n.expression)
    if (!method) return
    const chan = methods.get(method)
    if (!chan || !safeChans.has(chan)) return
    const fn = ancestor(n, isFnNode)
    const fnText = fn ? fn.getFullText(ast) : ''
    let bound: string | null = null
    let up: ts.Node = n
    while (up && up !== fn) {
      const d = parents.get(up)
      if (!d) break
      if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) { bound = d.name.text; break }
      if (ts.isBinaryExpression(d) && d.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(d.left)) { bound = d.left.text; break }
      if (ts.isExpressionStatement(d) || ts.isReturnStatement(d) || ts.isCallExpression(d) || ts.isPropertyAccessExpression(d)) break
      up = d
    }
    const judgedDirect = bound !== null && judgeFor(bound).test(fnText)
    let via: string | null = null
    if (bound !== null && !judgedDirect) {
      for (const mm of fnText.matchAll(/\b([A-Za-z0-9_]+)\(([^)]{0,120})\)/g)) {
        const loc = locals.get(mm[1]!)
        if (!loc) continue
        const idx = mm[2]!.split(',').findIndex((a) => a.trim() === bound || a.trim() === `!${bound}`)
        if (idx < 0) continue
        const pname = loc.params[idx]
        if (pname && judgeFor(pname).test(loc.body)) { via = mm[1]!; break }
      }
    }
    // §219 那一档：结果被当数据读（取字段／当实参／写进结构／被 return），却从没读过它的失败面
    // ⇒ 即使整条被 try…catch 包着也不算合格：catch 接不到 resolve 的失败，界面照样谎报。
    let dataUse: string | null = null
    if (bound !== null && !judgedDirect && !via && fn) {
      const scan = (node: ts.Node): void => {
        if (dataUse) return
        if (ts.isIdentifier(node) && node.text === bound) {
          const p = parents.get(node)
          if (p) {
            if (ts.isVariableDeclaration(p) && p.name === node) {
              // 声明自己不算"读"
            } else if (ts.isPropertyAccessExpression(p) && p.expression === node) dataUse = `${bound}.${p.name.text}`
            else if (ts.isCallExpression(p) && p.expression !== node) dataUse = `${bound} 作为实参`
            else if (ts.isShorthandPropertyAssignment(p) || ts.isSpreadElement(p) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)) dataUse = `${bound} 被写进结构`
            else if (ts.isBinaryExpression(p) && p.left !== node) dataUse = `${bound} 被交出去`
            else if (ts.isReturnStatement(p)) dataUse = `${bound} 被 return`
          }
        }
        node.forEachChild(scan)
      }
      scan(fn)
    }
    // §223 那一档：结果**没绑变量却被当值用**——`setX(await f())`、`(await f()).mode`、`if (!(await f()))`、
    // `a ?? (await f())`。这一族以前被 `try…catch` 一档放行（绑定失败 ⇒ bound 为 null ⇒ 只看包不包着），
    // 但 catch 接不到 resolve 的失败，界面照样把 `{ok:false}` 当数据读：`.map`／`.length` 当场崩，
    // 或者（`!` 那一形）因为失败对象是**真值**而走错分支。修法只有一种：先接住再判（§215 起仓库里统一的那个形状）。
    let valueUse: string | null = null
    if (bound === null) {
      let up2: ts.Node = n
      while (up2 && up2 !== fn) {
        const d = parents.get(up2)
        if (!d) break
        if (ts.isCallExpression(d)) {
          // `(await f())(x)` 是把结果当函数用；`hasIpcFailed(await f())` 这类判据函数算看见失败
          const calleeName = ts.isPropertyAccessExpression(d.expression) ? d.expression.name.text : ts.isIdentifier(d.expression) ? d.expression.text : ''
          if (d.expression !== up2 && !JUDGE_FUNCS.includes(calleeName)) valueUse = `${calleeName || '调用'}(… await …) 作为实参`
          break
        }
        if (ts.isPropertyAccessExpression(d) || ts.isElementAccessExpression(d)) {
          valueUse = ts.isPropertyAccessExpression(d) ? `取字段 .${d.name.text}` : '按下标取'
          break
        }
        if (ts.isReturnStatement(d)) { valueUse = '被 return'; break }
        if (ts.isBinaryExpression(d)) { valueUse = `参与运算（${d.operatorToken.getText(ast).trim()}）`; break }
        if (ts.isConditionalExpression(d) || ts.isTemplateExpression(d) || ts.isArrayLiteralExpression(d) || ts.isObjectLiteralExpression(d) || ts.isSpreadElement(d) || ts.isShorthandPropertyAssignment(d)) {
          valueUse = '被写进结构／三元'
          break
        }
        if (ts.isPrefixUnaryExpression(d) && d.operator === ts.SyntaxKind.ExclamationToken) { valueUse = '只按真值判（失败对象是真值）'; up2 = d; continue }
        if (ts.isIfStatement(d) || ts.isWhileStatement(d) || ts.isDoStatement(d)) { valueUse = '只按真值判（失败对象是真值）'; break }
        if (ts.isExpressionStatement(d) || ts.isVariableDeclaration(d)) break // 语句级 fire-and-forget／已在上面绑过
        up2 = d
      }
    }
    // ts.TryStatement 没有 block 属性（block 只是 children）⇒ 认"TryStatement 的 Block 子节点且不是 finallyBlock"
    const tryBlock = fn ? ancestor(n, (p) => ts.isBlock(p) && !!p.parent && ts.isTryStatement(p.parent) && p.parent.finallyBlock !== p) : null
    const caught = !!(tryBlock && tryBlock.parent && (tryBlock.parent as ts.TryStatement).catchClause)
    const line = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1
    const kind: SiteKind = judgedDirect
      ? 'judged'
      : via
        ? 'judged-via-helper'
        : dataUse
          ? 'data-ignored'
          : valueUse
            ? 'value-use'
            : caught
              ? 'try-catch'
              : 'naked'
    out.push({ rel, line, method, chan, bound, kind, via: via ?? undefined, dataUse: dataUse ?? undefined, valueUse: valueUse ?? undefined })
  })
  return out
}

// ---------- V4-Iter-221：`.then(...)` 那条面 ----------
export type ThenKind = 'judged' | 'judged-via-helper' | 'fn-handoff' | 'data-ignored' | 'dropped'
export interface ThenSite {
  rel: string
  line: number
  method: string
  chan: string
  kind: ThenKind
  via?: string
  detail?: string
}

/**
 * §223：链根解析——从一条 `.then`／`.catch`／`.finally` 链的**接收者**往下剥，回到真正的
 * `window.pocketai.X(...)`。两面共用这一份，因为盲区是同一个：
 * `await window.pocketai.X().catch(h)`（217 起草时只认 `pa.expression` 正好是 `window.pocketai` 的形状）
 * 以前**整条不被看见**，`const p = window.pocketai.X(); p.then(cb)` 同样看不见。
 */
function chainRootMethod(node: ts.Node | undefined): string | null {
  let cur: ts.Node | undefined = node
  while (cur && ts.isCallExpression(cur)) {
    const callee = cur.expression
    if (!ts.isPropertyAccessExpression(callee)) return null
    const nm = callee.name.text
    if (nm === 'then' || nm === 'catch' || nm === 'finally') {
      cur = callee.expression
      continue
    }
    const recv = callee.expression
    if (ts.isPropertyAccessExpression(recv) && recv.name.text === 'pocketai') return nm
    return null
  }
  return null
}

/** `.then`／`.catch`／`.finally` 往下剥，直到落到真正的 `window.pocketai.X(...)`；只回方法名（链根的通道才是判据对象） */
function thenChainRoot(call: ts.CallExpression): string | null {
  const head = call.expression
  if (!ts.isPropertyAccessExpression(head)) return null
  return chainRootMethod(head.expression)
}

/**
 * §224：链根识别的最后一格。`chainRootMethod` 只会一路剥 `.then/.catch/.finally` 的**调用**，
 * 碰到 `const p = X(); p.then(cb).catch(noop)` 时它停在 `p.then(cb)` 上认不出——于是 `.catch` 面
 * 看不见 `KbAskRoam` 那一处（`.then` 面能看见，因为它只隔一层）。这里把"剥到标识符就查 promiseBinds"补全，
 * 两面共用同一个入口。
 */
function rootOf(call: ts.CallExpression, binds: Map<string, string>): string | null {
  const byChain = thenChainRoot(call)
  if (byChain) return byChain
  let cur: ts.Node = call
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const nm = cur.expression.name.text
    if (nm !== 'then' && nm !== 'catch' && nm !== 'finally') break
    cur = cur.expression.expression
  }
  return ts.isIdentifier(cur) ? binds.get(cur.text) ?? null : null
}

/**
 * 一个文件的三张索引，`.then` 面与 `.catch` 面共用：
 *   · `locals`——同文件的具名函数（判据可能被搬进去，§215 的 `failOp`／§217 的 `handleRestoreResult`）
 *   · `promiseBinds`——"先绑到变量、再链"的 Promise（`const p = k ? window.pocketai.a() : window.pocketai.b()`）
 *     §221 当时把这条写成"不追"的口径边界，仓库里其实有真实实例（KbAsk 两处），§223 补上
 * 注释先抹白（偏移不变），否则守卫写在注释里也能把闸门喂绿（§216 那次假绿的直接形状）。
 */
interface FileIndex {
  ast: ts.SourceFile
  locals: Map<string, { params: string[]; body: string }>
  promiseBinds: Map<string, string>
}

function indexFile(rel: string, rawSrc: string): FileIndex {
  const clean = blankComments(rawSrc, rel)
  const ast = ts.createSourceFile(rel, clean, ts.ScriptTarget.ESNext, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const locals = new Map<string, { params: string[]; body: string }>()
  const register = (name: string, node: ts.Node): void => {
    if (!isFnNode(node)) return
    const fn = node as ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration
    locals.set(name, {
      params: fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '')),
      body: fn.body ? fn.body.getFullText(ast) : '',
    })
  }
  walk(ast, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) register(n.name.text, n)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFnNode(n.initializer)) register(n.name.text, n.initializer)
  })
  const promiseBinds = new Map<string, string>()
  const methodsIn = (node: ts.Node | undefined): string[] => {
    if (!node) return []
    const one = chainRootMethod(node)
    if (one) return [one]
    if (ts.isConditionalExpression(node)) return [...methodsIn(node.whenTrue), ...methodsIn(node.whenFalse)]
    if (ts.isParenthesizedExpression(node)) return methodsIn(node.expression)
    return []
  }
  walk(ast, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer) return
    const ms = methodsIn(n.initializer)
    if (ms.length) promiseBinds.set(n.name.text, ms[0]!)
  })
  return { ast, locals, promiseBinds }
}

/**
 * 一个文件里 `window.pocketai.X(...).then(cb)` 的分类。与 await 面有三处**刻意的不同**：
 *   ① try…catch／后面挂的 `.catch()` 都不算合格——失败是 resolve 值，catch 永远接不到它；
 *   ② 整条结果交给具名函数（`.then(setX)`）算不合格：那次赋值不看 `ok`，`{ok:false}` 就直接进了 state；
 *   ③ 回调不接结果（`.then(() => 收尾)`）算不合格：成功与失败走同一条路，正是 §211 那族"失败还照样收尾"。
 */
export function classifyThenSource(rel: string, rawSrc: string, methods: Map<string, string>, safeChans: Set<string>): ThenSite[] {
  const { ast, locals, promiseBinds } = indexFile(rel, rawSrc)

  const out: ThenSite[] = []
  walk(ast, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
    if (n.expression.name.text !== 'then') return
    const method = rootOf(n, promiseBinds)
    if (!method) return
    const chan = methods.get(method)
    if (!chan || !safeChans.has(chan)) return
    const line = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1
    const base = { rel, line, method, chan }
    const cb = n.arguments[0]
    if (!cb) return void out.push({ ...base, kind: 'dropped', detail: '.then() 没回调' })
    if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) {
      const fnText = cb.getFullText(ast).trim()
      const loc = locals.get(fnText)
      // 具名函数自己判了失败面（`.then(handleRes)`）⇒ 合格；没登记或没判 ⇒ fn-handoff
      if (loc && loc.params[0] && judgeFor(loc.params[0]).test(loc.body)) out.push({ ...base, kind: 'judged-via-helper', via: fnText })
      else out.push({ ...base, kind: 'fn-handoff', detail: `.then(${fnText})` })
      return
    }
    const p = cb.parameters[0]
    const body = cb.body.getFullText(ast)
    if (!p) return void out.push({ ...base, kind: 'dropped', detail: '回调不接结果' })
    if (!ts.isIdentifier(p.name)) return void out.push({ ...base, kind: 'data-ignored', detail: '解构结果' })
    const name = p.name.text
    if (judgeFor(name).test(body)) return void out.push({ ...base, kind: 'judged' })
    for (const mm of body.matchAll(/\b([A-Za-z0-9_]+)\(([^)]{0,120})\)/g)) {
      const loc = locals.get(mm[1]!)
      if (!loc) continue
      const idx = mm[2]!.split(',').findIndex((a) => a.trim() === name || a.trim() === `!${name}`)
      if (idx < 0) continue
      const pname = loc.params[idx]
      if (pname && judgeFor(pname).test(loc.body)) return void out.push({ ...base, kind: 'judged-via-helper', via: mm[1]! })
    }
    // 读法明细：先看"取字段"，再看"当实参／写进结构"——顺序反了就得到 `(r` 这种没信息量的左边匹配
    const prop = new RegExp(`\\b${esc(name)}\\.\\w+`).exec(body)
    const other = new RegExp(`\\(\\s*${esc(name)}\\b|,\\s*${esc(name)}\\b|\\[\\s*${esc(name)}\\b|=\\s*${esc(name)}\\b|\\b${esc(name)}\\b\\s*[,)]`).exec(body)
    const dataUse = prop ?? other
    if (dataUse) return void out.push({ ...base, kind: 'data-ignored', detail: dataUse[0].trim() })
    out.push({ ...base, kind: 'dropped', detail: `绑了 ${name} 但没读` })
  })
  return out
}

// ---------- §224 第三面：`.catch(…)` 这个处理函数本身是不是空的 ----------
export type CatchKind = 'void-catch' | 'other-value' | 'handled'
export interface CatchSite {
  rel: string
  line: number
  method: string
  chan: string
  kind: CatchKind
  detail?: string
}

/** 处理函数是不是"什么也不做"：`() => {}`、`() => { /* 注释 *\/ }`、绑到一个空函数上 */
function isEmptyHandler(node: ts.Node | undefined, locals: Map<string, { params: string[]; body: string }>): boolean {
  if (!node) return true // `.catch()`：连处理函数都没有
  if (ts.isIdentifier(node)) {
    const loc = locals.get(node.text)
    if (loc) return /^\s*\{[\s]*\}$/.test(loc.body.trim())
    return false // 绑到看不见的东西上（跨文件 import）⇒ 不猜
  }
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false
  const b = node.body
  if (!ts.isBlock(b)) return false // 表达式体（`() => toast.error(e)`）里一定有动作
  return b.statements.length === 0
}

/**
 * 渲染层每一条挂在 safeHandle 通道链根的 `.catch(…)`。这一面问的不是"失败判没判"（那是 `.then`／await 两面），
 * 而是**"真抛错那一面有没有被人接住"**：`.catch(() => {})` 是这一族唯一的出口，空体就意味着
 * 成功回调自己抛的 TypeError、preload 同步抛错、通道没注册这三类真故障**一点痕迹都不留**。
 * §217 的"try…catch 算合格"管的是 await 面（那里 catch 接不到 resolve 的失败，包着只是"不崩"），
 * 与这一面不冲突：这里判的是 catch 自己。
 */
export function classifyCatchSource(rel: string, rawSrc: string, methods: Map<string, string>, safeChans: Set<string>): CatchSite[] {
  const { ast, locals, promiseBinds } = indexFile(rel, rawSrc)
  const out: CatchSite[] = []
  walk(ast, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
    if (n.expression.name.text !== 'catch') return
    const method = rootOf(n, promiseBinds)
    if (!method) return
    const chan = methods.get(method)
    if (!chan || !safeChans.has(chan)) return
    const line = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1
    const base = { rel, line, method, chan }
    if (isEmptyHandler(n.arguments[0], locals)) {
      out.push({ ...base, kind: 'void-catch', detail: n.arguments[0] ? n.arguments[0].getText(ast) : '(无处理函数)' })
      return
    }
    // 返回一个值的 catch（`() => null`／`() => []`）：真抛错被换成一个"看起来正常"的默认值，是 §196 那条
    // "列表读失败不许当成空集"的近邻形状。本批只把它量出来，不算不合格（口径要单独定，别顺手混进这一族）
    const h = n.arguments[0]
    if (h && (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) && !ts.isBlock(h.body)) {
      const t = h.body.getText(ast).trim()
      if (/^(null|undefined|\[\]|\{\}|''|false|void 0)$/.test(t)) {
        out.push({ ...base, kind: 'other-value', detail: `() => ${t}` })
        return
      }
    }
    out.push({ ...base, kind: 'handled' })
  })
  return out
}

// ---------- 宇宙：通道两侧 ＋ 渲染层全部文件 ----------
const METHODS = preloadMethods(read('src/preload/index.ts'))
const SAFE = safeHandleChannels(filesIn('src/main').map(read))
const RENDERER = filesIn('src/renderer/src')
const SITES = RENDERER.flatMap((rel) => classifySource(rel, read(rel), METHODS, SAFE))
/** 不合格的三档：什么都没接（naked）、包在 catch 里却把结果当数据用（data-ignored）、结果没绑变量却被当值用（value-use） */
const unsafe = SITES.filter((s) => s.kind === 'naked' || s.kind === 'data-ignored' || s.kind === 'value-use')
const THEN_SITES = RENDERER.flatMap((rel) => classifyThenSource(rel, read(rel), METHODS, SAFE))
/** `.then` 面不合格的三档（这一面没有"被 try 包着算合格"这一说） */
const thenUnsafe = THEN_SITES.filter((s) => s.kind === 'fn-handoff' || s.kind === 'data-ignored' || s.kind === 'dropped')
/** §224 第三面：挂在 safeHandle 通道链根上的每一条 `.catch(…)` */
const CATCH_SITES = RENDERER.flatMap((rel) => classifyCatchSource(rel, read(rel), METHODS, SAFE))
const voidCatch = CATCH_SITES.filter((s) => s.kind === 'void-catch')
const otherValue = CATCH_SITES.filter((s) => s.kind === 'other-value')


describe('① 底座：闸门得先看见整个宇宙（任何一项塌了，下面的 0 就是空转）', () => {
  it('preload 方法→通道 与 safeHandle 注册两侧都对得上', () => {
    expect(METHODS.size).toBeGreaterThanOrEqual(300)
    expect(SAFE.size).toBeGreaterThanOrEqual(300)
    const orphan = [...METHODS.entries()].filter(([, c]) => !SAFE.has(c)).map(([m, c]) => `${m}→${c}`)
    expect(orphan, `preload 里有方法指向没走 safeHandle 的通道：${orphan.join(', ')}`).toEqual([])
  })

  it('渲染层的 await 点数落在预期量级（掉一半就是扫描器瞎了，不是代码变干净了）', () => {
    expect(SITES.length).toBeGreaterThanOrEqual(250)
    const judged = SITES.filter((s) => s.kind === 'judged' || s.kind === 'judged-via-helper').length
    const caught = SITES.filter((s) => s.kind === 'try-catch').length
    // §326：沙箱这一屏两处从"只被 try/catch 包着"挪进了"判返回值"（现数：judged 249／caught 38）。
    // §328：首启向导那一屏再搬四处（saveAssistant 绑 provider／setAssistantPinned／循环里的 saveSkill／completeWizard），
    //   先探针现量两桶再动数字：judged 253／caught 34／unsafe 0／SITES 287（总数不变＝纯搬运，不是扫描器少看了）。
    // §331：知识库文档重命名／编辑原文／消息右键建提醒三发从 try/catch 桶搬进判定桶（§330 那批搬了两发问答历史读取），
    //   探针现量：judged 258／caught 29／unsafe 0／**SITES 287＝和 §328 完全一样** ⇒ 是搬运不是漏看。
    // §332：文件页四颗「在系统里打开」从"只挂 `.catch`"改成 `const r = await …`＋inline 判信封，
    //   探针现量：judged 262／caught 29／unsafe 0／SITES 291（＝287＋4，正对着那四颗键）
    //   ⇒ 净新增四个判点、两桶之间没有搬运，两根底线都不用动。
    // §334：提醒中心两处 cancel/reschedule 从 try-catch 桶搬进判定桶（加了 ipcFailText 判失败面），
    //   探针现量：judged 264／caught 26／unsafe 0／SITES 290（＝291-1，总数微降是因为合并了一处）
    //   ⇒ 净新增两个判点、caught 桶少两点，底线相应下调。
    // 这两根是**量级底线**（扫描器瞎了才会掉到这儿），不是精确数；收一处静默点就会让 caught 少一点、judged 多一点，
    // 所以 judged 那根随批上提，caught 那根留出 Enough 的余量。
    expect(judged, '判返回值的点').toBeGreaterThanOrEqual(255)
    expect(caught, '只被 try/catch 包着的点').toBeGreaterThanOrEqual(26)
    expect(judged + caught + unsafe.length).toBe(SITES.length)
  })

  it('§221 那一面的量级：`.then` 链上的点 ≥100，且判过的 ＋ 不合格的 ＝ 全部（没有第三档）', () => {
    expect(THEN_SITES.length).toBeGreaterThanOrEqual(100)
    const judged = THEN_SITES.filter((s) => s.kind === 'judged' || s.kind === 'judged-via-helper').length
    expect(judged, '回调里判了失败面的 .then 点').toBeGreaterThanOrEqual(100)
    expect(judged + thenUnsafe.length).toBe(THEN_SITES.length)
  })

  it('§224 第三面的量级自检：`.catch` 点数 ≥140、接住 reject 面的 ≥120、三档之和＝全部', () => {
    expect(CATCH_SITES.length).toBeGreaterThanOrEqual(140)
    const handled = CATCH_SITES.filter((s) => s.kind === 'handled').length
    expect(handled, '接住了 reject 面的 `.catch`').toBeGreaterThanOrEqual(120)
    expect(handled + voidCatch.length + otherValue.length).toBe(CATCH_SITES.length)
  })
})

describe('② 分类器自己要有牙：五种形状的内联桩', () => {
  const M = new Map([['foo', 'X_FOO'], ['bar', 'X_BAR']])
  const S = new Set(['X_FOO'])
  const run = (body: string): Site[] => classifySource('x.tsx', `export const C = () => {\n${body}\n}\n`, M, S)

  it('正向对照：判了返回值的点是合格的（不是"全都算过"）', () => {
    const [s] = run('  const r = await window.pocketai.foo()\n  if (hasIpcFailed(r)) return\n')
    expect(s!.kind).toBe('judged')
  })
  it('裸 await（结果既不绑也不判、也没有 try）⇒ naked', () => {
    const [s] = run('  await window.pocketai.foo()')
    expect(s!.kind).toBe('naked')
  })
  it('把结果直接写进 state ⇒ 不算判过，且归到 data-ignored 那一档（§219）', () => {
    const [s] = run('  const r = await window.pocketai.foo()\n  setX(r.items)\n')
    expect(s!.kind).toBe('data-ignored')
    expect(s!.dataUse).toBe('r.items')
  })
  it('包在 try…catch 里也不行：catch 接不到 resolve 的失败，把结果当数据读照样谎报（§219 立这一档的理由）', () => {
    const [s] = run('  try {\n    const r = await window.pocketai.foo()\n    setX(r.items)\n  } catch (e) {\n    reportIpcError(e)\n  }\n')
    expect(s!.kind).toBe('data-ignored')
  })
  it('绑了变量但从没读过它 ⇒ 归 naked，不是 data-ignored（声明本身不该被当成"读"）', () => {
    const [s] = run('  const r = await window.pocketai.foo()\n  setBusy(false)\n')
    expect(s!.kind).toBe('naked')
    expect(s!.dataUse).toBeUndefined()
  })
  it('口径边界：结果没绑定、只是 fire-and-forget ⇒ 包着 catch 仍算 try-catch（这一档不由本闸门逼）', () => {
    const [s] = run('  try {\n    await window.pocketai.foo()\n  } catch (e) {\n    reportIpcError(e)\n  }\n')
    expect(s!.kind).toBe('try-catch')
  })
  it('判过之后再把结果当数据用 ⇒ 合格（这条挡住"判据加了还不许读字段"的过度收紧）', () => {
    const [s] = run('  const r = await window.pocketai.foo()\n  if (hasIpcFailed(r)) return\n  setX(r.items)\n')
    expect(s!.kind).toBe('judged')
  })
  it('包围的 try…catch 算合格；只有 finally 的不算（catch 根本不在这一发外面）', () => {
    const wrapped = run('  try {\n    await window.pocketai.foo()\n  } catch (e) { /* 静默 */ }\n')[0]!.kind
    const finallyOnly = run('  try {\n    await window.pocketai.foo()\n  } finally {\n    setBusy(false)\n  }\n')[0]!.kind
    expect(wrapped).toBe('try-catch')
    expect(finallyOnly).toBe('naked')
  })
  it('await 落在 finally 块里 ⇒ 不算被 catch 保护（catch 在它之前就跑完了）', () => {
    const [s] = run(
      '  try {\n    setBusy(true)\n  } catch (e) {\n    reportIpcError(e)\n  } finally {\n    await window.pocketai.foo()\n  }\n',
    )
    expect(s!.kind).toBe('naked')
  })
  it('判据被搬进同文件的助手 ⇒ 跟着形参走到助手本体（§215 的 failOp、§217 的 handleRestoreResult）', () => {
    const src = [
      'function handleRes(r: unknown): void {',
      '  if (hasIpcFailed(r)) setError(String(r))',
      '}',
      'export const C = () => {',
      '  const go = async () => {',
      '    const r = await window.pocketai.foo()',
      '    handleRes(r)',
      '  }',
      '}',
    ].join('\n')
    const [s] = classifySource('y.ts', src, M, S)
    expect(s!.kind).toBe('judged-via-helper')
    expect(s!.via).toBe('handleRes')
  })
  it('守卫只写在注释里 ⇒ 不算（§216 那次假绿的直接形状）', () => {
    const [s] = run('  const r = await window.pocketai.foo()  // if (hasIpcFailed(r)) { toast.error(r.error); return }')
    expect(s!.kind).toBe('naked')
  })
  it('不走 safeHandle 的通道不归本闸门管（口径边界，防它将来吞掉一切 await）', () => {
    expect(run('  await window.pocketai.bar()')).toEqual([])
    expect(classifySource('z.ts', 'export const f = async () => { await somethingElse.foo() }', M, S)).toEqual([])
  })
  it('§223 新档：结果没绑变量却被当值用 ⇒ value-use（这类点以前被 try…catch 一档放行）', () => {
    const [asArg] = run('  try {\n    setItems(await window.pocketai.foo())\n  } catch (e) {\n    reportIpcError(e)\n  }\n')
    expect(asArg!.kind).toBe('value-use')
    expect(asArg!.valueUse).toContain('作为实参')
    const [negated] = run('  if (!(await window.pocketai.foo())) return')
    expect(negated!.kind).toBe('value-use')
    expect(negated!.valueUse).toContain('真值判')
    const [field] = run('  const n = (await window.pocketai.foo()).items\n  setX(n)')
    expect(field!.kind).toBe('value-use')
    expect(field!.valueUse).toBe('取字段 .items')
  })
  it('§223 控制项：日志标签里的通道名不算判据（判据式子要的词边界咬不动「chat.listThings」这种串）', () => {
    const [s] = run('  const list = await window.pocketai.foo()\n  logIpcError(\'chat.listThings\', e)\n  setX(list.items)\n')
    expect(s!.kind).toBe('data-ignored')
  })
  it('§223 假绿修复②：真值判要求整个条件就是那个变量（`if (list.length === 0)` 不是"判了 list"）', () => {
    const [s] = run('  const list = await window.pocketai.foo()\n  if (list.length === 0) return\n  setX(list)\n')
    expect(s!.kind).toBe('data-ignored')
  })
  it('§223：`await X().catch(h)` 这条尾链现在看得见（以前整条不被扫到）', () => {
    const [s] = run('  const list = await window.pocketai.foo().catch(() => null)\n  setX(list.items)\n')
    expect(s!.method).toBe('foo')
    expect(s!.kind).toBe('data-ignored')
    // 结果没被当值用（纯 fire-and-forget）时仍按 try…catch 口径放行
    const [ok] = run('  try {\n    await window.pocketai.foo().catch(reportIpcError(\'x\'))\n  } catch (e) {\n    reportIpcError(e)\n  }\n')
    expect(ok!.kind).toBe('try-catch')
  })
})

describe('③ 主判据：既没判也没包围 catch、"catch 里把结果当数据用"、"结果被当值用却没判"，三档都必须为 0', () => {
  it('每个 await safeHandle 通道的点要么判了失败面，要么只是被 try…catch 包着且没把结果当数据用', () => {
    const list = unsafe.map((s) => `${s.rel}:${s.line} ${s.method}（${s.kind === 'naked' ? '什么都没接' : s.kind === 'value-use' ? `当值用：${s.valueUse}` : `当数据用：${s.dataUse}`}）`)
    expect(list, `这些点的失败既不被判、又被当成数据／值读：\n${list.join('\n')}`).toEqual([])
  })
})

describe('④ `.then` 面的分类器同样要有牙：§221 那三处口径差各有一根桩钉着', () => {
  const M = new Map([['foo', 'X_FOO'], ['bar', 'X_BAR']])
  const S = new Set(['X_FOO'])
  const run = (body: string): ThenSite[] => classifyThenSource('x.tsx', `export const C = () => {\n${body}\n}\n`, M, S)

  it('正向对照：回调里判了失败面 ⇒ judged（这条挡住"全都算不合格"的过度收紧）', () => {
    const [s] = run('  window.pocketai.foo().then((r) => { if (hasIpcFailed(r)) return; setX(r.items) })')
    expect(s!.kind).toBe('judged')
  })
  it('整条结果交给具名函数（`.then(setX)`）⇒ fn-handoff：那次赋值不看 ok，`{ok:false}` 直接进 state', () => {
    const [s] = run('  window.pocketai.foo().then(setX)')
    expect(s!.kind).toBe('fn-handoff')
    expect(s!.detail).toBe('.then(setX)')
  })
  it('回调里把结果当数据读 ⇒ data-ignored', () => {
    const [s] = run('  window.pocketai.foo().then((r) => setX(r.items))')
    expect(s!.kind).toBe('data-ignored')
    expect(s!.detail).toBe('r.items')
  })
  it('把结果整个赋给 ref／变量（`ref.current = r`）⇒ 也是当数据用，不是"绑了没读"', () => {
    const [s] = run('  window.pocketai.foo().then((r) => {\n    ref.current = r\n  })')
    expect(s!.kind).toBe('data-ignored')
    expect(s!.detail).toBe('= r')
  })
  it('回调不接结果 ⇒ dropped：成功与失败走同一条路（§211 那族"失败还照样收尾"）', () => {
    const [s] = run('  window.pocketai.foo().then(() => setSaved(true))')
    expect(s!.kind).toBe('dropped')
    const [noCb] = run('  window.pocketai.foo().then()')
    expect(noCb!.kind).toBe('dropped')
    const [bound] = run('  window.pocketai.foo().then((r) => setSaved(true))')
    expect(bound!.kind).toBe('dropped')
  })
  it('口径①：包在 try…catch 里也不合格（await 面认这一档，`.then` 面不认）', () => {
    const [s] = run('  try {\n    window.pocketai.foo().then((r) => setX(r.items))\n  } catch (e) {\n    reportIpcError(e)\n  }\n')
    expect(s!.kind).toBe('data-ignored')
  })
  it('口径②：后面挂着 `.catch(reportIpcError(…))` 也不算合格（catch 接不到 resolve 的失败）', () => {
    const [s] = run('  window.pocketai.foo().then(setX).catch(reportIpcError(\'x\'))')
    expect(s!.kind).toBe('fn-handoff')
  })
  it('具名函数自己判了失败面 ⇒ 合格（`.then(handleRes)`）', () => {
    const src = [
      'function handleRes(r: unknown): void {',
      '  if (hasIpcFailed(r)) setError(String(r))',
      '}',
      'export const C = () => {',
      '  window.pocketai.foo().then(handleRes)',
      '}',
    ].join('\n')
    const [s] = classifyThenSource('y.ts', src, M, S)
    expect(s!.kind).toBe('judged-via-helper')
    expect(s!.via).toBe('handleRes')
  })
  it('判据搬进助手：回调把结果转给同文件那个判过的函数 ⇒ 跟着形参走过去', () => {
    const src = [
      'function handleRes(r: unknown): void {',
      '  if (hasIpcFailed(r)) setError(String(r))',
      '}',
      'export const C = () => {',
      '  window.pocketai.foo().then((r) => handleRes(r))',
      '}',
    ].join('\n')
    const [s] = classifyThenSource('y.ts', src, M, S)
    expect(s!.kind).toBe('judged-via-helper')
  })
  it('守卫只写在注释里 ⇒ 仍是 data-ignored（§216 那次假绿的同形）', () => {
    const [s] = run('  window.pocketai.foo().then((r) => setX(r.items)) // if (hasIpcFailed(r)) return')
    expect(s!.kind).toBe('data-ignored')
  })
  it('剥链：`foo().catch(…).then(cb)` 里那条 `.then` 照样归到 foo 的通道上', () => {
    const [s] = run('  window.pocketai.foo().catch(reportIpcError(\'x\')).then((r) => setX(r.items))')
    expect(s!.method).toBe('foo')
    expect(s!.kind).toBe('data-ignored')
  })
  it('不走 safeHandle 的通道不归本闸门管；`const p = foo(); p.then(setX)` 现在也追（§221 写成"不追"，§223 因仓库里有真实实例补上）', () => {
    expect(run('  window.pocketai.bar().then(setX)')).toEqual([])
    const [bound] = run('  const p = window.pocketai.foo()\n  p.then(setX)')
    expect(bound!.kind).toBe('fn-handoff')
    expect(bound!.method).toBe('foo')
    // 三元两支各自一条通道：认第一支（两支都走 safeHandle 时判据形状是同一份）
    const [cond] = run('  const p = k ? window.pocketai.foo() : window.pocketai.foo()\n  p.then((v) => setX(v.items))')
    expect(cond!.kind).toBe('data-ignored')
  })
})

describe('⑤ 主判据（`.then` 面）：三档不合格都必须为 0', () => {
  it('每个 `.then` 回调都得看见这次到底成没成', () => {
    const list = thenUnsafe.map((s) => `${s.rel}:${s.line} ${s.method}（${s.kind}：${s.detail ?? ''}）`)
    expect(list, `这些 .then 点把失败对象当数据／当成功用：\n${list.join('\n')}`).toEqual([])
  })
})

describe('⑥ `.catch` 面的分类器要有牙：空体＝把真抛错咽下去（§224 新立的第三面）', () => {
  const M = new Map([['foo', 'X_FOO'], ['bar', 'X_BAR']])
  const S = new Set(['X_FOO'])
  const run = (body: string): CatchSite[] => classifyCatchSource('x.tsx', `export const C = () => {\n${body}\n}\n`, M, S)

  it('正向对照：`reportIpcError(…)` 与真的写状态的处理器都算接住', () => {
    expect(run('  window.pocketai.foo().catch(reportIpcError(\'x\'))')[0]!.kind).toBe('handled')
    expect(run('  window.pocketai.foo().then((r) => setX(r)).catch((e) => { setErr(String(e)); reload() })')[0]!.kind).toBe('handled')
  })
  it('空箭头体 ⇒ void-catch；只写注释的空体同样 ⇒ void-catch（§216 那一课在 catch 面重演）', () => {
    expect(run('  window.pocketai.foo().catch(() => {})')[0]!.kind).toBe('void-catch')
    expect(run('  window.pocketai.foo().catch(() => { /* 卸载中止，失败无影响 */ })')[0]!.kind).toBe('void-catch')
    expect(run('  window.pocketai.foo().catch(function () {})')[0]!.kind).toBe('void-catch')
  })
  it('连处理函数都没有（`.catch()`）⇒ void-catch', () => {
    expect(run('  window.pocketai.foo().catch()')[0]!.kind).toBe('void-catch')
  })
  it('两面互不掩护：`.then` 判过失败面，后面挂空 catch 照样红（判据管 resolve 面，catch 管 reject 面）', () => {
    const [c] = run('  window.pocketai.foo().then((r) => { if (hasIpcFailed(r)) return }).catch(() => {})')
    expect(c!.kind).toBe('void-catch')
  })
  it('具名空函数：`.catch(noop)` 且 noop 在本文件登记过 ⇒ 跟着走，仍是 void-catch', () => {
    const [s] = run('  const noop = () => {}\n  window.pocketai.foo().catch(noop)')
    expect(s!.kind).toBe('void-catch')
    expect(s!.detail).toBe('noop')
  })
  it('口径边界：处理函数是 import 进来的、本文件读不到实现 ⇒ 不猜（认成 handled）', () => {
    expect(run('  window.pocketai.foo().catch(silentHandler)')[0]!.kind).toBe('handled')
  })
  it('§224 的链根补全：`const p = X(); p.then(cb).catch(noop)` 这一头以前整条看不见（KbAskRoam 就是这一处）', () => {
    const [s] = run('  const p = window.pocketai.foo()\n  p.then((r) => setX(r)).catch(() => {})')
    expect(s!.method).toBe('foo')
    expect(s!.kind).toBe('void-catch')
    const [cond] = run('  const p = k ? window.pocketai.foo() : window.pocketai.foo()\n  p.then(cb).catch(() => {})')
    expect(cond!.kind).toBe('void-catch')
  })
  it('`() => null`／`() => []` 归第三档 other-value：把真抛错换成一个"看起来正常"的默认值（本批只量，不混进 void-catch）', () => {
    const [s] = run('  window.pocketai.foo().then((r) => setX(r)).catch(() => null)')
    expect(s!.kind).toBe('other-value')
    expect(s!.detail).toBe('() => null')
  })
  it('不走 safeHandle 的通道不归这一面管（与 await／.then 两面同口径）', () => {
    expect(run('  window.pocketai.bar().catch(() => {})')).toEqual([])
    expect(run('  somethingElse.foo().catch(() => {})')).toEqual([])
  })
})

describe('⑦ 主判据（`.catch` 面）：空体必须为 0，且没有豁免名单', () => {
  it('挂在 safeHandle 链根上的每个 `.catch` 都得真接住 reject 面', () => {
    const list = voidCatch.map((s) => `${s.rel}:${s.line} ${s.method}（处理函数＝${s.detail ?? ''}）`)
    expect(list, `这些 catch 把真抛错咽掉了：\n${list.join('\n')}`).toEqual([])
  })
  it('§229 起第三档也必须为 0：把真抛错换成一个"看起来正常"的默认值，比空体更难发现', () => {
    // 这一档以前有 3 处（`KnowledgeModule:631` 轮询、`StewardModule:166` 导出报告的版本行、
    // `FirstRunWizard:235` 首启那一步＋完成页那句无条件 ✓）。§229 把它们逐个接上了脸，
    // 于是这里从"只量"升成"闸门"——**这一族的桩在 ⑥ 里，档位本身仍有牙**。
    const list = otherValue.map((s) => `${s.rel}:${s.line} ${s.method}（处理函数＝${s.detail ?? ''}）`)
    expect(list, `这些 catch 把真抛错换成了一个看起来正常的默认值：\n${list.join('\n')}`).toEqual([])
  })
})

describe('⑧ 闸门看得见行的前提：渲染层与 preload 没有孤立 CR', () => {
  // §216：JS 里 CR 是合法行结束符 ⇒ 运行期与 tsc 都不报错，但 git 把该文件判成 binary（以后这块 diff 没有审阅面），
  // 而任何按 `\n` 切行的扫描器会把守卫并进上一行的注释里。这里覆盖闸门扫描的全部文件，因为它一坏，本闸门的"看得见"就整体失效。
  const scan = [...RENDERER, 'src/preload/index.ts']
  const offenders = scan.filter((rel) => {
    const b = fs.readFileSync(path.join(ROOT, rel))
    for (let i = 0; i < b.length; i++) if (b[i] === 0x0d && b[i + 1] !== 0x0a) return true
    return b.includes(0x00)
  })
  it(`扫了 ${scan.length} 个文件，没有一个含孤立 CR／NUL`, () => {
    expect(scan.length).toBeGreaterThanOrEqual(140)
    expect(offenders, `这些文件会被 git 判成 binary：${offenders.join(', ')}`).toEqual([])
  })
})
