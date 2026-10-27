// V4-Iter-330（源码级闸门）：导出族那四处没人管的形状
//
// 为什么这几面只做源码级：`ChatModule` / `AgentPanel` / `ChatView` 全仓没有挂载用例（整棵树代价不成比例，
// 边界记在台账 §253／记忆「清单零覆盖待补」），而 `KbAskPanel` 那两发的**行为**已经由
// `tests/kb-ask-session-envelope-330.test.tsx` 真挂载跑到了；这里补的是"另外几处同族形状不许漂回去"：
//   ① 通道类型诚实化：`getKbAskSession` 的 preload 返回类型必须带失败分支，且两个调用点各自"判了并接管"
//      （第五面口径：条件里有 isIpcFail、体内有 return、也说了话）；
//   ② 批量导出那颗锁：两屏各有 `if (batchBusyRef.current) return` ＋ finally 里解锁（改前 Agent 那屏根本没锁）；
//   ③ 多选消息导出那道大小闸与拖出通道同源（不许再写回 5MB 字面量）；
//   ④ 加密导出那发：KDF 必须排在保存对话框**与**「取消就 return」之后（改前点完先等一轮 PBKDF2 才弹框）。
// 计数一律读 AST（第 33 条：注释里也写着同一串）。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const SRC = (p: string): string => path.resolve(__dirname, '..', 'src', p)
/** 读源码并把 CRLF 归一成 LF：conversations.ts / preload 是 w/crlf，
 *  多行锚点与偏移量都得在同一套行尾上算（第 33 条那次 SKIP 的复发防线）。 */
const read = (p: string): string => fs.readFileSync(SRC(p), 'utf8').replace(/\r\n/g, '\n')

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(SRC(file), src, ts.ScriptTarget.Latest, true)
}

/** 条件文本含 judge 的那条 if，体内是否有提前 return 与「说话」调用 */
function judgedIf(src: string, file: string, judge: string, speaks: string[]): Array<{ hasReturn: boolean; speaks: string | null }> {
  const sf = parse(file, src)
  const out: Array<{ hasReturn: boolean; speaks: string | null }> = []
  walk(sf, (n) => {
    if (!ts.isIfStatement(n)) return
    if (!n.expression.getText().includes(judge)) return
    let hasReturn = false
    const found: string[] = []
    walk(n.thenStatement, (m) => {
      if (ts.isReturnStatement(m)) hasReturn = true
      if (ts.isCallExpression(m)) {
        const t = m.expression.getText()
        if (speaks.includes(t)) found.push(t)
      }
    })
    out.push({ hasReturn, speaks: found[0] ?? null })
  })
  return out
}

// ---------- ① getKbAskSession：类型诚实＋两处调用各自判了并接管 ----------
const PRELOAD = 'preload/index.ts'
const PANEL = 'renderer/src/modules/knowledge/KbAskPanel.tsx'

function preloadGetKbAskSessionType(src: string): string | null {
  const sf = parse(PRELOAD, src)
  let typeText: string | null = null
  walk(sf, (n) => {
    if (!ts.isPropertyAssignment(n)) return
    if (!ts.isIdentifier(n.name) || n.name.text !== 'getKbAskSession') return
    const sig = n.initializer
    if (ts.isArrowFunction(sig) && sig.type) typeText = sig.type.getText(sf)
  })
  return typeText
}

