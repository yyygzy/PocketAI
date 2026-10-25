// V4-Iter-311（源码级闸门）：§309 同族那五处收口之后，**每个分支的写点前面都要有归属判据**
//
// 为什么还要一道闸门（行为用例已经跑了五处）：行为用例只能演"成功支迟到"这一张脸；
// 每处其实有 2~4 个写点分支（成功支／失败支／`.catch`／轮询 tick／`finally`），
// 摘掉其中任何一支的守卫，那条用例照样绿。这道闸门盯的就是"每一支各自的守卫"。
//
// 判据形状（照 §309 的 ChatModule 闸门，两处刻意收紧）：
//   · **读条件结构，不数 token**：只认顶层是 `X !== Y` 或 `X === Y` 的二元式，
//     左边是 `<某Ref>.current`、右边是标识符。`if (false && …Ref.current !== …)` 必须算没守卫
//     （§266 的 Z7 那一族：只数 token 的判据对这种写法是瞎的）。
//   · **同一语句块内的守卫才算数**：写点要么前面（同块）已有 `!== … return` 早退，
//     要么整块被包在 `=== …` 那个 if 里；然后逐层往上退。
//     这条是关键——只按"文件里/函数里出现过守卫"算的话，`try` 里那句会把 `catch` 支也"挡"住，
//     而 catch 支里删掉守卫照样绿。用例③ 就是专打这一条的漏杀对照。
//
// 登记表面向"注册表"而不是行号（行号会腐）：文件名 → 认可的归属 ref 名单 ＋ 该屏的选中项级写者名单。
// 写者名单之外的一律不看（`setEditing`／`setBusy` 这类局部 UI state 谎报不了"是哪个选中项"）；
// 同步那一步的写（派发前的 `setLoading(true)`）也不算——本族只管"等过东西之后"的那几次写。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')

/** 本族的"选中项级 state"写者：迟到响应画错的就是这几个。
 * `refs` 是认可的归属判据 ref 名单——KbAskPanel 那屏有两条归属轴（点开的会话 id 与本轮请求 id），
 * 两个都是"这一发是不是还给当前这件事"，只是键不同（流式那几支按 requestId 挡）。 */
const SITES: Array<{ file: string; refs: string[]; writers: string[] }> = [
  { file: 'src/renderer/src/modules/knowledge/KnowledgeModule.tsx', refs: ['kbIdRef'], writers: ['setDocs', 'setReadErr'] },
  { file: 'src/renderer/src/modules/knowledge/KbAskPanel.tsx', refs: ['openedSessionRef', 'requestRef'], writers: ['setSessionId', 'setSessionCreatedAt', 'setMsgs'] },
  { file: 'src/renderer/src/components/RemindersModal.tsx', refs: ['tabRef'], writers: ['setItems', 'setLoadErr'] },
  { file: 'src/renderer/src/modules/files/FilesModule.tsx', refs: ['dirRef'], writers: ['setEntries', 'setLoading'] },
  { file: 'src/renderer/src/modules/notes/NotesModule.tsx', refs: ['keywordRef'], writers: ['setNotes', 'setLoadError'] }
]

interface Write {
  file: string
  /** 最近的外层具名函数（`loadDocs`／`reload`／`load`…；行号会腐，函数名不会） */
  fn: string
  setter: string
  line: number
  /** 挡住它的机关（没挡住 = undefined） */
  coveredBy?: string
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** `<某Ref>.current` 与标识符比对的 if；`!==` 早退＝挡，`===` 包住＝放行（两种操作数顺序都认） */
function guardOf(ifNode: ts.IfStatement, refList: string[]): 'skip' | 'same' | undefined {
  const cond = ifNode.expression
  if (!ts.isBinaryExpression(cond)) return undefined
  const kind = cond.operatorToken.kind
  // ⚠ 38/36 是 `!==`／`!=`，107/106 是 `===`／`==`（SyntaxKind 的命名一格都别记错）
  const ne = kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken
  const eq = kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken
  if (!ne && !eq) return undefined
  const keySide = (n: ts.Node): boolean => ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)
  const isRefAccess = (n: ts.Node): boolean =>
    ts.isPropertyAccessExpression(n) && n.name.text === 'current'
    && ts.isIdentifier(n.expression) && refList.includes(n.expression.text)
  if (!((isRefAccess(cond.left) && keySide(cond.right)) || (keySide(cond.left) && isRefAccess(cond.right)))) return undefined
  return ne ? 'skip' : 'same'
}

function enclosingFn(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node.parent
  while (cur && !(ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur))) {
    cur = cur.parent
  }
  return cur
}

/**
 * 这一句写点是不是"迟到响应里"的写——三种都算：
 *   · 挂在 `.then`／`.catch`／`.finally` 的回调里；
 *   · 挂在 `setInterval`／`setTimeout` 的回调里（轮询那一发同理）；
 *   · 所在函数是 async，且**在它之前**有 `await`（同函数里在它之后的 await 不算——那是另一段同步逻辑）。
 * 不算本族的：派发前的同步写（如 `setLoading(true)`）与事件处理里的同步写。
 */
