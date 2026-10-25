// V4-Iter-309（ChatModule 面）：会话级迟到响应必须有身份守卫，且守卫在写状态**之前**
//
// 为什么这一面只做源码级闸门：全仓没有挂载 `ChatModule` 的用例（整棵树的代价不成比例，见台账 §253
// 记的挂载面边界），所以那两发的"迟到响应不许画进当前屏"只能读源码判。Agent 面（useAgentChat）
// 有真 hook 行为用例 tests/agent-conversation-switch-race-309.test.tsx，两条路各守各的屏。
//
// 判据取自本文件自己立过的规矩（§264）：`if (currentConvRef.current !== id) return`
// ——「这一发是不是还给当前会话」。§309 把它接进 loadMessages（那一发过去没人挡，A 的消息会整棵
// 画进 B 的屏，而侧栏还高亮着 B）。
//
// 三条口径都是量过才定的：
//   · **只盯会话级 state 的写点**（`setMessages`／`setMsgsReadErr`／`setActiveDraft`）：
//     迟到响应谎报的是"这条会话的内容"。`setConversations` 那种整张列表的写点不属于某一条会话，
//     本批判为不同族、不计进来（现扫另有三处 `setConversations` 的 `.then`，见台账 §309）。
//   · **守卫要在第一次写之前**：写成"第一句"会误伤 loadDraft（§264 的写法是先判 `hasIpcFailed`
//     再判身份，两支各一句），而"在写之前"才是这条判据真正要钉的东西。
//   · **条件要读结构，不数 token**：只认顶层是 `X !== Y` 的二元式（左边是 `…Ref.current`、
//     右边是标识符、then 支是裸 `return`）。`if (false && …Ref.current !== id)` 这种被中和的写法
//     必须算没守卫——§266 的 Z7 就是栽在只数 token 上（把渲染守卫换成 `false &&` 仍能绿）。
// 用例③把这三条各演一遍漏杀对照（真文件改出来的三份假源码），防扫描器退化成"恒返回有守卫"。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const FILE = path.resolve(__dirname, '../src/renderer/src/modules/chat/ChatModule.tsx')

/** 会话级 state 的写点：迟到响应画错屏，写的就是这几个 */
const CONVERSATION_SCOPED_SETTERS = ['setMessages', 'setMsgsReadErr', 'setActiveDraft']

interface LateSite {
  /** `.then` 挂在哪个 IPC 通道上（红因要用通道名，别用会腐的行号） */
  channel: string
  /** 这一支写了哪些会话级 state */
  writes: string[]
  /** 第一次写之前有没有身份守卫 */
  guarded: boolean
  /** 命中的守卫条件原文（没命中时给出最近一句 if 的原文，方便看红因） */
  guardCond: string
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** `window.pocketai.listMessages(id).then(cb)` 里的通道名 */
function channelOf(thenCall: ts.CallExpression): string | undefined {
  const receiver = thenCall.expression
  if (!ts.isPropertyAccessExpression(receiver)) return undefined
  const target = receiver.expression
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    return target.expression.name.text
  }
  return undefined
}

/** 身份守卫的形状：`if (<某Ref>.current !== <标识符>) return`（then 支必须是裸 return） */
function isIdentityGuard(stmt: ts.Statement): string | undefined {
  if (!ts.isIfStatement(stmt)) return undefined
  if (!ts.isReturnStatement(stmt.thenStatement) || stmt.thenStatement.expression) return undefined
  const cond = stmt.expression
  // 38 而不是 36：SyntaxKind 的命名里 `ExclamationEqualsToken` 是 `!=`，`!==` 叫
  // `ExclamationEqualsEqualsToken`——写错这一格，整个判据对真源码恒返回"没守卫"（现编现抓到的）。
  if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return undefined
  const left = cond.left
  if (!ts.isPropertyAccessExpression(left) || left.name.text !== 'current') return undefined
  if (!ts.isIdentifier(left.expression) || !/Ref$/.test(left.expression.text)) return undefined
  if (!ts.isIdentifier(cond.right)) return undefined
  return cond.getText()
}

