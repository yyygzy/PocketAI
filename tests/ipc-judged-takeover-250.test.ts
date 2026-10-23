// V4-Iter-250：闸门第四面——**判了失败面不等于接管了失败**。
//
// 为什么要有这一面（§230 留下的那一族）：§217／§219／§221／§224 那三面问的都是"这一发有没有判返回值"，
// 于是 `if (!hasIpcFailed(v)) setX(v)` 这种写法一路绿灯——它确实判了。但 `safeHandle` 的失败是 **resolve 的
// `{ok:false}`**（§196），后面那句 `.catch(reportIpcError(...))` 永远接不到它，于是真失败时：**不写状态、不提示、
// 连 console 都不留**，而界面把"读不到"演成"这份数据就是这样的"（空列表／0／默认值）。
// 只认 `hasIpcFailed(...)` 这种写法时是 224 个判定点／50 个静默；把 §217 那三面同样承认的 **`.ok` 裸真值**
// 写法（`if (r.ok) setX(...)`、`if (!r.ok) {...}`）并进来之后是 **343 个判定点／90 个静默**，本批收口 6 处 ⇒ CAP 84。
// 分桶表与两个口径决定都记在台账 §250。
//
// 口径三条，都是量完才定的（不是想当然）：
//   · **只看"失败侧"**：正判（`if (hasIpcFailed(v))`）的失败侧是 then；反判（`if (!hasIpcFailed(v))`）的失败侧是 else，
//     **没有 else 就是"什么都不做"**——这一族的典型形状。极性写反整面就废，所以第 1 条用例专门喂假源码验它。
//   · **"接管"= 失败侧至少做到下面之一**：写状态（`setX(...)`／赋值／`const`）、流程接管（`return`/`throw`/`break`/`continue`）、
//     发通知（`toast.*`／`Notice`／`showNotice`／`showIpcFailure`／`failOp`／`reportFailure`）。
//   · **只调一个本文件之外的助手（`onChatSendFailed(r)` 这种）算接管，但助手名必须逐个登记**（`REGISTERED_HANDLERS`）——
//     跨函数没有过程间分析，新助手是不是真接管得由人看过才加名字，加不进名单就红。
//
// 只进 console 的那一档（`logIpcError`）**不算接管**：这与 §228 记的"停止类只进 console"是同一件事的另一半——
// 用户看不见的处理，不能拿来抵"界面谎报"。
//
// 两条**量过之后删掉**的候选守卫（后来人别再补"看起来更严"的代码）：① "只算 IPC 结果"的范围闸（要求所在函数出现过
// `pocketai`）；② "反判无 else 但下一句是 return ⇒ 算交给调用方"这条接管规则。两者去掉后名单都仍是 84 条 ⇒
// 按 §推广七那条纪律：怎么改都不红的行不配拥有断言，直接删，不编造保护它的用例。
// 调小的那一批必须同时把该处从 `STILL_SILENT_PROOF` 里撤掉（那条用例是防"扫描器恒返回空"的正向对照）。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const RENDERER_DIR = 'src/renderer/src'

interface Site {
  file: string
  line: number
  /** 条件原文（抹掉注释后） */
  cond: string
  /** 被判的变量名 */
  v: string
  negated: boolean
  hasElse: boolean
  /** 失败侧的分类 */
  side: 'none' | 'console' | 'takes-over' | 'helper' | 'fallthrough'
  /** 失败侧只调了哪个助手 */
  helper?: string
  /** 失败侧原文（红因用） */
  body: string
}

const CONSOLE_CALLS = /^(console\.|logIpcError|reportIpcError)/