function isLate(write: ts.Node): boolean {
  const fn = enclosingFn(write)
  if (!fn) return false
  const owner = fn.parent
  if (owner && ts.isCallExpression(owner)) {
    const callee = owner.expression
    if (ts.isPropertyAccessExpression(callee) && ['then', 'catch', 'finally'].includes(callee.name.text)) return true
    if (ts.isIdentifier(callee) && ['setInterval', 'setTimeout'].includes(callee.text)) return true
  }
  let sawAwaitBefore = false
  walk(fn, (inner) => {
    if (sawAwaitBefore) return
    if (ts.isAwaitExpression(inner) && inner.getStart() < write.getStart()) sawAwaitBefore = true
  })
  return sawAwaitBefore
}

function nearestFnName(node: ts.Node, sf: ts.SourceFile): string {
  let cur: ts.Node = node
  while (cur.parent) {
    const p = cur.parent
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if (ts.isMethodDeclaration(p) && p.name) return p.name.getText(sf)
    cur = p
  }
  return '(module)'
}

/**
 * 这一句写点被挡住吗：从它所在的语句块往上逐层看
 *  · 同块里在它之前有 `!== … return` 早退 ⇒ 挡住
 *  · 该块整体是 `=== …` 那个 if 的 then 支 ⇒ 挡住
 * （必须同块：`try` 里的守卫挡不住 `catch` 支，所以只认同一份语句清单里的先前位置）
 */
function coverageOf(write: ts.Node, sf: ts.SourceFile, refList: string[]): string | undefined {
  let anchor: ts.Node = write
  let block: ts.Node | undefined = write.parent
  while (block && !ts.isSourceFile(block)) {
    const stmts: readonly ts.Statement[] | undefined =
      ts.isBlock(block) ? Array.from(block.statements)
        : ts.isCaseClause(block) || ts.isDefaultClause(block) ? Array.from(block.statements)
          : undefined
    if (stmts) {
      let up: ts.Node = anchor
      while (up.parent !== block) up = up.parent
      const idx = stmts.findIndex((s) => s === up)
      for (let i = 0; i < idx; i++) {
        const st = stmts[i]
        if (!st || !ts.isIfStatement(st)) continue
        if (guardOf(st, refList) === 'skip' && ts.isReturnStatement(st.thenStatement)) {
          return `早退守卫 :${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}`
        }
      }
      // 整块被包在 `=== …` 那个 if 的 then 支里
      const owner: ts.Node | undefined = block.parent
      if (owner && ts.isIfStatement(owner) && owner.thenStatement === block && guardOf(owner, refList) === 'same') {
        return `同一性分支 :${sf.getLineAndCharacterOfPosition(owner.getStart(sf)).line + 1}`
      }
    }
    // then 支不是 Block 的单语句 if（FilesModule 的 finally：`if (dirRef.current === dir) setLoading(false)`）
    const parentIf = anchor.parent
    if (parentIf && ts.isIfStatement(parentIf) && parentIf.thenStatement === anchor && guardOf(parentIf, refList) === 'same') {
      return `同一性分支 :${sf.getLineAndCharacterOfPosition(parentIf.getStart(sf)).line + 1}`
    }
    anchor = block
    block = block.parent
  }
  return undefined
}

function scanFile(rel: string, refs: string[], writers: string[], src?: string): Write[] {
  const text = src ?? fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: Write[] = []
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
    const setter = node.expression.text
    if (!writers.includes(setter)) return
    // 函数式补丁（`setNotes((prev) => …)` 这类）改的是"其中一条"、不整屏替换 ⇒ 谎报不了"这是哪个选中项"，
    // 不属本族；笔记屏的增删改后置更新正好是这一形，故要认出来（否则闸门会把它们一起逼着加守卫）
    const firstArg = node.arguments[0]
    if (firstArg && (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))) return
    if (!isLate(node)) return // 派发前那一步的同步写不属本族
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    out.push({
      file: rel,
      fn: nearestFnName(node, sf),
      setter,
      line,
      coveredBy: coverageOf(node, sf, refs)
    })
  })
  return out
}

const ALL = SITES.flatMap((s) => scanFile(s.file, s.refs, s.writers))