function scan(src: string): LateSite[] {
  const sf = ts.createSourceFile('scan.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: LateSite[] = []
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return
    const prop = node.expression
    if (!ts.isPropertyAccessExpression(prop) || prop.name.text !== 'then') return
    const cbArg = node.arguments[0]
    if (!cbArg || !(ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg))) return
    const body = cbArg.body
    if (!body || !ts.isBlock(body)) return

    const writes: string[] = []
    let firstWrite: ts.Node | undefined
    let firstWriteName = ''
    walk(body, (inner) => {
      if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return
      const name = inner.expression.text
      if (!CONVERSATION_SCOPED_SETTERS.includes(name)) return
      if (!writes.includes(name)) writes.push(name)
      if (!firstWrite || inner.getStart(sf) < firstWrite.getStart(sf)) {
        firstWrite = inner
        firstWriteName = name
      }
    })
    if (!firstWrite) return

    const channel = channelOf(node)
    if (!channel) return

    let guarded = false
    let guardCond = ''
    for (const stmt of Array.from(body.statements)) {
      const cond = isIdentityGuard(stmt)
      if (cond === undefined) {
        if (!guardCond && ts.isIfStatement(stmt)) guardCond = stmt.expression.getText()
        continue
      }
      if (stmt.getStart(sf) < firstWrite.getStart(sf)) {
        guarded = true
        guardCond = cond
      }
      break
    }
    out.push({ channel, writes, guarded, guardCond: `${guardCond}（首写 ${firstWriteName}）` })
  })
  return out.sort((a, b) => a.channel.localeCompare(b.channel))
}

const SRC = fs.readFileSync(FILE, 'utf8')
// 按行手术，不按字符串：这棵树的工作副本目前是 LF，但 autocrlf 之后可能翻成 CRLF，
// 那时 `SRC.replace('...return\n', '')` 会静默不命中 ⇒ 三份假源码都等于原文件、对照全废。
const nl = SRC.includes('\r\n') ? '\r\n' : '\n'

describe('§309 ChatModule 会话级迟到响应的身份守卫（源码级闸门）', () => {
  it('会话级迟到写点恰是 listMessages／getConversationDraft 两处（新增了就得进来判一遍）', () => {
    expect(scan(SRC).map((s) => s.channel)).toEqual(['getConversationDraft', 'listMessages'])
  })

  it('两处都在第一次写会话级 state 之前挡下迟到响应', () => {
    const bare = scan(SRC).filter((s) => !s.guarded)
    expect(bare, `没守卫就写会话级 state：${bare.map((s) => `${s.channel} 写 ${s.writes.join('/')}`).join('；')}`).toEqual([])
  })

  it('漏杀对照：摘掉守卫／换成 false && 中和／守卫挪到写之后——三种都得判成没守卫', () => {
    const lines = SRC.split(nl)
    const guardIdx = lines.findIndex((l) => l.trim() === 'if (currentConvRef.current !== convId) return')
    const writeIdx = lines.findIndex((l) => l.trim() === 'setMessages(v)')
    const guardLine = lines[guardIdx]
    if (!guardLine) throw new Error('守卫那句找不到（源码形状变了，三份对照要跟着改）')
    expect(writeIdx, 'setMessages(v) 那句要找得到').toBeGreaterThan(guardIdx)
    const scanLines = (arr: string[]): LateSite[] => scan(arr.join(nl))

    // ① 整句摘掉（§309 修前的形状）
    const removed = [...lines]
    removed.splice(guardIdx, 1)
    expect(scanLines(removed).find((s) => s.channel === 'listMessages')?.guarded, '摘掉守卫必须判成没守卫').toBe(false)

    // ② 留着这句、但把它中和（§266 Z7 那一族：只数 token 的判据对这种写法是瞎的）
    const neutered = [...lines]
    neutered[guardIdx] = guardLine.replace('if (currentConvRef', 'if (false && currentConvRef')
    expect(scanLines(neutered).find((s) => s.channel === 'listMessages')?.guarded, 'false && 中和必须判成没守卫').toBe(false)

    // ③ 守卫还在、但挪到写之后（先画屏再判归属＝谎已经说出口了）
    const moved = [...lines]
    moved.splice(guardIdx, 1)
    const w = moved.findIndex((l) => l.trim() === 'setMessages(v)')
    moved.splice(w, 0, guardLine)
    expect(scanLines(moved).find((s) => s.channel === 'listMessages')?.guarded, '守卫排在写之后必须判成没守卫').toBe(false)
  })

  it('反向对照：新添一处会话级迟到写点时，"恰是两处"那条必须看得见它（防扫描器恒返回两份）', () => {
    const extra = `${SRC}${nl}const __probeSite = (id: string): void => {${nl}  window.pocketai.getConversationPin(id).then((v) => {${nl}    setActiveDraft(v)${nl}  })${nl}}${nl}`
    expect(scan(extra).map((s) => s.channel), '新站点要进名单，并且按同一判据判成没守卫').toEqual(['getConversationDraft', 'getConversationPin', 'listMessages'])
    expect(scan(extra).find((s) => s.channel === 'getConversationPin')?.guarded).toBe(false)
  })
})
