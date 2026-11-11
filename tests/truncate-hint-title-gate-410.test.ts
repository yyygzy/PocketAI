// @vitest-environment node
// §410 常驻闸门：挂在 `truncate` 容器上的**整句说明**必须带 `title`。
//
// 来路＝§409 真机轮：Agent 工具那屏的行内说明（联网搜索那行 68 字、日历那行 36 字）在 298px 宽的浮层里
// 四语都被裁掉尾巴，被裁的半句还是安全限定语（「地址仅存本机，请确认实例可信」），而那个 span 没有 title
// ⇒ 悬停也补不回。**CI 为什么拦不住**＝jsdom 不做布局，`getByText(/整句/)` 匹配的是 DOM 文本，
// truncate 只裁渲染不裁文本⇒这一档只有真机看得见。本枚把"看得见"的那半搬进 CI＝钉**结构**
// （类名里还有没有 truncate、title 在不在、title 与正文是不是同一份量），**不钉几何**（几何仍只有真机量得出）。
//
// 判据口径（三把尺子，全部读 AST，不读行文本——自己写的注释会把同一串撑大＝第 33 条）：
//   ① 这个 JSX 元素的 `className` 里出现 `truncate`（Tailwind 那把 `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`）；
//   ② 它**会被渲染**的文本全部出自字典串＝每个渲染叶子都是 `t('key')`（允许带 `{n}` 这类插值参数）
//      或纯标点／空白／符号的分隔字面量（`' · '`、`'🔤 '`）；出现任何"不是 t() 取出来的数据"
//      （变量、属性访问、方法调用、含字母或汉字的字面量）⇒算「混合位」，本面不收（那一档裁的是数据，
//      补不补 title 是另一个问题，名单与数量在本文件末尾如实报出）；
//      **只看会被渲染的那一侧**：三元只看两个分支、`a && b` 只看 b（a 是条件不是文本）、`a || b`／`a ?? b` 两侧都算。
//   ③ 该元素自己没有 `title` 属性 ⇒ 进名单＝待收的缺陷位。
// 两头钉：
//   · 名单用**等式**钉（比身份不比长度＝多一颗少一颗都红），每条身份＝`相对路径#排序后的键集合`
//     （不按行号＝行号会随无关改动漂，§399②b 那条通则）；
//   · 五段 fixture 喂进同一个分类器，必须各落各桶（漏杀对照＝"抓不到改前形状"当场暴露）。
// 反向钉住本枚修的两颗＝它们已经不在 truncate 位总体里了，所以另起一颗判据直接盯那两行的形状。
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const RENDERER = 'src/renderer/src'
const BARS = 'src/renderer/src/modules/chat/AgentToolBars.tsx'

const walkDir = function* (dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) yield* walkDir(p)
    else if (name.endsWith('.tsx')) yield p
  }
}

const attrsOf = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Map<string, ts.JsxAttribute> => {
  const m = new Map<string, ts.JsxAttribute>()
  for (const prop of el.attributes.properties) if (ts.isJsxAttribute(prop)) m.set(prop.name.getText(), prop)
  return m
}
const clsOf = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string => {
  const c = attrsOf(el).get('className')
  return c && c.initializer ? c.initializer.getText() : ''
}
/** 是不是「取字典句」那一发调用（`t('k')` 或 `x.t('k')`） */
const isT = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) &&
  ((ts.isIdentifier(n.expression) && n.expression.text === 't') || n.expression.getText().endsWith('.t'))
/** 分隔符字面量＝不含任何字母与数字（`' · '`、`'🔤 '`、换行缩进都算，`'共 3 条'` 不算） */
const isSeparator = (s: string): boolean => s.trim() === '' || !/[\p{L}\p{N}]/u.test(s)
const keysOf = (node: ts.Node, out: string[] = []): string[] => {
  if (isT(node)) {
    const a = node.arguments[0]
    out.push(a && ts.isStringLiteral(a) ? a.text : '(动态 key)')
  }
  node.getChildren().forEach((c) => keysOf(c, out))
  return out
}

