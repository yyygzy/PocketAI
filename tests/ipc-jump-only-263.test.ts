// V4-Iter-263：闸门第五面——**判了、也停了，但界面什么都不说**。
//
// 为什么要第五面：第四面（§250）问的是"判了失败面有没有接管"，而它把**任何流程接管**都算数——
// `return`／`throw`／`break`／`continue` 都算（§250 定的口径，改它会直接把 CAP 从 42 炸开）。
// 于是 `if (hasIpcFailed(x)) return` 一路绿灯：流程确实停了，没有把失败对象当数据用，也没有崩。
// §256 当时就把这一档记成空子：「失败侧只有一句 return 被算作接管——向导与管家页的 `getHardwareInfo`
// 正是实例（界面仍整块不出现）」。这一面量的是下一层：**停下来的那一瞬间，屏上留下了什么**。
//
// 判据（两条都必要，缺一面就废）：
//   ① 失败侧**只有流程跳**，且跳转**不携带可见出口**——`return showNotice(false, …)` 那种是把话说了再走，
//      `throw` 落在一个会说话的 `catch` 里（SettingsModule 字号／折叠行数那两处就是交给 catch 做回滚＋通知）也不在内；
//   ② 这个 if 的**成功那一支会写状态**（`setX(…)`／赋值／`const`／通知）。
//      ② 才是关键：成功支写状态说明这份数据本来要上屏，失败支什么都不写 ⇒ 那份状态**停在初值**，
//      界面于是把"没读到"演成"就是这样"——服务商列表停在 `[]`＝「一家都没有」，
//      草稿停在 `''`＝「这条没存过草稿」，锁状态停在 0＝「现在可以试」，统计停在 0＝「本次没花 token」。
//      反之成功支也不写状态（取个值给后面的动作用，或者只是往下走）⇒ 那就是 **fail-closed**：
//      点了没反应，没有假数字也没有假空态 ⇒ **不算谎报**，不进名单（`batch-export.ts` 那处正是这种）。
//
// 口径三条决定（都是量完才定的）：
//   · 「成功那一支」对**反判**是 then，对**正判**是 `else` 或 if 之后的同段语句——仍是**单条 if 视角**，
//     不做过程间／数据流分析（§250 同一条纪律：加那种规矩会把一面闸门变成半个编译器，读数不可复现）。
//   · 只有 `useState` 那类写状态的**形状**算，不看它最终渲染在哪——渲染消费者要靠用例逐处验（本批六处都配了真挂载）。
//   · 计数**按文件**不按行号（行号会漂），等式 ratchet：多了红（有人把收口改回只 return），少了也红（收口了没撤登记）。
//
// 本批实测数（`node data/tmp/scan-263.mjs`，与本文件同一套判据）：
//   开批 19 处 → §263 收口六处（绘图页／翻译页／知识库问答／浮窗三发）⇒ 13 → **§264 再收六处**
//   （锁状态／本次运行统计／会话累计统计／运行后刷新那一发／草稿读／向导助手清单）⇒ **现数 7**；
//   fail-closed 对照桶 **3** 处（7≠3 ⇒ 这条轴真的把两类分开，不是恒返回一个桶）。
//   修掉的判据假阳 4 处（三处 SettingsModule 的 `return showNotice(...)`／`throw` 交给会说话的 catch，
//   一处 FirstRunWizard 同形）——**先修判据再定名单**，否则名单里四条是噪音。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const RENDERER_DIR = 'src/renderer/src'

interface JumpSite {
  file: string
  line: number
  cond: string
  /** 失败侧原文 */
  body: string
  /** 成功那一支有没有写状态（② 那条判据） */
  successWrites: boolean
  negated: boolean
}

const VISIBLE_CALL = /^(set[A-Z]|Notice$|toast\.|showNotice|showIpcFailure|reportFailure|failOp)/