/** 该文件里 `window.pocketai.getKbAskSession(...)` 每一处所在函数里有没有 isIpcFail 判定 */
function callSiteJudgements(src: string): number {
  const sf = parse(PANEL, src)
  let sites = 0
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return
    if (!n.expression.getText().endsWith('.getKbAskSession')) return
    sites += 1
    // 往上找到最近的函数体，判它里面有没有对这一发结果做的 isIpcFail 判定
    let up: ts.Node | undefined = n.parent
    let fn: ts.Node | null = null
    while (up) {
      if (ts.isArrowFunction(up) || ts.isFunctionDeclaration(up) || ts.isFunctionExpression(up)) {
        fn = up
        break
      }
      up = up.parent
    }
    expect(fn, 'getKbAskSession 的调用点不在任何函数体内（闸门要看一眼）').toBeTruthy()
    let judged = false
    walk(fn!, (m) => {
      if (ts.isCallExpression(m) && m.expression.getText() === 'isIpcFail') judged = true
    })
    expect(judged, `第 ${sites} 处 getKbAskSession 没有 isIpcFail 判定 ⇒ 失败对象会被当记录用`).toBe(true)
  })
  return sites
}

// ---------- ② 两屏那颗批量锁 ----------
const CHAT = 'renderer/src/modules/chat/ChatModule.tsx'
const AGENT = 'renderer/src/modules/agent/chat/AgentPanel.tsx'

function busyGuard(src: string, file: string): { guards: number; releases: number } {
  const sf = parse(file, src)
  let guards = 0
  let releases = 0
  walk(sf, (n) => {
    if (ts.isIfStatement(n) && n.expression.getText().includes('batchBusyRef.current')) {
      let ret = false
      walk(n.thenStatement, (m) => {
        if (ts.isReturnStatement(m)) ret = true
      })
      expect(ret, 'batchBusyRef 的守卫没写 return ⇒ 拦不住第二发').toBe(true)
      guards += 1
    }
    if (ts.isTryStatement(n) && n.finallyBlock) {
      walk(n.finallyBlock, (m) => {
        if (
          ts.isBinaryExpression(m) &&
          m.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          m.left.getText() === 'batchBusyRef.current'
        ) releases += 1
      })
    }
  })
  return { guards, releases }
}

describe('330 ① getKbAskSession：类型带失败分支，两处调用都判了并接管', () => {
  it('preload 的返回类型写着 ok:false 那一支（只写 `Record | null` 就是撒谎）', () => {
    const typeText = preloadGetKbAskSessionType(read(PRELOAD))
    expect(typeText, '找不到 getKbAskSession 的声明').not.toBeNull()
    expect(typeText!).toContain('ok: false')
  })

  it('两个调用点各有 isIpcFail 判定，且判完就提前 return＋说一句话', () => {
    expect(callSiteJudgements(read(PANEL))).toBe(2)
    const ifs = judgedIf(read(PANEL), PANEL, 'isIpcFail', ['toast.error'])
    expect(ifs).toHaveLength(2)
    for (const f of ifs) {
      expect(f.hasReturn, '判了不接管＝失败照样往下走').toBe(true)
      expect(f.speaks, '接管了却没说话').toBe('toast.error')
    }
  })

  it('漏杀对照：类型改回撒谎／判定改空壳，判据各判红一处', () => {
    const lying = read(PRELOAD).replace(
      '| null\n    | { ok: false; error: string; ipcCode?: string; ipcArgs?: unknown[] }',
      '| null'
    )
    expect(lying, '手术没落到盘上＝对照无效').not.toBe(read(PRELOAD))
    expect(preloadGetKbAskSessionType(lying)).not.toContain('ok: false')

    const hollow = read(PANEL).replace(
      'if (isIpcFail(rec)) {\n          toast.error(ipcFailText(rec, t(\'common.unknownError\')))\n          return\n        }',
      'if (isIpcFail(rec)) {\n          console.log(rec)\n        }'
    )
    expect(hollow, '手术没落到盘上＝对照无效').not.toBe(read(PANEL))
    const ifs = judgedIf(hollow, PANEL, 'isIpcFail', ['toast.error'])
    expect(ifs.filter((f) => f.hasReturn && f.speaks === 'toast.error'), '空壳判定（只 console.log、不 return）不许算接管').toHaveLength(1)
  })
})