/** 一段语句里"做了什么事"（顺带交出它唯一调用的助手名） */
function classifySide(node: ts.Statement | ts.Block | undefined): { side: Site['side']; helper?: string } {
  if (!node) return { side: 'none' }
  const stmts = ts.isBlock(node) ? Array.from(node.statements) : [node]
  if (stmts.length === 0) return { side: 'none' }
  let effect = false
  let helper: string | undefined
  let onlyConsole = true
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n)) effect = true
    if (ts.isExpressionStatement(n)) {
      const e = n.expression
      if (ts.isCallExpression(e)) {
        const name = e.expression.getText().replace(/^void\s+/, '')
        if (CONSOLE_CALLS.test(name)) return
        onlyConsole = false
        if (/^(set[A-Z]|Notice$|toast\.|showNotice|showIpcFailure|reportFailure|failOp)/.test(name)) effect = true
        else helper = helper ?? name.split('.').slice(-1)[0]
      } else if (ts.isBinaryExpression(e) && /=/.test(e.operatorToken.getText()) && e.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken && e.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
        effect = true
        onlyConsole = false
      } else if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
        // `failed++` 这类局部计数喂的是后面的聚合提示（「成功 N 失败 M」），算写了状态——§250 的分桶把它读成「什么都没做」是假阳
        effect = true
        onlyConsole = false
      }
    }
    if (ts.isVariableStatement(n)) {
      effect = true
      onlyConsole = false
    }
    ts.forEachChild(n, visit)
  }
  stmts.forEach(visit)
  if (effect) return { side: 'takes-over' }
  if (onlyConsole && stmts.length > 0) return { side: 'console' }
  return helper ? { side: 'helper', helper } : { side: 'none' }
}

/**
 * 条件里"判失败面"的写法有六种（§217 那三面认的也就是这六种），返回被判的变量与**极性**：
 * `negated:false` ⇒ 失败侧是 then；`negated:true` ⇒ 失败侧是 else（没有 else 就是"什么都不做"）。
 */
function judged(cond: string): { v: string; negated: boolean } | null {
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
      // `x.ok === false` ⇒ 失败侧在 then；`x.ok === true` ⇒ 成功侧在 then
      const rhs = cond.match(new RegExp(esc(v) + '\\s*\\.\\s*ok\\s*(?:===|!==)\\s*(true|false)|(true|false)\\s*(?:===|!==)\\s*' + esc(v) + '\\s*\\.\\s*ok'))
      const isFalse = (rhs?.[1] ?? rhs?.[2]) === 'false'
      const neq = /\b[A-Za-z_$][\w$]*\s*\.\s*ok\s*!==/.test(cond)
      return { v, negated: isFalse ? neq : !neq }
    }
    return { v, negated: !!neg }
  }
  return null
}

/** 分支最后一句是不是跳（return/throw/break/continue）——决定 if 之后的代码归谁 */
function endsWithJump(node: ts.Statement | ts.Block): boolean {
  const stmts = ts.isBlock(node) ? Array.from(node.statements) : [node]
  const last = stmts[stmts.length - 1]
  return !!last && (ts.isReturnStatement(last) || ts.isThrowStatement(last))
}