/** 与第四面同一套写法（六种），极性照旧：`negated:true` ⇒ 失败侧是 else */
function judged (cond: string): { v: string; negated: boolean } | null {
  const esc = (s: string) => s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
  const forms: Array<[RegExp, boolean | null]> = [
    [/!\s*(?:hasIpcFailed|isIpcFail)\(\s*([A-Za-z_$][\w$]*)/, true],
    [/(?:hasIpcFailed|isIpcFail)\(\s*([A-Za-z_$][\w$]*)/, false],
    [/([A-Za-z_$][\w$]*)\s*\.\s*ok\s*(?:===|!==)\s*(?:true|false)|(?:true|false)\s*(?:===|!==)\s*([A-Za-z_$][\w$]*)\s*\.\s*ok/, null],
    [/!\s*([A-Za-z_$][\w$]*)\s*\.\s*ok\b(?! *[!=.])(?! *[!=]=)/, false],
    [/([A-Za-z_$][\w$]*)\s*\.\s*ok\b(?! *[!=.])(?! *[!=]=)/, true]
  ]
  for (const [re, neg] of forms) {
    const m = cond.match(new RegExp(re.source, re.flags))
    if (!m) continue
    const v = m[1] ?? m[2]
    if (!v) continue
    if (neg === null) {
      const rhs = cond.match(new RegExp(esc(v) + '\\s*\\.\\s*ok\\s*(?:===|!==)\\s*(true|false)|(true|false)\\s*(?:===|!==)\\s*' + esc(v) + '\\s*\\.\\s*ok'))
      const isFalse = (rhs?.[1] ?? rhs?.[2]) === 'false'
      const neq = /\b[A-Za-z_$][\w$]*\s*\.\s*ok\s*!==/.test(cond)
      return { v, negated: isFalse ? neq : !neq }
    }
    return { v, negated: !!neg }
  }
  return null
}

const JUMPS = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement
])

/** 判据①：这一支是不是"只有流程跳，而且跳之前什么都没说" */
function jumpOnly (node: ts.Statement | ts.Block | undefined): boolean {
  if (!node) return false
  const stmts = ts.isBlock(node) ? Array.from(node.statements) : [node]
  if (stmts.length === 0) return false
  if (!stmts.every((s) => JUMPS.has(s.kind))) return false
  // `return showNotice(false, …)`／`return setX(…)`：话已经说了才走，不算"什么都不说"
  for (const s of stmts) {
    const expr = ts.isReturnStatement(s) ? s.expression : ts.isThrowStatement(s) ? s.expression : undefined
    if (!expr) continue
    let seen = false
    const hunt = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && VISIBLE_CALL.test(n.expression.getText().replace(/^void\s+/, ''))) seen = true
      ts.forEachChild(n, hunt)
    }
    hunt(expr)
    if (seen) return false
  }
  return true
}

/** 判据①的另一半：这个 `throw` 是不是交给一个**会说话**的 catch */
function caughtVisibly (node: ts.Node | undefined): boolean {
  if (!node || !ts.isThrowStatement(node)) return false
  let cur: ts.Node | undefined = node.parent
  while (cur && !ts.isTryStatement(cur)) cur = cur.parent
  const catchBlock = cur && ts.isTryStatement(cur) ? cur.catchClause?.block : undefined
  if (!catchBlock) return false
  let ok = false
  const hunt = (n: ts.Node): void => {
    if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
      if (VISIBLE_CALL.test(n.expression.expression.getText().replace(/^void\s+/, ''))) ok = true
    }
    ts.forEachChild(n, hunt)
  }
  hunt(catchBlock)
  return ok
}

