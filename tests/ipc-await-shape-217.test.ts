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
/** 只认失败面字段；`x.data` 这种"当数据用"绝不算判过 */
const judgeFor = (name: string): RegExp =>
  new RegExp(
    [
      `(?:${JUDGE_ALT})\\s*\\([^)]{0,80}?\\b${esc(name)}\\b`,
      `\\b${esc(name)}\\.ok\\b`,
      `'ok'\\s+in\\s*${esc(name)}\\b`,
      `\\b${esc(name)}\\.(?:error|code|canceled|locked)\\b`,
      `if\\s*\\(\\s*!?${esc(name)}\\b`,
      `\\b${esc(name)}\\s*(&&|\\?\\?|===|!==)`,
    ].join('|'),
  )

const isFnNode = (n: ts.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

export type SiteKind = 'judged' | 'judged-via-helper' | 'try-catch' | 'data-ignored' | 'naked'
export interface Site {
  rel: string
  line: number
  method: string
  chan: string
  bound: string | null
  kind: SiteKind
  via?: string
  dataUse?: string
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
    const pa = n.expression.expression
    if (!ts.isPropertyAccessExpression(pa)) return
    if (!ts.isPropertyAccessExpression(pa.expression) || pa.expression.name.text !== 'pocketai') return
    const method = pa.name.text
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
    // ts.TryStatement 没有 block 属性（block 只是 children）⇒ 认"TryStatement 的 Block 子节点且不是 finallyBlock"
    const tryBlock = fn ? ancestor(n, (p) => ts.isBlock(p) && !!p.parent && ts.isTryStatement(p.parent) && p.parent.finallyBlock !== p) : null
    const caught = !!(tryBlock && tryBlock.parent && (tryBlock.parent as ts.TryStatement).catchClause)
    const line = ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1
    const kind: SiteKind = judgedDirect ? 'judged' : via ? 'judged-via-helper' : dataUse ? 'data-ignored' : caught ? 'try-catch' : 'naked'
    out.push({ rel, line, method, chan, bound, kind, via: via ?? undefined, dataUse: dataUse ?? undefined })
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

/** `.then`／`.catch`／`.finally` 往下剥，直到落到真正的 `window.pocketai.X(...)`；只回方法名（链根的通道才是判据对象） */
function thenChainRoot(call: ts.CallExpression, parents: Map<ts.Node, ts.Node>): string | null {
  const head = call.expression
  if (!ts.isPropertyAccessExpression(head)) return null
  let node: ts.Node = head.expression
  while (ts.isCallExpression(node)) {
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return null
    const nm = callee.name.text
    if (nm === 'then' || nm === 'catch' || nm === 'finally') {
      node = callee.expression
      continue
    }
    const recv = callee.expression
    if (ts.isPropertyAccessExpression(recv) && recv.name.text === 'pocketai') return nm
    return null
  }
  // 也可能是 `const p = window.pocketai.foo()` 之后 `p.then(...)`——这一版**不**跟（口径见 ④ 的最后一根桩）
  void parents
  return null
}

/**
 * 一个文件里 `window.pocketai.X(...).then(cb)` 的分类。与 await 面有三处**刻意的不同**：
 *   ① try…catch／后面挂的 `.catch()` 都不算合格——失败是 resolve 值，catch 永远接不到它；
 *   ② 整条结果交给具名函数（`.then(setX)`）算不合格：那次赋值不看 `ok`，`{ok:false}` 就直接进了 state；
 *   ③ 回调不接结果（`.then(() => 收尾)`）算不合格：成功与失败走同一条路，正是 §211 那族"失败还照样收尾"。
 */
export function classifyThenSource(rel: string, rawSrc: string, methods: Map<string, string>, safeChans: Set<string>): ThenSite[] {
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

  const out: ThenSite[] = []
  walk(ast, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
    if (n.expression.name.text !== 'then') return
    const method = thenChainRoot(n, parents)
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

// ---------- 宇宙：通道两侧 ＋ 渲染层全部文件 ----------
const METHODS = preloadMethods(read('src/preload/index.ts'))
const SAFE = safeHandleChannels(filesIn('src/main').map(read))
const RENDERER = filesIn('src/renderer/src')
const SITES = RENDERER.flatMap((rel) => classifySource(rel, read(rel), METHODS, SAFE))
/** 不合格的两档：什么都没接（naked），以及包在 catch 里却把结果当数据用（data-ignored） */
const unsafe = SITES.filter((s) => s.kind === 'naked' || s.kind === 'data-ignored')
const THEN_SITES = RENDERER.flatMap((rel) => classifyThenSource(rel, read(rel), METHODS, SAFE))
/** `.then` 面不合格的三档（这一面没有"被 try 包着算合格"这一说） */
const thenUnsafe = THEN_SITES.filter((s) => s.kind === 'fn-handoff' || s.kind === 'data-ignored' || s.kind === 'dropped')


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
    expect(judged, '判返回值的点').toBeGreaterThanOrEqual(200)
    expect(caught, '只被 try/catch 包着的点').toBeGreaterThanOrEqual(40)
    expect(judged + caught + unsafe.length).toBe(SITES.length)
  })

  it('§221 那一面的量级：`.then` 链上的点 ≥100，且判过的 ＋ 不合格的 ＝ 全部（没有第三档）', () => {
    expect(THEN_SITES.length).toBeGreaterThanOrEqual(100)
    const judged = THEN_SITES.filter((s) => s.kind === 'judged' || s.kind === 'judged-via-helper').length
    expect(judged, '回调里判了失败面的 .then 点').toBeGreaterThanOrEqual(100)
    expect(judged + thenUnsafe.length).toBe(THEN_SITES.length)
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
})

describe('③ 主判据：既没判也没包围 catch、以及"catch 里把结果当数据用"，两档都必须为 0', () => {
  it('每个 await safeHandle 通道的点要么判了失败面，要么只是被 try…catch 包着且没把结果当数据用', () => {
    const list = unsafe.map((s) => `${s.rel}:${s.line} ${s.method}（${s.kind === 'naked' ? '什么都没接' : `当数据用：${s.dataUse}`}）`)
    expect(list, `这些点的失败既不被判、又被当成数据读：\n${list.join('\n')}`).toEqual([])
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
  it('不走 safeHandle 的通道不归本闸门管；`const p = foo(); p.then(setX)` 这一版不追（口径边界，写明白而不是留成暗坑）', () => {
    expect(run('  window.pocketai.bar().then(setX)')).toEqual([])
    expect(run('  const p = window.pocketai.foo()\n  p.then(setX)')).toEqual([])
  })
})

describe('⑤ 主判据（`.then` 面）：三档不合格都必须为 0', () => {
  it('每个 `.then` 回调都得看见这次到底成没成', () => {
    const list = thenUnsafe.map((s) => `${s.rel}:${s.line} ${s.method}（${s.kind}：${s.detail ?? ''}）`)
    expect(list, `这些 .then 点把失败对象当数据／当成功用：\n${list.join('\n')}`).toEqual([])
  })
})

describe('⑥ 闸门看得见行的前提：渲染层与 preload 没有孤立 CR', () => {
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
