// 外部导入信封闸门（源码级）：confirmImportExternal 进入成功分支前必须判 safeHandle 失败信封
//
// 为什么只做源码级闸门：全仓没有挂载 ChatModule 的用例（整棵树的代价不成比例，见台账 §253 记的
// 挂载面边界，§309 闸门同一口径），所以「主进程失败不许演成 TypeError」只能读源码判。
//
// 红过的那一族：safeHandle 的失败是 resolve 的 {ok:false,error}（§331 反复收的口径）。
// confirmImportExternal 改前不判就往下行读 `r.warnings.length`——信封上 warnings 是 undefined，
// 抛 TypeError 被 catch 演成「Cannot read properties of undefined」，真因（zod 拒／DB 关着）被吞，
// 且 `setImportExternal(null)` 在异常路径被跳过、文件清单残留在归属弹窗里。
//
// 三条判据：
//   ① 信封守卫要排在成功分支**之前**：只数"文件里有 hasIpcFailed"会放过守卫写在 r.warnings 之后
//     的写法（那时炸点已经过了）。比的是 AST 节点位置，不数 token。
//   ② 守卫支必须清弹窗状态（`setImportExternal(null)`）＋裸 return：只弹 toast 不 return，
//     下行照样炸；不清状态，失败文件清单残留。
//   ③ 条件要读结构：只认顶层就是 `hasIpcFailed(r)` 这个 CallExpression——
//     `if (false && hasIpcFailed(r))` 这种被中和的写法必须算没守卫（§266 的 Z7 同一课）。
// 用例③把判据②③各演一遍漏杀对照（真文件改出来的假源码），防扫描器退化成"恒返回有守卫"。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const FILE = path.resolve(__dirname, '../src/renderer/src/modules/chat/ChatModule.tsx')

interface GateResult {
  /** 找到 confirmImportExternal 与其内部的 importExternalConversations 调用 */
  found: boolean
  /** hasIpcFailed(r) 守卫排在第一处成功分支字段读取（r.conversationCount / r.warnings）之前 */
  guardBeforeReads: boolean
  /** 守卫支里有 setImportExternal(null)（失败也清弹窗，不留残留文件清单） */
  clearsDialog: boolean
  /** 守卫支以 return 收尾（不许判完继续往成功分支走） */
  earlyReturn: boolean
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

function scan(src: string): GateResult {
  const sf = ts.createSourceFile('m.tsx', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const result: GateResult = { found: false, guardBeforeReads: false, clearsDialog: false, earlyReturn: false }

  // 定位 confirmImportExternal 函数体
  let fnBody: ts.Block | undefined
  walk(sf, (n) => {
    if (fnBody) return
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'confirmImportExternal' &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      fnBody = n.initializer.body as ts.Block
    }
  })
  if (!fnBody || !ts.isBlock(fnBody)) return result

  // 成功分支的字段读取点：r.conversationCount / r.warnings（炸点本尊）
  const readPositions: number[] = []
  let guardIf: ts.IfStatement | undefined
  walk(fnBody, (n) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'r') {
      if (n.name.text === 'conversationCount' || n.name.text === 'warnings') {
        readPositions.push(n.getStart(sf))
      }
    }
    // 守卫条件只认顶层 CallExpression hasIpcFailed(r)（false && … 这种中和写法不算）
    if (!guardIf && ts.isIfStatement(n)) {
      const cond = n.expression
      if (
        ts.isCallExpression(cond) &&
        ts.isIdentifier(cond.expression) &&
        cond.expression.text === 'hasIpcFailed' &&
        cond.arguments.length === 1 &&
        ts.isIdentifier(cond.arguments[0]!) &&
        cond.arguments[0]!.text === 'r'
      ) {
        guardIf = n
      }
    }
  })
  if (!guardIf) return result
  result.found = true

  // ① 守卫位置必须早于所有成功分支读取点
  result.guardBeforeReads =
    readPositions.length > 0 && readPositions.every((p) => guardIf!.getStart(sf) < p)

  // ②③ 守卫支内部：setImportExternal(null) + 裸 return
  let seesClear = false
  let seesReturn = false
  walk(guardIf.thenStatement, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'setImportExternal' &&
      n.arguments.length === 1 &&
      n.arguments[0]!.kind === ts.SyntaxKind.NullKeyword
    ) {
      seesClear = true
    }
    if (ts.isReturnStatement(n)) seesReturn = true
  })
  result.clearsDialog = seesClear
  result.earlyReturn = seesReturn
  return result
}

describe('外部导入信封闸门：confirmImportExternal 先判信封再进成功分支', () => {
  it('① 真源码：hasIpcFailed(r) 守卫排在 r.conversationCount / r.warnings 之前，支内清弹窗＋return', () => {
    const r = scan(fs.readFileSync(FILE, 'utf8'))
    expect(r.found).toBe(true)
    expect(r.guardBeforeReads).toBe(true)
    expect(r.clearsDialog).toBe(true)
    expect(r.earlyReturn).toBe(true)
  })

  it('② 漏杀对照：守卫被中和成 `false && hasIpcFailed(r)` 必须算没守卫', () => {
    const real = fs.readFileSync(FILE, 'utf8')
    // 全文件有 9 处 `if (hasIpcFailed(r))`——必须带上 confirmImportExternal 支内独有的下文定位，
    // 否则 replace 换掉的是别处的同形守卫，本函数那道仍在，对照组恒绿（现编现抓到的）
    const anchor = "if (hasIpcFailed(r)) {\n        toast.error(t('chat.importFail'"
    expect(real).toContain(anchor)
    const fake = real.replace(anchor, "if (false && hasIpcFailed(r)) {\n        toast.error(t('chat.importFail'")
    const r = scan(fake)
    expect(r.found).toBe(false)
  })

  it('③ 漏杀对照：守卫支里摘掉 setImportExternal(null) 必须报「不清弹窗」', () => {
    const real = fs.readFileSync(FILE, 'utf8')
    expect(real).toContain('setImportExternal(null)')
    // 只摘守卫支那一处（成功分支末尾还有一处正常清理，用带缩进的守卫支原文定位）
    const fake = real.replace('        setImportExternal(null)\n        return', '        return')
    const r = scan(fake)
    expect(r.found).toBe(true)
    expect(r.clearsDialog).toBe(false)
  })
})