/**
 * 一个"会被渲染"的表达式拆成 {字典键, 数据叶子数}。
 * `bindings`＝本文件里 `const NAME = <表达式>` 的表：**句子被提成变量是合法的写法，但会让这颗位看上去"没有句子"**，
 * 所以碰到标识符要先爬到它的定义去读（不爬＝"把 t() 挪进 const" 就成了一条绕过这面闸门的道，§410 牙齿轮撞出来的洞）。
 * 循环与深度都设闸（自引用／互引用的变量不该把 walk 卡死）。
 */
function rendered(expr: ts.Expression, bindings: Map<string, ts.Expression> = new Map(), depth = 0, seen?: Set<string>): { keys: string[]; data: number } {
  const keys: string[] = []
  let data = 0
  const visited = seen ?? new Set<string>()
  const walk = (n: ts.Node): void => {
    if (isT(n)) {
      keysOf(n, keys)
      return
    }
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) return walk(n.expression)
    if (ts.isConditionalExpression(n)) return void (walk(n.whenTrue), walk(n.whenFalse))
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return walk(n.right)
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      )
        return void (walk(n.left), walk(n.right))
      data++
      return
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (!isSeparator(n.text)) data++
      return
    }
    if (ts.isTemplateExpression(n)) {
      const literal = n.head.text + n.templateSpans.map((s) => s.literal.text).join('')
      if (!isSeparator(literal)) data++
      data += n.templateSpans.length
      return
    }
    if (ts.isJsxText(n)) {
      if (!isSeparator(n.getText())) data++
      return
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      keysOf(n, keys)
      if (ts.isJsxElement(n))
        n.children.forEach((c) => {
          if (ts.isJsxText(c)) {
            if (!isSeparator(c.getText())) data++
          } else walk(c)
        })
      return
    }
    if (ts.isIdentifier(n)) {
      const target = bindings.get(n.text)
      if (target && depth < 4 && !visited.has(n.text)) {
        const next = new Set(visited)
        next.add(n.text)
        const r = rendered(target, bindings, depth + 1, next)
        keys.push(...r.keys)
        data += r.data
        return
      }
      data++
      return
    }
    if (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n) || ts.isElementAccessExpression(n)) {
      data++
      return
    }
    n.getChildren().forEach(walk)
  }
  walk(expr)
  return { keys, data }
}

/** 本文件里的 `const NAME = <表达式>`（只收一条声明、有初始值的；解构与函数先不算） */
function constBindings(sf: ts.SourceFile): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>()
  const scan = (n: ts.Node): void => {
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && !m.has(d.name.text)) m.set(d.name.text, d.initializer)
      }
      return
    }
    n.getChildren().forEach(scan)
  }
  scan(sf)
  return m
}

export type Site = {
  file: string
  line: number
  ownTitle: boolean
  keys: string[]
  data: number
  /** 只用于报告：这些键里最长的中文句有多长（判"值不值得真机量"用，不进判据） */
  maxZh: number
}

/** 分类器本体：源码文本进，四桶出（fixture 与真源码走同一条路） */
function classify(source: string, fileLabel: string): Site[] {
  const sf = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const bindings = constBindings(sf)
  const rows: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node
      if (clsOf(open).includes('truncate')) {
        const ownTitle = attrsOf(open).has('title')
        const keys: string[] = []
        let data = 0
        const children = ts.isJsxElement(node) ? node.children : []
        children.forEach((ch) => {
          if (ts.isJsxText(ch)) {
            if (!isSeparator(ch.getText())) data++
          } else if (ts.isJsxExpression(ch) && ch.expression) {
            const r = rendered(ch.expression, bindings)
            keys.push(...r.keys)
            data += r.data
          } else data++
        })
        rows.push({
          file: fileLabel,
          line: source.slice(0, node.getStart()).split('\n').length,
          ownTitle,
          keys: [...new Set(keys)].sort(),
          data,
          maxZh: 0
        })
        return
      }
    }
    node.getChildren().forEach(visit)
  }
  visit(sf)
  return rows
}