function scanSource(file: string, code: string): Site[] {
  const src = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const out: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const cond = node.expression.getText()
      const j = judged(cond)
      if (j) {
        const { v, negated } = j
        const failNode = negated ? node.elseStatement : node.thenStatement
        const cls = classifySide(failNode ?? undefined)
        const helperName = cls.helper
        let side = cls.side
        // §251 撞出来的假阳：`if (r.ok) { …成功那套…; return }` 后面那段**本身就是失败路径**（916 下面正挨着
        // `r.code === 'needBackupPassword'` 的分派）。识别条件三条都要成立：成功侧以 return/throw 收尾、
        // if 之后同段还有语句、且这是反判。否则仍按静默算。
        if (side === 'none' && negated && !node.elseStatement && endsWithJump(node.thenStatement)) {
          const blk = node.parent && (ts.isBlock(node.parent) || ts.isSourceFile(node.parent)) ? (node.parent as ts.Block | ts.SourceFile) : null
          const after = blk ? blk.statements.length - blk.statements.indexOf(node) - 1 : 0
          if (after > 0) side = 'fallthrough'
        }
        out.push({
          file,
          line: ts.getLineAndCharacterOfPosition(src, node.getStart(src)).line + 1,
          cond: cond.replace(/\s+/g, ' '),
          v,
          negated,
          hasElse: !!node.elseStatement,
          side,
          helper: helperName,
          body: (failNode ?? node.thenStatement).getText().replace(/\s+/g, ' ').slice(0, 120)
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

/** 抹掉注释再扫：注释里的 "读不到" 不算界面做了什么（§217 同一条纪律） */
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
const SITES = ALL.flatMap((rel) => scanSource(rel, blankComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))))
/** 读数类静默点：失败侧什么都没做，或只进 console */
const SILENT = SITES.filter((s) => s.side === 'none' || s.side === 'console')
// §268：42 → 36（收掉输入框那圈六发惰性读：ChatConfigBar 的技能／知识库、Composer 与 AgentComposer 的知识库／片段）
// §269：36 → 33（收掉翻译页余下三发：历史那两发并成一根 loader＋一句一键，术语表一句一键）
const SILENT_READ_CAP = 33

const STILL_SILENT_PROOF = [
  'src/renderer/src/modules/agent/channels/ChannelsPanel.tsx',
  'src/renderer/src/modules/chat/AssistantEditor.tsx',
  'src/renderer/src/modules/settings/SettingsModule.tsx',
  'src/renderer/src/modules/image/ImageModule.tsx'
]

/**
 * 逐文件钉"仍静默"的处数（§250 收四处：App 2→0、DetachedApp 2→0、Sidebar 2、ChatModule 1；
 * §251 收 SettingsModule 那簇 11→2）。按文件计数而不是按行号——行号会漂。
 * Sidebar 剩的两条与 SettingsModule 剩的两条都是 `.ok` 裸真值那一档：
 * SettingsModule 那两条人工看过——`setMergePwd` 那发的失败由上一行 `setMergeReport(r)` 承担，
 * 指纹那发界面上本来就写着「无法读取」（`lic.fpUnavailable`）。闸门的"单条 if"视角看不见这两种出口，
 * 所以**不改产品码去迁就扫描器，也不加"看上一行/看初始值"的规矩**（那会把接管判据扩成数据流分析），
 * 就让它们留在名单里计数——下一批若要清，先从名单里读这两条，别当缺陷盲改。
 */
const SILENT_PER_FILE: Record<string, number> = {
  'src/renderer/src/App.tsx': 0,
  'src/renderer/src/detached/DetachedApp.tsx': 0,
  'src/renderer/src/components/Sidebar.tsx': 2,
  'src/renderer/src/modules/chat/ChatModule.tsx': 1,
  // §260：对话页那三发列表读（会话／归档／分组）从 ChatModule 抽到这个 hook 后全部收口（清零）。
  // ChatModule 自己剩的那 1 处是 `reloadAssistants`（:117 反判无 else，助手清单那一读），与本簇无关。
  'src/renderer/src/modules/chat/useConversationLists.ts': 0,
  'src/renderer/src/modules/settings/SettingsModule.tsx': 2,
  'src/renderer/src/modules/knowledge/KnowledgeModule.tsx': 0,
  // §255 复核后留下的一条：清理后那发"顺带刷新诊断"是设计内静默（清理本身已有可见回执、上一份诊断也可能仍在屏上），
  // ——§268 按实测改口：原话写的是"清理已 toast"，实际成功面走的是 `cleanupResult` 那块绿色结果面板（:142 写／:682 渲染）；
  //  而"上一份诊断还在屏上"只在用户先手动点过诊断时成立，否则那一块整块不出现（fail-closed，不摆假数字）
  // 但闸门的单条 if 视角看不见那行注释 ⇒ 继续计数，不为了清零去改产品码
  'src/renderer/src/modules/steward/StewardModule.tsx': 1,
  // §256 复核后留下的三处设计内静默（都不是读数屏上的谎报，闸门的单条 if 视角看不见理由）：
  //  · ImageModule：生成成功后那发「顺带刷新画廊」——图与耗时已在最新结果区、flash 已说「生成完成」；
  //  · FirstRunWizard：挂载那份 provider 快照无任何渲染消费者，保存前会现取一次，两道都失败还有 repo 的 foundByDedupe 兜底；
  //    而保存前那发现取失败只进 console 是**故意不卡住首启必经路**。
  'src/renderer/src/modules/image/ImageModule.tsx': 1,
  'src/renderer/src/modules/wizard/FirstRunWizard.tsx': 2,
  // §257：这一簇没有设计内静默——`useAgentToolConfigs` 四发读全部收口（清零）。
  // §258 把 `useAgentChat` 也归零：`setUiPrefs` 那两发**写**失败过去只进 console（§257 留的产品决策），
  // 口径定了——不弹 toast（那发在挂载恢复后也会重放一次同值写入，会撞在启动那一下），
  // 改成 Agent 面板常驻一句「这次选的助手与会话没能记住」，写成功即收回。
  'src/renderer/src/modules/agent/hooks/useAgentToolConfigs.ts': 0,
  'src/renderer/src/modules/agent/hooks/useAgentChat.ts': 0,
  // §261：Agent 挂载时那两发清单读（服务商／助手）也收口——旧写法是 `ps.filter` 当场 TypeError
  // 被 .catch 念进 console（连带丢掉读到的那份），`setAssistants(as_)` 则把失败对象交给 SessionRail 的 .map。
  'src/renderer/src/modules/agent/hooks/useProviderData.ts': 0,
  // §268：输入框那圈的六发惰性读全部收口（各挂一句、逐发点名；知识库那两发带重试键，
  // 片段与上下文中枢那几发的出口是"再点／再进一次触发态"自己会重拉——各屏的出口形状不同，理由写在各文件注释里）
  'src/renderer/src/modules/chat/ChatConfigBar.tsx': 0,
  'src/renderer/src/modules/chat/Composer.tsx': 0,
  'src/renderer/src/modules/agent/components/AgentComposer.tsx': 0,
  // §269：翻译页余下那三发（挂载读历史／翻译成功后刷新历史／挂载读术语表）收口（清零）。
  // 两发历史**并成一根 loader、共用一张脸**（同一份数据的两次取不该说两遍），术语表那句与那颗键是同一份 JSX，
  // 遮罩内外二选一渲染 ⇒ 同一时刻只一句、一键。
  'src/renderer/src/modules/translate/TranslateModule.tsx': 0
}

const REGISTERED_HANDLERS = ['onChatSendFailed', 'fail', 'backToQueue', 'failSend', 'applyPayload', 'handleRestoreResult', 'failAction', 'flash', 'notify', 'rollback', 'rollbackOrder']

describe('§250 第四面：判了失败面还得接管它（先验扫描器自己）', () => {
  it('扫描器自证：六种判据写法各归对桶（极性写反整面就废）', () => {
    const fake = `
      const a = await f()
      if (hasIpcFailed(a)) { setErr(x); return }
      if (!hasIpcFailed(b)) setB(b)
      if (!hasIpcFailed(c)) setC(c); else logIpcError('c', new Error())
      if (hasIpcFailed(d)) toast.error(msg)
      if (hasIpcFailed(e)) helper(e)
      if (r1.ok === false) setErr(r1.error)
      if (r2.ok) setR(r2)
      if (!r3.ok) setErr(r3.error)
      if (r4.ok) { setR(r4); return }
      setErr(r4.error)
      if (hasIpcFailed(r7)) failed++
      if (r5.ok) { setR(r5); return }
    `
    const got = scanSource('fake.ts', fake)
    const at = (v: string) => got.find((s) => s.v === v)
    expect(got.map((s) => s.v).sort(), '十一条判定式都该被收到（`.ok` 是数组字段的两种不算）').toEqual(['a', 'b', 'c', 'd', 'e', 'r1', 'r2', 'r3', 'r4', 'r5', 'r7'])
    expect(at('a')?.side).toBe('takes-over')
    expect(at('a')?.negated).toBe(false)
    expect(at('b')?.negated, '!hasIpcFailed 是反判').toBe(true)
    expect(at('b')?.hasElse).toBe(false)
    expect(at('b')?.side, '反判无 else ⇒ 失败侧什么都不做').toBe('none')
    expect(at('c')?.side, '只进 console 不算接管').toBe('console')
    expect(at('d')?.side).toBe('takes-over')
    expect(at('e')?.side).toBe('helper')
    expect(at('e')?.helper).toBe('helper')
    expect(at('r1'), 'x.ok === false ⇒ 失败侧就是 then').toMatchObject({ negated: false, side: 'takes-over' })
    expect(at('r2'), 'x.ok（裸真值）⇒ 成功侧是 then，失败侧是 else；没 else 就是静默').toMatchObject({ negated: true, side: 'none' })
    expect(at('r3'), '!x.ok ⇒ 失败侧是 then').toMatchObject({ negated: false, side: 'takes-over' })
    expect(at('r4'), '成功侧以 return 收尾且 if 之后还有语句 ⇒ 那段就是失败路径，不算静默').toMatchObject({ side: 'fallthrough' })
    expect(at('r5'), '同形但 if 之后一句都没有 ⇒ 仍是静默（这条不给 r4 打掩护）').toMatchObject({ side: 'none' })
    expect(at('r7'), '失败侧只有 `failed++` ⇒ 那是聚合提示的计数，算接管').toMatchObject({ negated: false, side: 'takes-over' })
    expect(at('b'), '行号可得（红因要指得到位置）').toMatchObject({ line: 4 })
  })

  it('注释里的"接管"不算：被注释掉的守卫仍判静默（行注释与块注释各验一半，两半都有牙）', () => {
    const lineComments = `const v = await f()\nif (!hasIpcFailed(v)) setV(v)\n// if (hasIpcFailed(v)) { setErr(v); return }`
    const blockComments = `const v = await f()\nif (!hasIpcFailed(v)) setV(v)\n/* if (hasIpcFailed(v)) { setErr(v); return } */`
    expect(blankComments(lineComments)).not.toContain('setErr')
    expect(blankComments(blockComments)).not.toContain('setErr')
    expect(scanSource('c.ts', blankComments(lineComments)).map((s) => s.side)).toEqual(['none'])
    expect(scanSource('c2.ts', blankComments(blockComments)).map((s) => s.side)).toEqual(['none'])
  })

  it('真仓不是空转：判定式总数与分桶守恒（谁漏了一类就会在这里红）', () => {
    expect(SITES.length, '判定式总数（现查 362。这条数随写法归并/拆分而变、不是不变量，引用前现查：§266 那批 362、§267 加了三发各判一次成 363、§268 现查仍 363，本批把翻译页"同一份数据的两次取"并成一根 loader ⇒ 少一条）').toBeGreaterThan(300)
    const by: Record<string, number> = { none: 0, console: 0, 'takes-over': 0, helper: 0, fallthrough: 0 }
    for (const s of SITES) by[s.side] = (by[s.side] ?? 0) + 1
    expect(Object.values(by).reduce((a, b) => a + b, 0), '分桶必须等于总数').toBe(SITES.length)
    expect(by.fallthrough, '落下去就是失败路径那一档（§251 新认的形状）不是空的').toBeGreaterThan(0)
    expect(by['takes-over'], '大多数点确实是接管的（否则这把尺子量错了）').toBeGreaterThan(100)
  })

  it('反向对照：仍静默的那几份文件必须真的在名单里（恒返回空的坏扫描器会在这里红）', () => {
    const files = new Set(SILENT.map((s) => s.file))
    for (const f of STILL_SILENT_PROOF) expect(files.has(f), `${f} 应当还有静默点`).toBe(true)
    expect(SILENT.length, '静默名单非空').toBeGreaterThan(10)
  })

  it('§250~§269 逐批收口后，这几份文件的剩余静默数与登记相符', () => {
    for (const [file, expected] of Object.entries(SILENT_PER_FILE)) {
      const left = SILENT.filter((s) => s.file === file)
      expect(left.length, `${file} 仍静默 ${left.length} 处（登记的是 ${expected}）：\n${left.map((s) => `  L${s.line} if (${s.cond}) ⇒ ${s.body}`).join('\n')}`).toBe(expected)
      expect(SITES.filter((s) => s.file === file).length, `${file} 里总得有判定点，否则上一条断言是空的`).toBeGreaterThan(0)
    }
  })

  it('静默名单只减不增（ratchet 现数 ' + SILENT_READ_CAP + '）', () => {
    const over = SILENT.slice(SILENT_READ_CAP)
    expect(over.length, `新增"判了不接管"的读数点：\n${over.slice(0, 10).map((s) => `  ${s.file}:${s.line} if (${s.cond}) ⇒ ${s.body}`).join('\n')}`).toBe(0)
    expect(SILENT.length, `现数 ${SILENT.length} 与登记的 CAP ${SILENT_READ_CAP} 不等：多了＝新增静默点，少了＝这一批收了口却没调小 CAP（两种都要处理，不许放着）`).toBe(SILENT_READ_CAP)
  })

  it('失败侧"只调助手"的话，助手名必须逐个登记过（过程间没分析，新名字得人工看过）', () => {
    const helpers = [...new Set(SITES.filter((s) => s.side === 'helper').map((s) => s.helper ?? '?'))].sort()
    const unregistered = helpers.filter((h) => !REGISTERED_HANDLERS.includes(h))
    expect(unregistered, `未登记的助手：${unregistered.join(', ')}——去看它到底做没做事，再决定加名字还是改成直接接管`).toEqual([])
    expect(helpers.length, '这一档不是空的（空了说明分类器没在跑）').toBeGreaterThan(0)
  })
  it('§268 那六发的形状数得出（两路各写失败对象、读到即收回、只进 console 那一形归零、渲染条件本身在场、键按各屏有没有天然出口配）', () => {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length
    const CC = read('src/renderer/src/modules/chat/ChatConfigBar.tsx')
    const CO = read('src/renderer/src/modules/chat/Composer.tsx')
    const AC = read('src/renderer/src/modules/agent/components/AgentComposer.tsx')

    // 每发两条失败路（resolve 的失败对象／reject）各写一次；读到即收回
    for (const [name, src] of [['ChatConfigBar', CC], ['Composer', CO], ['AgentComposer', AC]] as const) {
      // 每份文件两发惰性读、每发两条失败路（resolve 的失败对象／reject）⇒ 各写两次
      expect(count(src, /set(?:Skills|Kbs|Snippets)Fail\(\{ error: /g), `${name}：两发 × 两条失败路各写一次`).toBe(4)
      expect(count(src, /set(?:Skills|Kbs|Snippets)Fail\(null\)/g), `${name}：每发读到即收回，共两处`).toBe(2)
    }
    // 旧写法（裸交给 reportIpcError）在这三处归零
    expect(count(CC, /\.catch\(reportIpcError\('chatConfig\./g), '中枢面板不再有那一形').toBe(0)
    expect(count(CO, /\.catch\(reportIpcError\('chat\.list/g), '对话页输入框同').toBe(0)
    expect(count(AC, /\.catch\(reportIpcError\('agent\.list/g), 'Agent 输入框同').toBe(0)

    // 那句真挂得出去：计数盯**渲染条件用的是哪一个 fail 状态**＋它旁边点的是哪个界面名词
    // （§266 的 Z7 教训——只数文案会放过把守卫换成 `false &&` 那种写法；这里守卫名与名词成对，写串了也红）
    const CC_SKILLS = /\{skillsFail && \([\s\S]{0,240}?what=\{t\('common\.skillsList'\)/g
    const CC_KBS = /\{kbsFail && \([\s\S]{0,240}?what=\{t\('common\.kbList'\)/g
    const CO_KBS = /\{kbsFail && \([\s\S]{0,240}?common\.kbList/g
    const CO_SNIPPETS = /\{snippetsFail && \([\s\S]{0,240}?common\.snippetList/g
    const AC_KBS = /\{kbsFail && \([\s\S]{0,240}?common\.kbList/g
    const AC_SNIPPETS = /\{snippetsFail && \([\s\S]{0,240}?common\.snippetList/g
    expect(count(CC, CC_SKILLS), '中枢面板·技能那句挂在渲染条件里').toBe(1)
    expect(count(CC, CC_KBS), '中枢面板·知识库那句挂在渲染条件里').toBe(1)
    expect(count(CO, CO_KBS), '对话页·知识库那句挂在渲染条件里').toBe(1)
    expect(count(CO, CO_SNIPPETS), '对话页·片段那句挂在渲染条件里').toBe(1)
    expect(count(AC, AC_KBS), 'Agent 页·知识库那句挂在渲染条件里').toBe(1)
    expect(count(AC, AC_SNIPPETS), 'Agent 页·片段那句挂在渲染条件里').toBe(1)
    // 那句确实是要被读到的那种（alert 盒子或 LoadFailNotice 组件）
    expect(count(CC, /<LoadFailNotice/g), '中枢面板两句都走 LoadFailNotice（role=alert 在那个组件里）').toBe(2)
    // 精确到 JSX 属性写法（注释里也出现 role="alert" 这几个字，宽松的数法会把注释算进去）
    const ALERT = /role="alert" className="text-xs text-\[var\(--color-danger\)\]"/g
    expect(count(CO, ALERT), '对话页两句都自带 alert 盒子').toBe(2)
    expect(count(AC, ALERT), 'Agent 页两句都自带 alert 盒子').toBe(2)

    // 重试键按"各屏有没有天然出口"配：不该造机关的地方别造，该有出口的地方别缺
    expect(count(CC, /retry/g), '中枢面板一处键都不造（再点那一格本身就是出口）').toBe(0)
    expect(count(CO, /data-testid="composer-(?:kbs|snippets)-retry"/g), '对话页两处都自带出口').toBe(2)
    expect(count(AC, /data-testid="agent-composer-kbs-retry"/g), 'Agent 页知识库那句自带出口').toBe(1)
    expect(count(AC, /snippets-retry/g), 'Agent 页片段那句不造键（失败时 ref 仍是 null，再进触发态自己会重拉）').toBe(0)
    // 占位写死这条不许被"顺手修好"成清回 null（§221 真挂载量过：那会让输入框每次渲染重拉、卡死在转圈）
    expect(count(CO, /kbsRef\.current = \[\] \/\/ 占位防并发重复拉取/g), '对话页知识库占位仍在').toBe(1)
    expect(count(CO, /snippetsRef\.current = \[\] \/\/ 占位防并发重复拉取/g), '对话页片段占位仍在').toBe(1)
    expect(count(AC, /kbsRef\.current = \[\] \/\/ 占位防并发重复拉取/g), 'Agent 页知识库占位仍在').toBe(1)
    expect(count(AC, /snippetsRef\.current = \[\]/g), 'Agent 页片段没有占位（正因如此才不给键）').toBe(0)
    // 清回 null 只许出现在"点重试键"那条路上（数一下：对话页两个出口＝2、Agent 页一个出口＝1、中枢面板 0）
    expect(count(CC, /(?:kbs|snippets)Ref\.current = null/g), '中枢面板没有 ref 这件事').toBe(0)
    expect(count(CO, /(?:kbs|snippets)Ref\.current = null/g), '对话页只有两颗重试键各清一次').toBe(2)
    expect(count(AC, /(?:kbs|snippets)Ref\.current = null/g), 'Agent 页只有知识库那颗键清一次').toBe(1)

    // 三个新界面名词四语都要有（一个界面名词只留一份键，§263）
    for (const dict of ['zh', 'en', 'ja', 'ko']) {
      const src = read(`src/renderer/src/i18n/${dict}.ts`)
      for (const key of ['common.skillsList', 'common.kbList', 'common.snippetList']) {
        expect(src.includes(`'${key}'`), `${dict} 缺 ${key}`).toBe(true)
      }
    }
  })
  it('§269 那三发的形状数得出（两发并一根 loader、两张谎脸都让位、键同一时刻只一颗、名词不重复开键）', () => {
    const src = fs
      .readFileSync(path.join(ROOT, 'src/renderer/src/modules/translate/TranslateModule.tsx'), 'utf8')
      .replace(/\r\n/g, '\n')
    const count = (re: RegExp): number => (src.match(re) ?? []).length

    // 两条失败路各写一次原因（resolve 的失败对象／reject），读到即收回
    expect(count(/set(?:History|Glossary)Unread\(\{ error: /g), '历史与术语表各两条失败路').toBe(4)
    expect(count(/set(?:History|Glossary)Unread\(null\)/g), '读到即收回，两处').toBe(2)
    // 旧写法（裸交给 reportIpcError）在这三发上归零；§266 那颗卸载清理留下的那一条不许被"顺手修好"
    expect(count(/\.catch\(reportIpcError\('translate\.(?:listTranslations|listGlossary|reloadHistory)/g), '那三发不再有那一形').toBe(0)
    expect(count(/reportIpcError\('translate\.abortTranslate'/g), '卸载清理那一发仍只留痕（§266 定的，本批没动）').toBe(1)

    // 第三发（翻译成功后刷新）并进同一根 loader ⇒ 同一份数据只一张脸，不说两遍
    expect(count(/const reloadHistory = loadHistory/g), '刷新那一发共用历史那张脸').toBe(1)
    expect(count(/window\.pocketai\.listTranslations\(\)/g), 'listTranslations 全文件只许一处发（两发并一根）').toBe(1)

    // 那句真挂得出去：盯**渲染条件本身**（§266 的 Z7 教训——只数文案会放过把守卫换成 `false &&` 那种写法）
    expect(count(/\{historyUnread && \(\s*<div[\s\S]{0,240}?what=\{t\('translate\.history\.title'\)/g), '历史那句挂在渲染条件里').toBe(1)
    expect(count(/const glossaryFailLine = glossaryUnread \? \([\s\S]{0,240}?common\.glossaryList/g), '术语表那句挂在条件本身里').toBe(1)

    // 两处谎脸都换掉：「还没有翻译记录」与「术语表（0 条）」都不许在失败时继续摆
    expect(count(/history\.length === 0 && !historyUnread/g), '历史空态让位').toBe(1)
    expect(count(/glossaryUnread \? t\('translate\.glossary\.title'\) : t\('translate\.glossary\.manage'/g), '读不到就不报条数').toBe(1)
    expect(count(/failLine \?\? \(/g), '面板里那块空态让位给同一份失败句').toBe(1)

    // 键按"同一时刻只一颗"配：遮罩内外共用**同一份 JSX** ⇒ 源码里各只一处，且工具条那份带 !glossaryOpen 守卫
    expect(count(/data-testid="translate-history-retry"/g), '历史那颗键').toBe(1)
    expect(count(/data-testid="translate-glossary-retry"/g), '术语表那颗键——面板与工具条共用一份，不造第二颗').toBe(1)
    expect(count(/\{!glossaryOpen && glossaryFailLine\}/g), '面板打开时工具条那份收掉（同一时刻只一句）').toBe(1)

    // alert 的总数：§266 那颗停止那句＋本批术语表那句（历史那句走 LoadFailNotice 组件，不在本文件的字面量里）
    expect(count(/role="alert"/g), '本文件里自己写 role="alert" 的只该有这两处').toBe(2)
    expect(count(/<LoadFailNotice/g), '两块读不到共用组件：服务商（§263）与历史（本批）').toBe(2)

    // 名词只留一份键：历史复用屏上标题，术语表用新加的 common.glossaryList（不许再开一份重复键）
    for (const dict of ['zh', 'en', 'ja', 'ko']) {
      const s = fs.readFileSync(path.join(ROOT, `src/renderer/src/i18n/${dict}.ts`), 'utf8')
      expect(s.includes(`'common.glossaryList'`), `${dict} 缺 common.glossaryList`).toBe(true)
      expect(s.includes(`'common.translationHistory'`), `${dict} 多开了一份与 translate.history.title 重复的键`).toBe(false)
    }
  })
})
