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
// §270：33 → 30（收掉助手编辑器那三发：知识库／工具／技能——**三份不同数据，各挂一句、各给一颗键**，与 §269 的"并一张脸"相反）
// §271：30 → 26（收掉服务商那一族四发：渠道面板的服务商／助手两发＋设置页的服务商／委派能力判定两发。
//  跨两屏、四份不同数据 ⇒ 仍是"各挂一句、各给一颗键"那一族；两屏都没有"再点一下就重拉"的天然出口，故键不是多余机关）
// §272：26 → 23（收掉知识库问答那两屏三发：本库历史清单／自动清理保留策略／跨库漫游清单。
//  **这一簇只给两颗键**——历史那一发现查有天然出口（那颗「历史」按钮的 onClick 里 `if (!showHistory) refreshSessions()`），
//  按 §268 口径不造机关；策略那一发的脸是 §226 的第二形态「这里显示的是默认值」，不是 §222 的"整块没内容"）
// §273：23 → 19（收掉四个清单屏各一发：助手市场网格／技能市场本地 tab／技能表单的模板清单／用户记忆。
//  **这一簇两发全配键**——现查两处的自发重发都只在"写完东西之后"，没有一处是"点一下就重拉"）
const SILENT_READ_CAP = 17

const STILL_SILENT_PROOF = [
  'src/renderer/src/modules/chat/ChatView.tsx',
  // §274 起换成这一份：OllamaPanel 那一发已收干，再当"仍静默"的对照就是假证
  'src/renderer/src/components/Sidebar.tsx',
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
  // §270：助手编辑器那三发清单读收口（清零）。三份不同数据各挂一句、各给一颗键——
  // 这一屏"重开编辑器再拉"要丢掉整个表单，出口代价大到等于没出口，所以键不是多余机关
  'src/renderer/src/modules/chat/AssistantEditor.tsx': 0,
  'src/renderer/src/modules/agent/components/AgentComposer.tsx': 0,
  // §269：翻译页余下那三发（挂载读历史／翻译成功后刷新历史／挂载读术语表）收口（清零）。
  // 两发历史**并成一根 loader、共用一张脸**（同一份数据的两次取不该说两遍），术语表那句与那颗键是同一份 JSX，
  // 遮罩内外二选一渲染 ⇒ 同一时刻只一句、一键。
  'src/renderer/src/modules/translate/TranslateModule.tsx': 0,
  // §271：渠道面板挂载那两发（服务商／助手）收口（清零）。两发过去失败侧只写 state 的判真值写法
  // ⇒ 两枚下拉只剩占位项（「未绑定助手」／「请选择服务商」），把通道故障演成"你一个都没建"；
  // 而且服务商那发失败还会连带让下面「模型」下拉整块不出现 ⇒ 那句必须自己点明是哪一格
  'src/renderer/src/modules/agent/channels/ChannelsPanel.tsx': 0,
  // §271：设置页那两发（服务商清单／委派能力判定）收口（清零）。前者让左栏摆「尚未配置，点击「新增」」，
  // 后者让每行模型后面那枚徽标整块不出现（库里其实存着判定）。那颗「探测能否派活」是三发真请求、不是重读清单，
  // 所以它不是这两发的出口 ⇒ 各配一颗自己的键
  'src/renderer/src/modules/settings/ProviderSettings.tsx': 0,
  // §272：知识库问答面板那两发收口（清零）。历史清单那一发的出路是现成的——
  // 那颗「历史」按钮 onClick 里就有 `if (!showHistory) refreshSessions()`（现 :506，行号会漂、判据数的是那行本身）⇒ **不造重试键**；
  // 保留策略那一发只有挂载一处读，脸是 §226 的第二形态（那两个下拉照旧可编辑）⇒ 配一颗键
  'src/renderer/src/modules/knowledge/KbAskPanel.tsx': 0,
  // §272：跨库漫游那一发收口（清零）。它的"自发重发"是搜索框打字（防抖 200ms），
  // 那不是"想看列表"的人本来要做的动作 ⇒ 按 §268 判据配一颗键
  'src/renderer/src/modules/knowledge/KbAskRoam.tsx': 0,
  // §273：四个清单屏各一发收口（清零）。助手市场那一发失败时网格整片空白（原本连「真的没有」那句话都没有）；
  //  技能市场那发摆「还没有任何技能，点击「导入」或新建一个吧」——这句话正指着市场里那两颗导入键；
  //  用户记忆那发摆「暂无记忆」
  'src/renderer/src/modules/chat/AssistantMarket.tsx': 0,
  'src/renderer/src/modules/skills/SkillMarket.tsx': 0,
  'src/renderer/src/modules/settings/UserMemoryPanel.tsx': 0,
  // §273：技能表单的模板那一发收口（清零）。这一张的脸不是空态而是**入口整块不见**；改前那行注释写的是
  // 「失败仅记诊断日志，保持空列表不影响 UI」——回读 JSX 后确认这条判断错了，注释已就地改口（同 §268 那两条的手法）
  'src/renderer/src/modules/skills/SkillModule.tsx': 0,
  // §274：停在字面量默认两发收口（清零）。Ollama 面板镜像地址那一格失败时停在字面量默认值「空串」；
  //  MCP 面板 pip 源那一格失败时停在字面量默认值「官方」。两发的出路都是"关掉面板再开一次"⇒ 各配一颗键
  'src/renderer/src/components/OllamaPanel.tsx': 0,
  'src/renderer/src/modules/agent/mcp/usePipSource.ts': 0
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
    expect(SITES.length, '判定式总数（现查 362。这条数随写法归并/拆分而变、不是不变量，引用前现查：§266 那批 362、§267 加了三发各判一次成 363、§268 现查仍 363，§269 把翻译页"同一份数据的两次取"并成一根 loader ⇒ 少一条回到 362；§270 那批没单独现查（台账当时随全量一起跑，这条 message 未更新），§271／§272／§273 现查都仍 362——三批都是"判真值"换成"判失败对象"的同数换形，接管桶一路 307→310→314、静默桶 26→23→19）').toBeGreaterThan(300)
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

  it('§250~§274 逐批收口后，这几份文件的剩余静默数与登记相符', () => {
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
  it('§270 那三发的形状数得出（三份不同数据各一句一键、一处 loader 一通道、三张谎脸各只留一处、名词不重复开）', () => {
    const src = fs
      .readFileSync(path.join(ROOT, 'src/renderer/src/modules/chat/AssistantEditor.tsx'), 'utf8')
      .replace(/\r\n/g, '\n')
    const count = (re: RegExp): number => (src.match(re) ?? []).length

    // 三条清单各两条失败路写原因（resolve 的失败对象／reject），读到即收回
    expect(count(/set(?:Kbs|Tools|Skills)Unread\(\{ error: /g), '三发 × 两条失败路').toBe(6)
    expect(count(/set(?:Kbs|Tools|Skills)Unread\(null\)/g), '读到即收回三处').toBe(3)
    // 旧写法（裸交给 reportIpcError）在这份文件里彻底不见——§265 已证它对 safeHandle 的失败是死代码
    expect(count(/reportIpcError/g), '这一族不再留那一形').toBe(0)
    // 一根 loader 只发一个通道（三份数据没被并成一把梭）
    expect(count(/useCallback\(\(\) => \{/g), '三根 loader').toBe(3)
    for (const ch of ['listKnowledgeBases', 'listAvailableTools', 'listSkills']) {
      expect(count(new RegExp('window\\.pocketai\\.' + ch + '\\(\\)', 'g')), `${ch} 全文件只许一处发`).toBe(1)
    }

    // 三句真挂得出去：盯**渲染条件与所点名词成对**（§266 的 Z7 教训——数文案 token 会放过把守卫换成 `false &&` 那种写法）
    expect(count(/\{kbsUnread \? \(\s*\n\s*listFailLine\(t\('common\.kbList'\)/g), '知识库那句').toBe(1)
    expect(count(/\{skillsUnread \? \(\s*\n\s*listFailLine\(t\('common\.skillsList'\)/g), '技能那句').toBe(1)
    expect(count(/\{toolsUnread \? \(\s*\n\s*listFailLine\(t\('common\.toolsList'\)/g), '工具那句').toBe(1)

    // 三颗重试键各一颗（这一屏的出口代价＝丢掉整个表单，故不是多余机关；三处调用点各传自己的 testid 与 loader）
    expect(count(/'assistant-editor-kbs-retry'/g), '知识库那颗').toBe(1)
    expect(count(/'assistant-editor-tools-retry'/g), '工具那颗').toBe(1)
    expect(count(/'assistant-editor-skills-retry'/g), '技能那颗').toBe(1)
    // 键在 alert 盒子外面：工厂里 LoadFailNotice 在前、按钮在后
    expect(count(/const listFailLine[\s\S]{0,340}?<LoadFailNotice[\s\S]{0,240}?data-testid=\{testid\}/g), '那句在前、那颗键在后').toBe(1)

    // 三张「真的没有」的脸各只留一处（失败时它们让位，见行为用例；这里钉的是"别在别处再摆一份"）
    expect(count(/t\('ae\.no(?:Kb|Skills|Tools)'\)/g), '三份空态各一处').toBe(3)
    // 「不阻断」照旧：失败时那颗「全部允许」仍挂在自己的位置上，不被那句吃掉
    expect(count(/<button onClick=\{toggleAllowAll\}/g), '那颗键不随失败消失').toBe(1)

    // 名词不重复开：两份复用 §268 的 common.*，只新增一份 common.toolsList；四语都要有
    expect(count(/ae\.(?:kbList|skillsList|toolsList)/g), '不许为本批另开一套重复名词').toBe(0)
    for (const dict of ['zh', 'en', 'ja', 'ko']) {
      const s = fs.readFileSync(path.join(ROOT, `src/renderer/src/i18n/${dict}.ts`), 'utf8')
      expect(s.includes(`'common.toolsList'`), `${dict} 缺 common.toolsList`).toBe(true)
      expect(s.split(`'common.toolsList'`).length - 1, `${dict} 里这个键只许出现一次`).toBe(1)
    }
  })

  it('§271 那四发的形状数得出（跨两屏、四份数据各一句一键、一发失败不许替另一发闭嘴、空态让位、键不多造）', () => {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const ch = read('src/renderer/src/modules/agent/channels/ChannelsPanel.tsx')
    const ps = read('src/renderer/src/modules/settings/ProviderSettings.tsx')
    const inCh = (re: RegExp): number => (ch.match(re) ?? []).length
    const inPs = (re: RegExp): number => (ps.match(re) ?? []).length

    // ① 四发各两条失败路写原因（resolve 的失败对象／reject），读到即收回
    expect(inCh(/set(?:Providers|Assistants)Unread\(\{ error: /g), '渠道面板：两发 × 两条失败路').toBe(4)
    expect(inCh(/set(?:Providers|Assistants)Unread\(null\)/g), '渠道面板：读到即收回').toBe(2)
    expect(inPs(/set(?:Providers|Caps)Unread\(\{ error: /g), '设置页：两发 × 两条失败路').toBe(4)
    expect(inPs(/set(?:Providers|Caps)Unread\(null\)/g), '设置页：读到即收回').toBe(2)
    // §265 已证：safeHandle 把 throw 变成 resolve 的 `{ok:false}` ⇒ 裸 catch 助手是死代码，这两份文件里彻底不见
    expect(inCh(/reportIpcError/g), '渠道面板不留那一形').toBe(0)
    expect(inPs(/reportIpcError/g), '设置页不留那一形').toBe(0)
    // 一根 loader 只发一个通道（四份数据没被并成一把梭，也没在同屏再发第二遍）
    // 注意设置页那两根是 Prettier 折行的链式写法 ⇒ `\s*` 要吃掉换行与缩进
    const sends = (src: string, ch: string): number =>
      (src.match(new RegExp('window\\.pocketai\\s*\\.' + ch + '\\(\\)', 'g')) ?? []).length
    expect(sends(ch, 'listProviders'), '渠道面板：服务商一发').toBe(1)
    expect(sends(ch, 'listAssistants'), '渠道面板：助手一发').toBe(1)
    expect(sends(ps, 'listProviders'), '设置页：服务商一发').toBe(1)
    expect(sends(ps, 'listDelegateCapabilities'), '设置页：能力判定一发').toBe(1)

    // ② 四句真挂得出去：盯**渲染条件与所点名词成对**（§266 的 Z7 教训——只数文案 token 会放过 `false &&` 那种写法）
    expect(inCh(/\{providersUnread && \(\s*\n\s*<div[\s\S]{0,160}?<LoadFailNotice what=\{t\('common\.providersList'\)/g), '渠道面板那句服务商').toBe(1)
    expect(inCh(/\{assistantsUnread && \(\s*\n\s*<div[\s\S]{0,160}?<LoadFailNotice what=\{t\('common\.assistantsList'\)/g), '渠道面板那句助手').toBe(1)
    expect(inPs(/\{providersUnread && \(\s*\n\s*<div[\s\S]{0,160}?<LoadFailNotice what=\{t\('common\.providersList'\)/g), '设置页那句服务商').toBe(1)
    expect(inPs(/\{capsUnread && \(\s*\n\s*<div[\s\S]{0,160}?<LoadFailNotice what=\{t\('common\.capabilityVerdicts'\)/g), '设置页那句能力判定').toBe(1)

    // ③ 一发挂掉不许替另一发闭嘴：四个渲染条件都是自己的 state，没有 `||` 把两发并成一句
    expect(inCh(/(?:providers|assistants)Unread \|\|/g), '渠道面板：两发各说各的').toBe(0)
    expect(inPs(/(?:providers|caps)Unread \|\|/g), '设置页：两发各说各的').toBe(0)

    // ④ 四颗键各一颗，且**不多造**（这两屏的出口形状：渠道面板切网关类型不会重拉这两份清单；
    //    设置页那颗「探测能否派活」是三发真请求、不是重读清单 ⇒ 不能拿它当这一发的出口）
    expect(inCh(/"channels-(?:providers|assistants)-retry"/g), '渠道面板两颗').toBe(2)
    expect(inPs(/"provider-settings-(?:providers|caps)-retry"/g), '设置页两颗').toBe(2)
    expect(inCh(/agent\.retryRead/g), '渠道面板：一句一颗').toBe(2)
    expect(inPs(/agent\.retryRead/g), '设置页：一句一颗').toBe(2)
    // 「探测能否派活」长在子组件里，父屏那句吃不到它——这里钉的是"父屏的失败 state 不参与那颗键的渲染条件"
    expect(inPs(/!capsUnread/g), '能力判定读不到时不许把每行那颗探测键一起收掉').toBe(0)
    expect(read('src/renderer/src/modules/settings/DelegateCapabilityBadge.tsx').includes(`t('provider.capProbe')`), '那颗探测键仍在子组件里').toBe(true)

    // ⑤ 让位的那张谎脸只留一处：设置页空态在失败时收掉（渠道面板没有「你一个都没建」那种空态文案，
    //    它的谎长在 `<option value="">` 占位项上——那不是整块空态，改不了它，也不该改）
    expect(inPs(/\{providers\.length === 0 && !providersUnread && \(\s*\n\s*<p className="text-xs text-\[var\(--color-text-muted\)\]">\{t\('provider\.empty'\)\}/g), '空态让位那处').toBe(1)
    expect(inPs(/\bprovidersUnread\b/g), '服务商那份 state 只出现在：声明／那句的条件／那句的措辞／让位那一处').toBe(4)
    expect(inPs(/\bcapsUnread\b/g), '能力判定那份 state 只出现在：声明／那句的条件／那句的措辞').toBe(3)

    // ⑥ 名词不重复开：三份复用既有 common.*，只新增 common.capabilityVerdicts 一份，四语都要有
    for (const dict of ['zh', 'en', 'ja', 'ko']) {
      const s = read(`src/renderer/src/i18n/${dict}.ts`)
      expect(s.includes(`'common.capabilityVerdicts'`), `${dict} 缺 common.capabilityVerdicts`).toBe(true)
      expect(s.split(`'common.capabilityVerdicts'`).length - 1, `${dict} 里这个键只许出现一次`).toBe(1)
      expect(s.includes(`'common.providerList'`), `${dict} 不许为服务商另开一名`).toBe(false)
    }
  })

  it('§272 那三发的形状数得出（两屏三份数据、两句两种脸、键该有 2 不该有 3、天然出口那行必须在场）', () => {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const panel = read('src/renderer/src/modules/knowledge/KbAskPanel.tsx')
    const roam = read('src/renderer/src/modules/knowledge/KbAskRoam.tsx')
    const inPanel = (re: RegExp): number => (panel.match(re) ?? []).length
    const inRoam = (re: RegExp): number => (roam.match(re) ?? []).length

    // ① 三发各两条失败路写原因（resolve 的失败对象／reject），读到即收回
    expect(inPanel(/set(?:Sessions|Retention)Unread\(\{ error: /g), '面板：两发 × 两条失败路').toBe(4)
    expect(inPanel(/set(?:Sessions|Retention)Unread\(null\)/g), '面板：读到即收回').toBe(2)
    expect(inRoam(/setItemsUnread\(\{ error: /g), '漫游：两条失败路').toBe(2)
    expect(inRoam(/setItemsUnread\(null\)/g), '漫游：读到即收回').toBe(1)
    // 这一族不再把 reject 裸交给助手（数的是**调用**，import 那半截不算）；面板里剩的那一条是 §221 故意留的
    // "会话持久化失败只留痕"，不是这一批的漏收
    expect(inPanel(/reportIpcError\(/g), '面板只许剩 §221 那一条调用').toBe(1)
    expect(inRoam(/reportIpcError/g), '漫游连那一形都不留').toBe(0)
    // 一根 loader 只发一个通道
    for (const ch of ['listKbAskSessions', 'searchKbAskSessions', 'getKbAskRetention']) {
      expect(inPanel(new RegExp('window\\.pocketai\\s*\\.' + ch + '\\(', 'g')), `面板：${ch} 只许一处发`).toBe(1)
    }
    for (const ch of ['listAllKbAskSessions', 'searchAllKbAskSessions']) {
      expect(inRoam(new RegExp('window\\.pocketai\\s*\\.' + ch + '\\(', 'g')), `漫游：${ch} 只许一处发`).toBe(1)
    }

    // ② 三句真挂得出去：渲染条件与所点名词成对；**两张不同的脸不许混**——
    //    面板里那份没内容的用 §222 的 LoadFailNotice，那份"停在字面量默认且可编辑"的用 §226 的 ShowingDefaultsNotice
    expect(inPanel(/\{sessionsUnread && \(\s*\n\s*<LoadFailNotice what=\{t\('kb\.askHistory'\)/g), '面板那句历史').toBe(1)
    expect(inPanel(/\{retentionUnread && \(\s*\n\s*<div[\s\S]{0,160}?<ShowingDefaultsNotice\s*\n\s*what=\{t\('kb\.askRetention'\)/g), '面板那句策略（第二形态）').toBe(1)
    expect(inRoam(/\{itemsUnread && \(\s*\n\s*<div[\s\S]{0,160}?<LoadFailNotice what=\{t\('kb\.roamTitle'\)/g), '漫游那句').toBe(1)
    expect(inPanel(/<ShowingDefaultsNotice/g), '第二形态只用在这一发上').toBe(1)
    expect(inRoam(/<ShowingDefaultsNotice/g), '漫游那份是真没内容，不许套第二形态').toBe(0)

    // ③ 键的两头钉：策略与漫游各一颗（这两发都没有"点一下就重发"的出口），
    //    而历史那一颗**不许存在**——它的出口是那行 `if (!showHistory) refreshSessions()`
    expect(inPanel(/"kb-ask-retention-retry"/g), '策略那颗').toBe(1)
    expect(inRoam(/"kb-ask-roam-retry"/g), '漫游那颗').toBe(1)
    expect(inPanel(/kb-ask-sessions-retry/g), '历史那一发不造机关').toBe(0)
    expect(inPanel(/agent\.retryRead/g), '面板一句一颗').toBe(1)
    expect(inRoam(/agent\.retryRead/g), '漫游一句一颗').toBe(1)
    // "不造键"的前提是那行代码还在；哪天它被改掉，这条就得红（而不是让那句变成没出路的话）
    expect(inPanel(/^ {12}if \(!showHistory\) refreshSessions\(\)$/gm), '展开历史面板就是重拉这一发').toBe(1)

    // ④ 让位与不报数：两张「真的没有」的脸各只留一处；那颗按钮读不到就**不报条数**（§269 同一条）
    expect(inPanel(/\{sessionList\.length === 0 && !sessionsUnread && \(/g), '历史空态让位').toBe(1)
    expect(inPanel(/t\('kb\.askNoSessions'\)/g), '那张空态只许出现一次').toBe(1)
    expect(inPanel(/（\$\{sessionList\.length\}）/g), '按钮上的条数只许出现在"读到了"那一支').toBe(1)
    // 钉**条件式本身**（§266 的 Z7 手法）：只数那个 token 会放过"两支都报数"的写法
    expect(inPanel(/\{sessionsUnread \? t\('kb\.askHistory'\) : `\$\{t\('kb\.askHistory'\)\}（\$\{sessionList\.length\}）`\}/g), '不报数只发生在读不到那一支').toBe(1)
    expect(inRoam(/\{items\.length === 0 && !itemsUnread \? \(/g), '漫游空态让位').toBe(1)
    expect(inRoam(/t\('kb\.roamEmpty'\)/g), '那张空态只许出现一次').toBe(1)

    // ⑤ 名词零新增：三句都复用屏上标题，四本字典都不许为这一批另开键
    for (const dict of ['zh', 'en', 'ja', 'ko']) {
      const s = read(`src/renderer/src/i18n/${dict}.ts`)
      for (const banned of [`'common.kbAskSessionsList'`, `'common.kbAskRetention'`, `'common.kbRoamList'`]) {
        expect(s.includes(banned), `${dict} 不许另开与屏上标题重复的名词 ${banned}`).toBe(false)
      }
      for (const reused of [`'kb.askHistory'`, `'kb.askRetention'`, `'kb.roamTitle'`]) {
        expect(s.includes(reused), `${dict} 缺屏上标题 ${reused}（三句都靠它点名）`).toBe(true)
      }
    }
  })

  it('§273 那四发的形状数得出（四屏各一句一键、模板那颗入口不许被吃掉、四张空态各留一处且带让位、新名词只一份）', () => {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const am = read('src/renderer/src/modules/chat/AssistantMarket.tsx')
    const sm = read('src/renderer/src/modules/skills/SkillMarket.tsx')
    const sk = read('src/renderer/src/modules/skills/SkillModule.tsx')
    const um = read('src/renderer/src/modules/settings/UserMemoryPanel.tsx')
    const n = (src: string, re: RegExp): number => (src.match(re) ?? []).length

    // ① 四发各两条失败路写原因（resolve 的失败对象／reject），读到即收回
    expect(n(am, /setAssistantsUnread\(\{ error: /g), '助手市场：两条失败路').toBe(2)
    expect(n(sm, /setSkillsUnread\(\{ error: /g), '技能市场：两条失败路').toBe(2)
    expect(n(sk, /setTemplatesUnread\(\{ error: /g), '技能表单：两条失败路').toBe(2)
    expect(n(um, /setItemsUnread\(\{ error: /g), '用户记忆：两条失败路').toBe(2)
    expect(n(am, /setAssistantsUnread\(null\)/g), '助手市场：读到即收回').toBe(1)
    expect(n(sm, /setSkillsUnread\(null\)/g), '技能市场：读到即收回').toBe(1)
    expect(n(sk, /setTemplatesUnread\(null\)/g), '技能表单：读到即收回').toBe(1)
    expect(n(um, /setItemsUnread\(null\)/g), '用户记忆：读到即收回').toBe(1)
    // 两份市场文件里 `reportIpcError` 归零；另两份**按"还剩几条"断言**（那几条不是本批的漏收：
    //   技能模块余 syncSkills／listSkillFiles／validateSkill 三条，用户记忆余删除那一条，都是 §224 那批定的留痕）
    expect(n(am, /reportIpcError/g), '助手市场不留那一形').toBe(0)
    expect(n(sm, /reportIpcError/g), '技能市场不留那一形').toBe(0)
    expect(n(sk, /reportIpcError\(/g), '技能模块余那三条留痕').toBe(3)
    expect(n(um, /reportIpcError\(/g), '用户记忆余删除那一条留痕').toBe(1)
    // 一根 loader 只发一个通道
    expect(n(am, /window\.pocketai\s*\.listAssistants\(/g), '助手市场一发').toBe(1)
    expect(n(sm, /window\.pocketai\s*\.listSkills\(/g), '技能市场一发').toBe(1)
    expect(n(sk, /window\.pocketai\s*\.getSkillTemplates\(/g), '技能模板一发').toBe(1)
    expect(n(um, /window\.pocketai\s*\.listMemories\(/g), '用户记忆一发').toBe(1)

    // ② 四句真挂得出去：渲染条件与所点名词成对（这一簇四份都是"真没读到"，所以全用 §222 的 LoadFailNotice，
    //    没有 §226 的第二形态——那一档要的是"值还在且可改"，这四格都不成立）
    expect(n(am, /\{view\.mode === 'grid' && assistantsUnread && \(\s*\n\s*<div[\s\S]{0,220}?<LoadFailNotice what=\{t\('common\.assistantsList'\)/g), '助手市场那句').toBe(1)
    expect(n(sm, /\{tab === 'local' && skillsUnread && \(\s*\n\s*<div[\s\S]{0,220}?<LoadFailNotice what=\{t\('common\.skillsList'\)/g), '技能市场那句').toBe(1)
    expect(n(sk, /\{!skill && templatesUnread && \(\s*\n\s*<div[\s\S]{0,260}?<LoadFailNotice\s*\n\s*what=\{t\('common\.skillTemplatesList'\)/g), '技能模板那句').toBe(1)
    expect(n(um, /\{itemsUnread && \(\s*\n\s*<div[\s\S]{0,180}?<LoadFailNotice what=\{t\('set\.memory'\)/g), '用户记忆那句').toBe(1)

    // ③ 四颗键各一颗、每屏只这一颗（与 §272 相反：这四发的自发重发都只在"写完东西之后"）
    expect(n(am, /"assistant-market-assistants-retry"/g), '助手市场那颗').toBe(1)
    expect(n(sm, /"skill-market-skills-retry"/g), '技能市场那颗').toBe(1)
    expect(n(sk, /"skill-form-templates-retry"/g), '技能模板那颗').toBe(1)
    expect(n(um, /"user-memory-retry"/g), '用户记忆那颗').toBe(1)
    expect(n(am, /agent\.retryRead/g), '助手市场一句一颗').toBe(1)
    expect(n(sm, /agent\.retryRead/g), '技能市场一句一颗').toBe(1)
    expect(n(sk, /agent\.retryRead/g), '技能模块一句一颗（多了就是给不该有机关的地方造键）').toBe(1)
    expect(n(um, /agent\.retryRead/g), '用户记忆一句一颗').toBe(1)

    // ④ 「真的没有」那张脸各留一处且带让位；**模板这一发钉的是入口不许被吃掉**（本簇最隐蔽的一张脸）
    expect(n(sm, /tab === 'local' && skillsUnread/g), '技能市场：让位那一处＋那句那一处（成对，缺一处就红）').toBe(2)
    expect(n(sm, /t\('skill\.market\.empty'\)/g), '技能市场空态只一处').toBe(1)
    expect(n(um, /\{items\.length === 0 && !itemsUnread \? \(/g), '用户记忆空态让位').toBe(1)
    expect(n(um, /t\('set\.memoryEmpty'\)/g), '那张空态只一处').toBe(1)
    expect(n(sk, /\{!skill && !templatesUnread && templates\.length > 0 && \(/g), '入口只在"读到了且真有"时出现').toBe(1)
    expect(n(sk, /'\+ 从模板创建'/g), '那颗入口本身还在（按钮文案是硬编码中文，属既有债，见台账 §273）').toBe(1)
    // 助手市场原本**没有**「真的没有」那张脸（那片空白就是它的脸）⇒ 反向钉：本批不顺手再造一种状态
    expect(n(am, /length === 0/g), '本批不给助手市场造空态，只加那句').toBe(0)

    // ⑤ 名词只新增一份，其余复用既有；四本字典都不许再为市场另开一名
    for (const dict of ['zh', 'en', 'ja', 'ko']) {
      const s = read(`src/renderer/src/i18n/${dict}.ts`)
      expect(s.includes(`'common.skillTemplatesList'`), `${dict} 缺 common.skillTemplatesList`).toBe(true)
      expect(s.split(`'common.skillTemplatesList'`).length - 1, `${dict} 里这个键只许出现一次`).toBe(1)
      for (const banned of [`'common.marketAssistants'`, `'common.marketSkills'`, `'common.userMemoryList'`]) {
        expect(s.includes(banned), `${dict} 不许另开与既有名词重复的 ${banned}`).toBe(false)
      }
      for (const reused of [`'common.assistantsList'`, `'common.skillsList'`, `'set.memory'`]) {
        expect(s.includes(reused), `${dict} 缺复用的屏上名词 ${reused}`).toBe(true)
      }
    }
  })
})

describe('§274 形状：停在字面量默认两发（镜像地址＋pip 源）', () => {
  const n = (src: string, re: RegExp): number => (src.match(re) ?? []).length
  const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

  it('两发都用 §226 第二形态（ShowingDefaultsNotice）＋各配一颗键', () => {
    const ollama = read('src/renderer/src/components/OllamaPanel.tsx')
    const pip = read('src/renderer/src/modules/agent/mcp/usePipSource.ts')
    const mcp = read('src/renderer/src/modules/agent/mcp/McpPanel.tsx')

    // ① 两发都判失败对象（hasIpcFailed）＋失败侧写状态（setMirrorUnread/setPipSourceUnread）
    expect(n(ollama, /if \(hasIpcFailed\(r\)\) \{\s*\n\s*setMirrorUnread/g), '镜像那一发判失败对象').toBe(1)
    expect(n(pip, /if \(hasIpcFailed\(r\)\) \{\s*\n\s*setPipSourceUnread/g), 'pip 源那一发判失败对象').toBe(1)

    // ② 两发都用 §226 第二形态（ShowingDefaultsNotice），不是 §222（LoadFailNotice）
    expect(n(ollama, /<ShowingDefaultsNotice what=\{t\('ollama\.mirror'\)/g), '镜像那句用 §226 形态').toBe(1)
    expect(n(mcp, /<ShowingDefaultsNotice what=\{t\('agent\.f\.pipSource'\)/g), 'pip 源那句用 §226 形态').toBe(1)

    // ③ 两颗键各一颗、每屏只这一颗
    expect(n(ollama, /data-testid="ollama-mirror-retry"/g), '镜像那颗键只一颗').toBe(1)
    expect(n(mcp, /data-testid="mcp-pip-source-retry"/g), 'pip 源那颗键只一颗').toBe(1)

    // ④ 两颗键都点 reload 回调（不是 load 本身）
    expect(n(ollama, /onClick=\{reloadMirror\}/g), '镜像那颗键点 reload').toBe(1)
    expect(n(mcp, /onClick=\{pip\.reloadPipSource\}/g), 'pip 源那颗键点 reload').toBe(1)

    // ⑤ 两发的 loader 都是 useCallback（防 effect 重跑）
    expect(n(ollama, /const loadMirror = useCallback\(\(\) =>/g), '镜像 loader 是 useCallback').toBe(1)
    expect(n(pip, /const loadPipSource = useCallback\(\(\) =>/g), 'pip 源 loader 是 useCallback').toBe(1)

    // ⑥ 两发的 reload 回调都先清 unread 再 load
    expect(n(ollama, /const reloadMirror = useCallback\(\(\) => \{\s*\n\s*setMirrorUnread\(null\)\s*\n\s*loadMirror\(\)/g), '镜像 reload 先清 unread').toBe(1)
    expect(n(pip, /const reloadPipSource = useCallback\(\(\) => \{\s*\n\s*setPipSourceUnread\(null\)\s*\n\s*loadPipSource\(\)/g), 'pip 源 reload 先清 unread').toBe(1)

    // ⑦ 镜像那发的保存成功路径清 unread（防保存成功后那句仍挂着）
    expect(n(ollama, /if \(r\.ok\) \{\s*\n\s*setMirror\(mirrorDraft\.trim\(\)\)\s*\n\s*setMirrorUnread\(null\)/g), '镜像保存成功清 unread').toBe(1)
  })
})