describe('§311 迟到响应的归属判据（五处收口之后的源码级闸门）', () => {
  it('注册表五处都扫得到写点（防检测器退化成"什么都没看见"）', () => {
    const byFile = new Map<string, number>()
    ALL.forEach((w) => byFile.set(w.file, (byFile.get(w.file) ?? 0) + 1))
    expect([...byFile.keys()].sort()).toEqual(SITES.map((s) => s.file).sort())
    SITES.forEach((s) => {
      expect(byFile.get(s.file) ?? 0, `${s.file} 的写点数`).toBeGreaterThan(0)
    })
  })

  it('每一个写点前头都站着归属判据（含失败支、`.catch`、轮询 tick、`finally`）', () => {
    const bare = ALL.filter((w) => !w.coveredBy)
    expect(
      bare.map((w) => `${path.basename(w.file)} ${w.fn}() 的 ${w.setter}@${w.line}`),
      `没守卫就写选中项级 state：\n${bare.map((w) => `${w.file} ${w.fn} ${w.setter}@${w.line}`).join('\n')}`
    ).toEqual([])
  })

  it('漏杀对照：摘成功支／只摘 `.catch` 支／摘轮询 tick／换成 false && 中和／挪到写之后——五种都必须判成没守卫', () => {
    const site = SITES[0]! // 注册表第一项（取不到就是注册表被改坏了）
    const kbSrc = fs.readFileSync(path.join(ROOT, site.file), 'utf8')
    const nl = kbSrc.includes('\r\n') ? '\r\n' : '\n'
    const lines = kbSrc.split(nl)
    const GUARD = 'if (kbIdRef.current !== kb.id) return'
    const scan = (arr: string[]): Write[] => scanFile(site.file, site.refs, site.writers, arr.join(nl))
    const bare = (arr: string[], fn: string): Write[] => scan(arr).filter((w) => !w.coveredBy && w.fn === fn)
    const guardText = lines.find((l) => l.trim() === GUARD)
    if (!guardText) throw new Error('守卫那句取不到（源码形状变了，对照要跟着改）')

    // ① 摘掉 loadDocs 成功支那一句（`.then` 里第一道守卫）⇒ 那一支的写点全裸
    const thenGuard = lines.findIndex((l, i) => l.trim() === GUARD && (lines[i + 1] ?? '').trim().startsWith('if (hasIpcFailed(v))'))
    expect(thenGuard, '成功支那句守卫要找得到（源码形状变了，对照要跟着改）').toBeGreaterThan(-1)
    const removed = [...lines]
    removed.splice(thenGuard, 1)
    expect(bare(removed, 'loadDocs').length, '摘掉守卫必须判成没守卫').toBeGreaterThanOrEqual(3)

    // ② 留着这句、换成 false && 中和（§266 Z7 那一族：只数 token 的判据对这种写法是瞎的）
    const neutered = [...lines]
    neutered[thenGuard] = guardText.replace('if (kbIdRef', 'if (false && kbIdRef')
    expect(bare(neutered, 'loadDocs').length, 'false && 中和必须判成没守卫').toBeGreaterThanOrEqual(3)

    // ③ **只摘 `.catch` 支那一句**（成功支留着）：这一支必须单独算，不能借 try 里兄弟守卫的光
    const catchGuard = lines.findIndex((l, i) => l.trim() === GUARD && (lines[i + 1] ?? '').trim().startsWith('setReadErr(errText'))
    expect(catchGuard, '失败支那句守卫要找得到').toBeGreaterThan(thenGuard)
    const catchOnly = [...lines]
    catchOnly.splice(catchGuard, 1)
    expect(bare(catchOnly, 'loadDocs').map((w) => `${w.setter}@${w.line}`).join(','), '失败支的写点必须各自有守卫（同块的早退才算）')
      .toContain('setReadErr')

    // ④ 守卫还在、但挪到写之后（谎已经画出去了才判归属）
    const moved = [...lines]
    moved.splice(thenGuard, 1)
    const writeIdx = moved.findIndex((l) => l.trim() === 'setDocs(v)')
    expect(writeIdx, 'setDocs(v) 那句要找得到').toBeGreaterThan(-1)
    moved.splice(writeIdx + 1, 0, guardText)
    expect(bare(moved, 'loadDocs').length, '守卫排在写之后必须判成没守卫').toBeGreaterThanOrEqual(1)

    // ⑤ 轮询那一发的守卫是独立一处（清理 effect 只 clearInterval，拦不住已发出的那一发）
    const pollGuard = lines.findIndex((l, i) => l.trim() === GUARD && (lines[i + 1] ?? '').trim().startsWith('if (!list'))
    expect(pollGuard, '轮询 tick 那句守卫要找得到').toBeGreaterThan(catchGuard)
    const noPoll = [...lines]
    noPoll.splice(pollGuard, 1)
    expect(bare(noPoll, 'startPolling').map((w) => `${w.setter}@${w.line}`).join(','), '轮询支的写点也要各自有守卫').toContain('setDocs')
  })

  it('反向对照：新添一处没守卫的迟到写点时，扫描必须看得见它（防判据恒返回"都挡住了"）', () => {
    const fil = SITES[3]!
    const src = fs.readFileSync(path.join(ROOT, fil.file), 'utf8')
    const nl = src.includes('\r\n') ? '\r\n' : '\n'
    const withNewSite = `${src}${nl}const __probeLateSite = async (): Promise<void> => {${nl}  const v = await window.pocketai.listFiles('probe')${nl}  setEntries(v)${nl}}${nl}`
    const found = scanFile(fil.file, fil.refs, fil.writers, withNewSite)
    const probe = found.filter((w) => w.fn === '__probeLateSite')
    expect(probe.length, '新的迟到写点要进名单（不算同步写）').toBe(1)
    expect(probe[0]?.coveredBy, '而它没有守卫 ⇒ 必须判成裸写').toBeUndefined()
  })
})