const zhPath = path.join(ROOT, 'src/renderer/src/i18n/zh.ts')
const zhLens = ((): Record<string, number> => {
  const src = fs.readFileSync(zhPath, 'utf-8')
  const out: Record<string, number> = {}
  const re = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const key = m[1]
    const val = m[2]
    if (key && val) out[key] = [...val].length
  }
  return out
})()

const ALL: Site[] = []
for (const f of walkDir(path.join(ROOT, RENDERER))) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  for (const r of classify(fs.readFileSync(f, 'utf-8'), rel)) {
    r.maxZh = Math.max(0, ...r.keys.map((k) => zhLens[k] ?? 0))
    ALL.push(r)
  }
}

const pureSentence = ALL.filter((r) => r.keys.length > 0 && r.data === 0)
const badSites = pureSentence.filter((r) => !r.ownTitle)
const goodSites = pureSentence.filter((r) => r.ownTitle)
const mixedSites = ALL.filter((r) => r.keys.length > 0 && r.data > 0)
const dataSites = ALL.filter((r) => r.keys.length === 0)
/** 名单身份＝路径＋排序后的键集合（行号不进身份＝它会随无关改动漂，§399②b 通则） */
const ident = (r: Site): string => `${r.file}#${r.keys.join(',')}`

describe('§410 闸门：truncate 位上的整句说明必须带 title', () => {
  it('四桶守恒：纯句子＋混合＋纯数据＝truncate 位总数（分类器没有漏桶的形状）', () => {
    expect(pureSentence.length + mixedSites.length + dataSites.length, '四桶守恒').toBe(ALL.length)
    expect(
      [ALL.length, pureSentence.length, goodSites.length, badSites.length, mixedSites.length, dataSites.length].join('/'),
      `现数 truncate位/纯句子（有title/没title）/混合/纯数据 ＝ ${ALL.length}/${pureSentence.length}（${goodSites.length}/${badSites.length}）/${mixedSites.length}/${dataSites.length}`
    // V4 交互改造：输入区「+」菜单新增 2 颗 truncate 位（模型行元信息那 1 颗混合＋列表项那 1 颗纯数据）⇒ 96→98。
    // 工作目录快捷入口移入「允许调用工具」行：路径 basename（数据）与未选提示（字典句）同挂 1 颗 truncate ⇒ 98→99。
    // 技能分类/标签提交：SkillModule 技能列表行的 truncate 容器里新增了 {s.category} / #{tag}
    //   两个直接数据表达式，状态句又被包进内层 <span>；分类器只从「直接表达式子节点」收 t() 键，
    //   内层 JSX 一律记作数据 ⇒ 该位从纯句子移入纯数据：纯句子 6→5、没 title 名单 5→4、纯数据 81→82。
    //   总数 99 不变（它没离开 truncate 族，只换了桶）。
    // 技能扫描报告（并行会话的 SkillScanReport.tsx:72）新增 1 颗纯数据 truncate 位（技能名，已带 title）
    //   ⇒ 总数 99→100、纯数据 82→83。设置页签改造本身不新增 truncate 位，只让同文件行号漂移。
    // 数据健康五块收进主面板（5414f42「refactor(steward): 冷数据/快照/审批计数并入数据健康卡」）：
    //   4fa1e4a 删的是启动/性能等五块，BarRow 当时仍被「体积明细」「冷数据」使用，所以还留着；
    //   5414f42 把这两处使用点也删掉后，DataHealthPanel 的 BarRow 组件整体删除，组件里唯一那颗
    //   `<span className="... truncate" title={label}>{label}</span>`（子节点是 label 标识符、
    //   自带 title ⇒ 纯数据位）随之消失 ⇒ 总数 100→99、纯数据 83→82；其余三桶不变。
    //   该提交没有同步本闸门（git log 本文件最后改动仍是 4fa1e4a），本次按实测补账。
    ).toBe('99/5/1/4/12/82')
  })

  it('名单等式：4 颗「整句说明挂在 truncate 且没 title」逐颗认身份，多一颗少一颗都红', () => {
    const PINNED = [
      // ── 本枚未收（同屏之外），逐颗如实写"没量过＝未判定"，不许写成"不适用"──
      'src/renderer/src/modules/settings/SettingsModule.tsx#upd.autoUpdateHint', // 21 字，设置→自动更新那行
      'src/renderer/src/modules/knowledge/KnowledgeModule.tsx#kb.chunkPreview', // 14 字＋{title} 插值，弹窗标题
      'src/renderer/src/modules/settings/ProviderSettings.tsx#provider.nModels', // 7 字＋{n}，服务商列表行
      'src/renderer/src/popup/PopupApp.tsx#popup.titleQuick,popup.titleSelection' // 4 字，浮窗标题栏
      // 技能分类/标签提交移出：SkillModule.tsx#skill.off,skill.on —— 该 truncate 容器现在同时挂
      //   {s.category} / #{tag} 数据，状态句也被包进内层 <span>；分类器按「直接表达式子节点」收键、
      //   内层 JSX 记作数据 ⇒ 它已不属纯句子桶（现按实测记在纯数据 82 里），不再是本名单的一颗。
      // P4 批次 2 移出：AgentModelBar.tsx#agent.noModelsHint、AgentComposer.tsx#agent.toolConfig —— 文件已删。
      // §436 移出：ConversationList.tsx#chat.exportMultiCount —— 15c0101 已把 truncate 换成
      //   shrink-0 whitespace-nowrap（多选计数不再被压成 0 宽），它已不在 truncate 族里。
      // §416 移出：SessionRail.tsx#chat.exportMultiCount —— 与对话屏对齐成同构写法后，同样不在 truncate 族里。
    ].sort()
    const now = badSites.map(ident).sort()
    expect(now.join('\n'), `现数 ${now.length} 颗：\n${now.join('\n')}`).toBe(PINNED.join('\n'))
  })

  it('反向钉本枚修的两颗：那两句的类名里不再出现 truncate，且 title 与正文取同一份量（两处同源）', () => {
    const src = fs.readFileSync(path.join(ROOT, BARS), 'utf-8')
    const sf = ts.createSourceFile(BARS, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found: Array<{ name: string; same: boolean; clsHasTruncate: boolean }> = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node)) {
        const open = node.openingElement
        const title = attrsOf(open).get('title')
        const kids = node.children.filter(
          (c): c is ts.JsxExpression => ts.isJsxExpression(c) && !!c.expression && ts.isIdentifier(c.expression)
        )
        if (title && title.initializer && ts.isJsxExpression(title.initializer) && title.initializer.expression) {
          const tname = title.initializer.expression.getText()
          if (tname === 'wsHint' || tname === 'calHint') {
            const only = kids.length === 1 ? kids[0] : undefined
            const same = !!only && only.expression?.getText() === tname
            found.push({ name: tname, same, clsHasTruncate: clsOf(open).includes('truncate') })
          }
        }
      }
      node.getChildren().forEach(visit)
    }
    visit(sf)
    expect(found.map((f) => f.name).sort().join(','), '那两行都在（一处漏了＝这句又被挂回 truncate）').toBe('calHint,wsHint')
    for (const f of found) {
      expect(f.same, `${f.name}：title 与正文必须是同一个量（两份手写会漂）`).toBe(true)
      expect(f.clsHasTruncate, `${f.name}：类名里又出现 truncate＝又要被裁`).toBe(false)
    }
  })

  it('读法自证：五段 fixture 各落各桶（抓不到改前形状＝这面闸门是哑的）', () => {
    // ① 改前形状＝纯句子挂 truncate 且没 title ⇒ 必须被抓
    const before = classify('<span className="text-[11px] min-w-0 flex-1 truncate">{ok ? t("a.hintOn") : t("a.hintOff")}</span>', 'f1.tsx')
    expect(before.length, '①改前形状必须产出一颗位').toBe(1)
    expect([before[0]?.ownTitle, before[0]?.data, before[0]?.keys.join(',')].join('/'), '①桶位').toBe('false/0/a.hintOff,a.hintOn')

    // ② 修后形状＝同一个量供两处 ⇒ 纯句子且有 title（不进名单）
    const after = classify('<span className="text-[11px] min-w-0 flex-1" title={hint}>{hint}</span>', 'f2.tsx')
    expect(after.length, '②去 truncate 后不再是 truncate 位＝总体里消失').toBe(0)
    const after2 = classify('<span className="truncate" title={hint}>{hint}</span>', 'f2b.tsx')
    expect([after2.length, after2[0]?.ownTitle].join('/'), '②b 带 title 的纯句子＝合规不进门').toBe('1/true')

    // ③ 混合位（句子＋数据同挂一处）＝本面不收，但必须数得出（不然"0 颗"是失明）
    const mixed = classify('<span className="truncate">{n.title || t("notes.untitled")}</span>', 'f3.tsx')
    expect([mixed.length, mixed[0]?.keys.length, mixed[0]?.data].join('/'), '③混合位').toBe('1/1/1')

    // ④ 条件里的变量不算文本：`{cond && t('k')}` 仍是纯句子（第一版把条件当数据就会全漏）
    const onlyCond = classify('<span className="truncate">{enabled && t("skill.on")}</span>', 'f4.tsx')
    expect([onlyCond.length, onlyCond[0]?.data, onlyCond[0]?.keys.join(',')].join('/'), '④短路只看右半边').toBe('1/0/skill.on')

    // ⑤ 插值参数不算数据：`t('k', { n })` 还是纯句子；模板串里塞变量才是混合
    const withParam = classify('<span className="truncate">{t("chat.exportMultiCount", { n: sel.length })}</span>', 'f5.tsx')
    expect([withParam.length, withParam[0]?.data].join('/'), '⑤带插值参数的整句仍算句子').toBe('1/0')
    const tpl = classify('<span className="truncate">{`前缀 ${name}`}</span>', 'f6.tsx')
    expect([tpl.length, tpl[0]?.data].join('/'), '⑤b 模板串塞变量＝混合').toBe('1/2')

    // ⑥ 分隔符字面量不算数据（②里那把 `' · '` 尺子）：整句拼接仍是纯句子
    const joined = classify('<span className="truncate">{t("a.on") + " · " + t("a.deep")}</span>', 'f9.tsx')
    expect([joined.length, joined[0]?.data, joined[0]?.keys.join(',')].join('/'), '⑥" · "是分隔符不是数据').toBe('1/0/a.deep,a.on')

    // ⑦ 句子被提成 `const`＝分类器要爬回定义处（不爬＝"把 t() 挪进变量"是一条绕过这面闸门的道）
    const hoisted = classify(
      'const hint = ok ? t("a.on") : t("a.off")\nexport const C = () => <span className="min-w-0 flex-1 truncate">{hint}</span>',
      'f10.tsx'
    )
    expect([hoisted.length, hoisted[0]?.data, hoisted[0]?.keys.join(','), hoisted[0]?.ownTitle].join('/'), '⑦提成变量后仍算整句、仍算没 title')
      .toBe('1/0/a.off,a.on/false')
    const hoistedTitled = classify(
      'const hint = ok ? t("a.on") : t("a.off")\nexport const C = () => <span className="truncate" title={hint}>{hint}</span>',
      'f11.tsx'
    )
    expect(hoistedTitled[0]?.ownTitle, '⑦b 同一个量供两处＝合规').toBe(true)
    const hoistedData = classify(
      'const label = row.name\nexport const C = () => <span className="truncate">{label}</span>',
      'f12.tsx'
    )
    expect([hoistedData[0]?.keys.length, hoistedData[0]?.data].join('/'), '⑦c 爬过去之后仍是数据＝别把数据值算成句子')
      .toBe('0/1')

    // ⑧ 注释撑大判据那条（第 33 条）：注释里写 truncate 不算一颗位
    const commented = classify('// 这一行以前带 truncate 会裁\n<div>ok</div>', 'f7.tsx')
    expect(commented.length, '⑧注释里的 truncate 不当位').toBe(0)
  })

  it('两头钉的另一头：本枚收的那两行所属文件里，"句子挂 truncate"的残留数＝只剩终端那一行', () => {
    const rel = 'src/renderer/src/modules/chat/AgentToolBars.tsx'
    const inBars = badSites.filter((r) => r.file === rel)
    expect(inBars.map((r) => r.keys.join(',')).sort().join(' ｜ '), '联网搜索与日历那两行必须已经收干').toBe('')
    const good = goodSites.filter((r) => r.file === rel)
    expect(good.map((r) => r.keys.join(',')).sort().join(' ｜ '), '终端那行仍带 truncate、但它的 title 在场（减罪一档，本枚不动）').toBe(
      'agent.shell.hintOff,agent.shell.hintOn'
    )
  })

  it('如实报出混合位与纯数据位的数量（本面不收，别让它听起来像"已判定没问题"）', () => {
    // V4 交互改造：「+ → 模型」的备用模型行 meta 是「Provider · model」数据＋「未设／读不到」两种字典句，
    // 同挂一个 truncate 位 ⇒ 混合位 10→11（该行已带 title，裁的是数据那半）。
    // V4 交互改造：工作目录快捷入口移入「允许调用工具」行后，路径 basename（数据）＋「选择目录」（字典句）
    // 同挂一颗 truncate ⇒ 混合位 11→12（该位外层按钮带完整路径 title）。
    expect(mixedSites.length, `混合位现数 ${mixedSites.length}＝句子与数据同挂一位，裁的是哪一半要逐处再看`).toBe(12)
    // §429：能力中心卡片新入 4 颗纯数据位（技能名／服务器名／启动命令／模板名）；
    // 本批已逐颗补了 title（裁的是数据本来就该有 tooltip），桶数不变、只把登记改到实测。
    // V4 交互改造：输入区「+」的片段/最近文件列表再入 1 颗纯数据位（列表项标题）⇒ 80→81。
    // 技能分类/标签提交：SkillModule 技能列表行从「纯句子」移入此桶（容器里多了 category/tags
    //   直接数据表达式，状态句被包进内层 <span> 后不再被收键）⇒ 81→82。
    // 技能扫描报告（并行会话的 SkillScanReport.tsx:72）再入 1 颗纯数据位（技能名，已带 title）⇒ 82→83。
    // 数据健康五块收进主面板（5414f42）：DataHealthPanel 删除 BarRow 组件，其标签 span
    //   （`truncate` + `title={label}`，纯数据位）随组件移除 ⇒ 83→82（净回 82）。
    expect(dataSites.length, `纯数据位现数 ${dataSites.length}＝裁的是文件名／标题这类值`).toBe(82)
    // 混合位里最像"句子被连坐"的一档：字典句 ≥10 字（这些将来要单独判，本枚只列不判）
    const longish = mixedSites.filter((r) => r.maxZh >= 10).map((r) => `${r.file}:${r.line}(${r.maxZh}字)`)
    expect(longish.join(' '), `混合位里字典句 ≥10 字的现数：${longish.join(' ')}`).toBe(
      // §436：身份＝WebDAV 备份文件列表的 f.name 单元格（数据＋16 字字典句，已带 title）。
      // 行号随改动漂移：WebDAV 那批 1571→1585，P4 批次 2 后实测 1600；设置页签改造后实测 1671
      //   （本批只动呈现层：页签容器在 return 前增行，该单元格身份未变，只重钉行号）。
      'src/renderer/src/modules/settings/SettingsModule.tsx:1671(16字)'
    )
  })
})