/** 判据②：这段代码里有没有"写状态／发通知"的动作（与第四面同一套名字，不扩） */
function hasStateWrite (node: ts.Node | null | undefined): boolean {
  if (!node) return false
  let found = false
  const visit = (n: ts.Node): void => {
    if (ts.isExpressionStatement(n)) {
      const e = n.expression
      if (ts.isCallExpression(e) && VISIBLE_CALL.test(e.expression.getText().replace(/^void\s+/, ''))) found = true
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.getText()
        if (/=$/.test(op) && !/^(==|===)$/.test(op)) found = true
      }
    }
    if (ts.isVariableStatement(n)) found = true
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** 成功那一支：反判⇒then；正判⇒else，没有 else 就只看 **if 之后**的那些语句（不能把 `const r = await …` 那行自己算进去） */
function successSideWrites (node: ts.IfStatement, negated: boolean): boolean {
  if (negated) return hasStateWrite(node.thenStatement)
  if (node.elseStatement) return hasStateWrite(node.elseStatement)
  const blk = node.parent && (ts.isBlock(node.parent) || ts.isSourceFile(node.parent))
    ? (node.parent as ts.Block | ts.SourceFile)
    : null
  if (!blk) return false
  const i = blk.statements.indexOf(node)
  return blk.statements.slice(i + 1).some((s) => hasStateWrite(s))
}

function scanSource (file: string, code: string): JumpSite[] {
  const src = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const out: JumpSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const cond = node.expression.getText()
      const j = judged(cond)
      if (j) {
        const failNode = j.negated ? node.elseStatement : node.thenStatement
        const thrown = failNode && ts.isBlock(failNode) ? failNode.statements[0] : failNode
        if (jumpOnly(failNode) && !caughtVisibly(thrown)) {
          out.push({
            file,
            line: ts.getLineAndCharacterOfPosition(src, node.getStart(src)).line + 1,
            cond: cond.replace(/\s+/g, ' '),
            body: (failNode ?? node.thenStatement).getText().replace(/\s+/g, ' ').slice(0, 120),
            successWrites: successSideWrites(node, j.negated),
            negated: j.negated
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

/** 抹掉注释再扫：注释里的"读不到"不算界面做了什么（§217 同一条纪律） */
const blankComments = (code: string): string =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1}${' '.repeat(_m.length - p1.length - 1)}`)

const filesIn = (dir: string): string[] => {
  const abs = path.join(ROOT, dir)
  const out: string[] = []
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name)
    if (e.isDirectory()) out.push(...filesIn(path.relative(ROOT, p)))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'))
  }
  return out
}

const ALL = filesIn(RENDERER_DIR)
const SITES = ALL.flatMap((rel) => scanSource(rel, blankComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')).replace(/\r\n/g, '\n')))
/** 目标桶：失败侧什么都不说，而成功那支要写屏 ⇒ 屏上留初值＝谎 */
const LIE = SITES.filter((s) => s.successWrites)
/** 对照桶：fail-closed，点了没反应，不摆假东西 */
const FAIL_CLOSED = SITES.filter((s) => !s.successWrites)

/**
 * 等式 ratchet：收口一处就把它从这里减一格（改了产品码不改名单会红，反向也一样）。
 * §263 开批 19 → 收六处清单读 ⇒ 13；§264 再收六处（锁状态／两发统计／草稿／向导助手清单）⇒**现数 7**。
 * 7 条逐条回读过，理由在下面那份注释里；剩下的都是"少做一件事"或已有既有决定托底的那一档。
 */
const JUMP_LIE_CAP = 7

const JUMP_LIE_PER_FILE: Record<string, number> = {
  // 首启向导／换电脑检测那一发：读不到就**不弹**（不会弹一个假向导），屏上没有假数字。
  // 属于"少做一件事"而不是"报一个假状态"⇒ 登记；若要收，是一句「启动检测没读到」，口径待决策。
  'src/renderer/src/App.tsx': 1,
  // §264 收掉了那三发统计（本次运行／会话累计／运行后刷新——现在各挂一句＋一颗重试）。剩下两条：
  // :460 从历史消息回填 provider/model（读不到⇒模型栏不预选，**不摆假模型**，也是"少做一件事"）；
  // `getUiPrefs` 挂载恢复（读不到⇒用默认助手）——这正是 §226「当前显示的是默认值」那一族，
  //   但 §258 已在同一屏挂了那句写失败（「这次选的助手与会话没能记住」），**两句怎么共存是没定的口径**
  //   ⇒ 待决策，不为清零瞎改（同 §255／§256 处理"闸门看不见理由"那两处：登记，不改产品码迁就扫描器）。
  'src/renderer/src/modules/agent/hooks/useAgentChat.ts': 2,
  // `fetchModels`：既有决定（源码注释在位）——「拉取失败静默，Provider 配置问题在设置页有完整报错」。
  // 设计内，与 §256 判掉的那三处同类：本屏不摆假数字（模型列表保持上一份），只少一次刷新。
  'src/renderer/src/modules/agent/hooks/useProviderData.ts': 1,
  // §264 收掉了草稿那一读（那句现在挂在输入区上方＋可重试）。剩三条：
  // 回复通知开关（§223 明写「开关关闭／异常一律静默」——不发通知是 fail-safe 方向）；
  // 对话页那侧的 provider/model 回填（同 useAgentChat 那条，不摆假模型）；
  // 草稿**写**失败（§221 设计内：📝 不点亮就是它的可见出口，本地补丁不跑就是说实话）。
  'src/renderer/src/modules/chat/ChatModule.tsx': 3
}

/** 正向对照：这些文件必须**真的出现在名单里**（防"扫描器恒返回空"这种假绿，§250 同一条） */
const STILL_JUMP_SILENT_PROOF = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/modules/agent/hooks/useAgentChat.ts',
  'src/renderer/src/modules/agent/hooks/useProviderData.ts',
  'src/renderer/src/modules/chat/ChatModule.tsx'
]

/** 已收口的那些文件：必须**不在**名单里（改回只 `return` 就会红） */
const FIXED_THIS_BATCH = [
  // §263：挂载那一发服务商／助手／模型清单读
  'src/renderer/src/modules/image/ImageModule.tsx',
  'src/renderer/src/modules/translate/TranslateModule.tsx',
  'src/renderer/src/modules/knowledge/KbAskPanel.tsx',
  'src/renderer/src/popup/PopupApp.tsx',
  // §264：锁状态／两发统计／草稿／向导助手清单
  'src/renderer/src/modules/unlock/UnlockPage.tsx',
  'src/renderer/src/modules/wizard/FirstRunWizard.tsx'
]

const run = (code: string): JumpSite[] => scanSource('probe.tsx', blankComments(code))

describe('§263 第五面：失败侧只有流程跳，而成功那支要上屏（先验扫描器自己）', () => {
  it('扫描器自证：五档各归对桶（判据①②缺一面就废）', () => {
    const fake = `
      const f = async () => {
        if (hasIpcFailed(a)) { return }            // 目标桶：成功支写状态
        setA(a)
      }
      const g = async () => {
        if (hasIpcFailed(b)) { return }            // 对照桶：成功支也不写状态 ⇒ fail-closed
        return summarize(b)
      }
      const h = async () => {
        if (hasIpcFailed(c)) return showNotice(false, c.error)  // 跳转带着话 ⇒ 不算"什么都不说"
        setC(c)
      }
      const k = async () => {
        try {
          if (r.ok === false) throw new Error(r.error)         // throw 交给会说话的 catch ⇒ 不算
          setR(r)
        } catch (e) { setNotice({ ok: false, text: String(e) }) }
      }
      const m = async () => {
        if (!hasIpcFailed(d)) { setD(d) } else { return }      // 反判：失败侧是 else，成功支是 then
      }
    `
    const sites = run(fake)
    expect(sites.map((s) => s.cond), '只有流程跳的分支共三条（c 跳转带着话、k 交给会说话的 catch ⇒ 都不算）')
      .toEqual(['hasIpcFailed(a)', 'hasIpcFailed(b)', '!hasIpcFailed(d)'])
    const lies = sites.filter((s) => s.successWrites).map((s) => s.cond)
    expect(lies, '其中"成功那支要上屏"的两条才是目标桶')
      .toEqual(['hasIpcFailed(a)', '!hasIpcFailed(d)'])
    expect(sites[0]!.successWrites, 'a 那发的成功支写了 setA ⇒ 目标桶').toBe(true)
    expect(sites[1]!.successWrites, 'b 那发成功支也不写状态 ⇒ fail-closed，不算谎').toBe(false)
    expect(sites[2]!.negated, 'd 那发是反判，失败侧取 else').toBe(true)
    expect(sites[2]!.successWrites, 'd 的成功支是 then 里的 setD ⇒ 目标桶').toBe(true)
  })

  it('对照桶必须非空且与目标桶不同数（这条轴若恒返回一个桶，全绿也是假的）', () => {
    expect(LIE.length, '目标桶（屏上留初值＝谎）').toBeGreaterThan(0)
    expect(FAIL_CLOSED.length, 'fail-closed 对照桶').toBeGreaterThan(0)
    expect(FAIL_CLOSED.length, '两桶数必须不同——同数就是分类器没分开两类').not.toBe(LIE.length)
    expect(LIE.length + FAIL_CLOSED.length, '总数＝判过失败面且只跳的那批').toBe(SITES.length)
  })

  it('等式 ratchet：目标桶 7 处（§263 开批 19→13，§264 再收六处→7）', () => {
    expect(LIE.length, `现数 ${LIE.length}：\n${LIE.map((s) => `  ${s.file}:${s.line} if (${s.cond}) ⇒ ${s.body}`).join('\n')}`).toBe(JUMP_LIE_CAP)
  })

  it('逐文件登记与名单相符（多了＝有人把收口改回只 return；少了＝收口了没撤登记）', () => {
    for (const [file, expected] of Object.entries(JUMP_LIE_PER_FILE)) {
      const left = LIE.filter((s) => s.file === file)
      expect(left.length, `${file} 仍"只跳不说话" ${left.length} 处（登记的是 ${expected}）：\n${left.map((s) => `  L${s.line} if (${s.cond})`).join('\n')}`).toBe(expected)
    }
    const registered = Object.values(JUMP_LIE_PER_FILE).reduce((a, b) => a + b, 0)
    expect(registered, '登记表总数必须等于 CAP（漏登记一个文件就会藏住新的点）').toBe(JUMP_LIE_CAP)
  })

  it('正向对照：名单里这几个文件确实非空，本批收口的四份确实归零', () => {
    for (const file of STILL_JUMP_SILENT_PROOF) {
      expect(LIE.some((s) => s.file === file), `${file} 应当仍在名单里（不在＝扫描器瞎了）`).toBe(true)
    }
    for (const file of FIXED_THIS_BATCH) {
      expect(LIE.filter((s) => s.file === file).map((s) => `L${s.line} ${s.cond}`), `${file} 本批应已归零`).toEqual([])
    }
  })

  it('真仓不是空转：本批六处的收口形状在源码里数得出（失败侧写状态＋成功即收回＋reject 同句）', () => {
    const read = (rel: string): string =>
      blankComments(fs.readFileSync(path.resolve(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'))
    const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length
    const FILES = [
      'src/renderer/src/modules/image/ImageModule.tsx',
      'src/renderer/src/modules/translate/TranslateModule.tsx',
      'src/renderer/src/modules/knowledge/KbAskPanel.tsx',
      'src/renderer/src/popup/PopupApp.tsx'
    ]
    // 六发读（providers×4、assistants×1、models×1）各自两路：resolve 的失败对象＋reject ⇒ 八次写 unread
    const writes = FILES.reduce((n, f) => n + count(read(f), /setProvidersUnread\(\{ error: /g), 0)
    expect(writes, '四处服务商读的两种失败路都写 unread（每处 2 次＝resolve＋reject）').toBe(8)
    expect(count(read(FILES[3]!), /setAssistantsUnread\(\{ error: /g), '助手那一读也是两路').toBe(2)
    expect(count(read(FILES[3]!), /setModelsUnread\(\{ error: /g), '拉取模型也是两路').toBe(2)
    expect(count(read(FILES[3]!), /setProvidersUnread\(null\)|setAssistantsUnread\(null\)|setModelsUnread\(null\)/g), '成功即收回').toBe(3)
    // 那三发挂载读不许再把 reject 裸交给 reportIpcError（§262 同一条：只进 console＝这一族还剩半张脸）
    for (const f of FILES) {
      expect(count(read(f), /\.catch\(reportIpcError\('(image|translate|kbAsk|popup)\.(listProviders|listAssistants)'\)\)/g), `${f} 不该再有裸交出去那一形`).toBe(0)
    }
  })

  it('§264 那六处的形状也数得出（锁状态／两发统计／草稿／向导助手清单，含"迟到两路都挡"）', () => {
    const read = (rel: string): string =>
      blankComments(fs.readFileSync(path.resolve(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'))
    const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length
    const STATS = 'src/renderer/src/modules/agent/hooks/useAgentChat.ts'
    const UNLOCK = 'src/renderer/src/modules/unlock/UnlockPage.tsx'
    const CHAT = 'src/renderer/src/modules/chat/ChatModule.tsx'
    const WIZ = 'src/renderer/src/modules/wizard/FirstRunWizard.tsx'
    const stats = read(STATS)
    // 每发两路（resolve 的失败对象＋reject）各写自己那份 unread；统计是两发⇒四路
    expect(count(stats, /setRunStatsUnread\(\{ error: /g), '本次运行统计两路').toBe(2)
    expect(count(stats, /setSessionStatsUnread\(\{ error: /g), '会话累计统计两路').toBe(2)
    // §260 那条"要不要写"的守卫现在**成功路与失败路都有**——旧会话的失败不许在已切过去的屏上留一句"读不到"
    expect(count(stats, /if \(conversationIdRef\.current !== id\) return/g), '两发×两路各挡一次迟到').toBe(4)
    expect(count(read(UNLOCK), /setLockUnread\(\{ error: /g), '锁状态两路').toBe(2)
    expect(count(read(CHAT), /setDraftUnread\(\{ error: /g), '草稿读两路').toBe(2)
    expect(count(read(WIZ), /setAssistantsUnread\(\{ error: /g), '向导助手清单两路').toBe(2)
    // 三处收口的 reject 不许再裸交出去（旧形：`.catch(reportIpcError('通道名'))`／空 `catch {}`）
    expect(count(stats, /\.catch\(reportIpcError\('agent\.(getLatestRunStats|getSessionStats)'\)\)/g), '统计那两发的裸交出去归零').toBe(0)
    expect(count(read(CHAT), /\.catch\(\(e\) => \{ if \(!cancelled\) reportIpcError\('chat\.getConversationDraft'\)/g), '草稿那发的"只留痕"归零').toBe(0)
    expect(count(read(WIZ), /\.catch\(reportIpcError\('wizard\.listAssistants'\)\)/g), '向导助手那发同理').toBe(0)
    // 锁状态那处旧写法是**空 catch**（连留痕都没有），必须不再出现
    expect(count(read(UNLOCK), /\} catch \{\n\s+\/\/ 状态拉取失败不阻断/g), '空 catch 那一形归零').toBe(0)
    // 界面侧：锁状态那句带降级说明（"下面按钮按未锁定显示"），不是一句孤零零的"读不到"
    expect(read(UNLOCK)).toContain("t('unlock.lockStateUnread'")
  })
})