describe('330 ② 两屏各有那颗批量锁（连点两下不许开两批）', () => {
  it.each([[CHAT, 'ChatModule'], [AGENT, 'AgentPanel']] as const)('%s 有守卫且在 finally 里解锁', (file, name) => {
    const { guards, releases } = busyGuard(read(file), file)
    expect(guards, `${name} 的 batchBusyRef 守卫数`).toBe(1)
    expect(releases, `${name} 在 finally 里解锁的次数（漏解锁＝一次失败后这颗键永远按不动）`).toBe(1)
  })

  it('漏杀对照：守卫挪到 finally 之外不解锁 ⇒ 计数判红', () => {
    const noRelease = read(AGENT).replace(
      'batchBusyRef.current = false\n      setBatchProgress(null)',
      'setBatchProgress(null)'
    )
    expect(noRelease, '手术没落到盘上＝对照无效').not.toBe(read(AGENT))
    expect(busyGuard(noRelease, AGENT).releases, '漏解锁）。').toBe(0)
  })
})

describe('330 ③ 多选消息导出那道闸与拖出通道同源', () => {
  const HANDLER_TEXT = () => {
    const src = read('main/ipc/handlers/conversations.ts')
    const at = src.indexOf('IPC.CONVERSATION_EXPORT_MESSAGES,')
    expect(at).toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('safeHandle', at + 10))
  }

  it('content 的上限引用 DRAG_CONTENT_MAX_CHARS（不再是 5MB 字面量）', () => {
    const body = HANDLER_TEXT()
    expect(body).toContain('max(DRAG_CONTENT_MAX_CHARS)')
    expect(body).not.toContain('5 * 1024 * 1024')
  })

  it('漏杀对照：写回一个字面量等值（5×1024×1024）形状就不合规', () => {
    const back = HANDLER_TEXT().replace('max(DRAG_CONTENT_MAX_CHARS)', 'max(5 * 1024 * 1024)')
    expect(back).not.toContain('max(DRAG_CONTENT_MAX_CHARS)')
  })
})

describe('330 ④ 加密导出：KDF 排在对话框与「取消就 return」之后', () => {
  const offsets = (): { dialog: number; cancelReturn: number; kdf: number } => {
    const src = read('main/ipc/handlers/conversations.ts')
    const at = src.indexOf('IPC.CONVERSATION_EXPORT_ENCRYPTED,')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('safeHandle', at + 10))
    const dialog = body.indexOf('showSaveDialog')
    const cancelReturn = body.indexOf('if (canceled || !filePath) return')
    const kdf = body.indexOf('encryptWithPassword')
    return { dialog, cancelReturn, kdf }
  }

  it('顺序：弹框 < 取消即返回 < KDF（取消那一趟一轮 KDF 都不做）', () => {
    const o = offsets()
    expect(o.dialog).toBeGreaterThan(-1)
    expect(o.cancelReturn).toBeGreaterThan(o.dialog)
    expect(o.kdf).toBeGreaterThan(o.cancelReturn)
  })

  it('漏杀对照：KDF 挪回对话框之前（改前形状）判红', () => {
    const src = read('main/ipc/handlers/conversations.ts')
    const moved = src.replace(
      'const safeName = safeFileName(conv.title)\n    const { canceled, filePath } = await dialog.showSaveDialog',
      'const encrypted = encryptWithPassword(password, JSON.stringify(payload))\n    const safeName = safeFileName(conv.title)\n    const { canceled, filePath } = await dialog.showSaveDialog'
    )
    expect(moved, '手术没落到盘上＝对照无效').not.toBe(src)
    const at = moved.indexOf('IPC.CONVERSATION_EXPORT_ENCRYPTED,')
    const body = moved.slice(at, moved.indexOf('safeHandle', at + 10))
    expect(body.indexOf('encryptWithPassword'), 'KDF 仍在弹框之前 ⇒ 闸门必须红').toBeLessThan(body.indexOf('showSaveDialog'))
  })
})
