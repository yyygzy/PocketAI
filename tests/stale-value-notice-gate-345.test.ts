// V4-Iter-345 闸门：「面板先读到过值、那一发又重读失败」的旧值横幅——七处接线与两条到货的路
//
// 缺陷形状（§222 那一族的第三形态）：门写在 `if (!数据)` 那条路上，数据在，门就不开。
// 重读失败时旧值留着是对的一半，但屏上从此说不出"这一发没成"，用户拿一份没人认领的旧数据当现状。
// 本批把七处按「旧值横幅＋重试」接完，这一面闸门钉的是**接线**；到货顺序与真屏上的话由
// tests/stale-read-notice-345.test.tsx 的行为用例钉（那边逐处都有"有数据＋没失败 ⇒ 一个 alert 都不许有"，
// 以及⑤⑥⑦三条"成功一发到了，那句当场收回"）。
//
// 四层判据，全部读 AST（源码计数会被注释撑大，§333 那条踩过）：
// ① 名单制：全渲染层的 <StaleValueNotice> 调用点必须正好是这七条，四条属性逐字对得上
//    （`msg` 绑的是那一格的 err state、`onRetry` 绑的是那一格自己的重取入口——写成常量或接错块就红）；
// ② 同块配对：每一处所在组件里必须还留着 §222 那句 LoadFailNotice，且它头顶的条件里判过"数据缺席"
//    （少了它＝一发都没读到也被说成"这是旧值"；少了横幅＝本批白改）；
// ③ 三条落点：每处的重取函数里必须有一次 `setXErr(null)`（成功侧收回）、一次写回数据、
//    以及**两条**把原因写进 err 的落点（resolve 面 ipcFailText／reject 面 errText，§251 的口径）；
// ④ 组件本体：`role="alert"` 容器里不许有按钮（§268 的教训：那样 textContent 会把「重试」算进句子），
//    按钮必须是同级的、onClick 直接接 onRetry；句子取 §230 那句的成对键 `common.refreshFailedNamed`，四语都要有槽。
//
// 现查名单（`node data/tmp/sites-345.cjs` 打出来的四属性原文，闸门照它写）：
//   components/OllamaPanel.tsx:225            ollama-status-stale-retry
//   modules/settings/DataHealthPanel.tsx:170  data-health-stale-retry
//   modules/settings/SettingsModule.tsx:374   enc-stale-retry
//   modules/settings/SettingsModule.tsx:1330  schedule-stale-retry
//   modules/settings/SettingsModule.tsx:1761  lic-stale-retry
//   modules/settings/UsagePanel.tsx:298       usage-summary-stale-retry
//   modules/steward/StewardModule.tsx:480     steward-rec-stale-retry
//
// 同一族里**逐条回读过、本批没接**的落点（写在这里是给下一批的账，不是豁免名单）：
//   · 提醒中心列表 RemindersModal.tsx:209 —— 门 `items === null ? (loadErr ? … : 加载中)`，
//     而 reload 的 caller 除挂载 :119 外还有 :125/:127（到点广播与本地变更）与 :147/:167/:312（增删改后）
//     ⇒ 有值时失败演得出，**有牙、待收**；
//   · 绘图页 ImageModule.tsx:441/459/521（最新结果／画廊／预览）—— setGallery 写点 :130/:251/:286
//     ⇒ 生成后重读演得出，**有牙、待收**；
//   · 用量页定价表 UsagePanel.tsx:805（modelsErr）—— `listUsageModels` 挂在 `deps=[onError]` 的 effect 上，
//     而调用点 :548 传的是行内箭头（每次渲染都是新的 onError）⇒ 这一发其实每渲染重跑一次，
//     **有牙、待收**（同族还带出"逐渲染重读"那一条，另账）；
//   · 判过＝无牙（那一发只有挂载这一个读者，err 只可能在数据缺席时被写）：
//     SettingsModule 的应用路径 :306、WebDAV 配置 :1249、划词浮窗配置 :1951、更新信息 :2603；
//     SkillModule 模板清单 :501；首启向导的推荐 :466 与硬件 :498（两发都在同一个挂载 effect 里）；
//   · 已经覆盖、不是候选：知识库文档列表 KnowledgeModule.tsx:1084/1085（§230 就把两面都写了）；
//     服务商能力判定 ProviderSettings.tsx:439 那类"门里不带数据缺席判据"的写法，失败时原因本来就一直在屏上。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../src/renderer/src')
const cache = new Map<string, ts.SourceFile>()
const src = (rel: string): ts.SourceFile => {
  if (!cache.has(rel)) {
    cache.set(
      rel,
      ts.createSourceFile(rel, fs.readFileSync(path.join(ROOT, rel), 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    )
  }
  return cache.get(rel)!
}

const walk = (node: ts.Node, cb: (n: ts.Node) => void): void => {
  cb(node)
  ts.forEachChild(node, (c) => walk(c, cb))
}

/** 去掉空白后的源码文本：属性值与调用点都按它比，换行与缩进不算改判据 */
const norm = (s: string): string => s.replace(/\s+/g, '')

const isOpening = (n: ts.Node): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
  ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)

/** 某个 JSX 开标签上某属性的 initializer 原文（没有该属性＝null） */
const jsxAttr = (open: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string | null => {
  for (const p of open.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name) return p.initializer ? p.initializer.getText() : null
  }
  return null
}

interface Row {
  /** 这一格在屏上的名字（报错文案按它说，便于红了就知道是哪一块） */
  格: string
  file: string
  testid: string
  what: string
  msg: string
  retry: string
  /** 该块"数据"的 state 名：用来验 §222 那条门还成对 */
  data: string
  /** 重取函数里那三条落点的被调名 */
  errSetter: string
  dataSetter: string
  loader: { file: string; fn?: string; jsx?: [string, string] }
}

const ENC = 'modules/settings/SettingsModule.tsx'
const DH = 'modules/settings/DataHealthPanel.tsx'
const UP = 'modules/settings/UsagePanel.tsx'
const OL = 'components/OllamaPanel.tsx'
const SW = 'modules/steward/StewardModule.tsx'
const LF = 'utils/lock-flags.ts'
const NOTICE = 'components/StaleValueNotice.tsx'

const REGISTRY: Row[] = [
  {
    格: '加密面板的「数据库加密」那一格',
    file: ENC,
    testid: 'enc-stale-retry',
    what: `{t('enc.dbEnc')}`,
    msg: '{err}',
    retry: '{onChange}',
    data: 'enc',
    errSetter: 'deps.setErr',
    dataSetter: 'deps.setStatus',
    loader: { file: LF, fn: 'createEncryptionStatusSyncer' }
  },
  {
    格: '许可证状态那一格',
    file: ENC,
    testid: 'lic-stale-retry',
    what: `{t('lic.status')}`,
    msg: '{err}',
    retry: '{onChange}',
    data: 'lic',
    errSetter: 'setLicErr',
    dataSetter: 'setLic',
    loader: { file: ENC, jsx: ['LicensePanel', 'onChange'] }
  },
  {
    格: '定时备份计划那一块',
    file: ENC,
    testid: 'schedule-stale-retry',
    what: `{t('dh.backupState')}`,
    msg: '{schedErr}',
    retry: '{() => void loadSchedule()}',
    data: 'schedule',
    errSetter: 'setSchedErr',
    dataSetter: 'setSchedule',
    loader: { file: ENC, fn: 'loadSchedule' }
  },
  {
    格: '数据健康报告',
    file: DH,
    testid: 'data-health-stale-retry',
    what: `{t('set.dataHealth')}`,
    msg: '{loadErr}',
    retry: '{() => load(true)}',
    data: 'report',
    errSetter: 'setLoadErr',
    dataSetter: 'setReport',
    loader: { file: DH, fn: 'load' }
  },
  {
    格: '用量汇总',
    file: UP,
    testid: 'usage-summary-stale-retry',
    what: `{t('set.usage')}`,
    msg: '{loadErr}',
    retry: '{reload}',
    data: 'summary',
    errSetter: 'setLoadErr',
    dataSetter: 'setSummary',
    loader: { file: UP, fn: 'load' }
  },
  {
    格: 'Ollama 运行时状态',
    file: OL,
    testid: 'ollama-status-stale-retry',
    what: `{t('ollama.title')}`,
    msg: '{statusErr}',
    retry: '{refresh}',
    data: 'status',
    errSetter: 'setStatusErr',
    dataSetter: 'setStatus',
    loader: { file: OL, fn: 'refresh' }
  },
  {
    格: '管家页模型推荐',
    file: SW,
    testid: 'steward-rec-stale-retry',
    what: `{t('steward.modelRec')}`,
    msg: '{recErr}',
    retry: '{refreshRecommendation}',
    data: 'recommendation',
    errSetter: 'setRecErr',
    dataSetter: 'setRecommendation',
    loader: { file: SW, fn: 'refreshRecommendation' }
  }
]

/** 全渲染层的 <StaleValueNotice> 调用点（只数名单里这些文件，别把组件本体算成落点；一个文件只走一遍） */
const noticeSites = (): Array<{ file: string; open: ts.JsxOpeningElement | ts.JsxSelfClosingElement }> => {
  const out: Array<{ file: string; open: ts.JsxOpeningElement | ts.JsxSelfClosingElement }> = []
  for (const rel of [...new Set(REGISTRY.map((r) => r.file))]) {
    walk(src(rel), (n) => {
      if (isOpening(n) && n.tagName.getText() === 'StaleValueNotice') out.push({ file: rel, open: n })
    })
  }
  return out
}

const siteOf = (testid: string): { file: string; open: ts.JsxOpeningElement | ts.JsxSelfClosingElement } => {
  const hits = noticeSites().filter((s) => jsxAttr(s.open, 'testid') === `"${testid}"`)
  expect(hits.length, `这一颗重试键的落点数不对（${testid}）`).toBe(1)
  return hits[0]!
}

/** 往上找最近的函数边界；属性上挂的行内箭头不算"组件本体"（太窄，会漏掉同块的 LoadFailNotice） */
const enclosingFunction = (node: ts.Node): ts.Node | null => {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      if (cur.parent && ts.isJsxAttribute(cur.parent)) continue
      return cur
    }
    if (ts.isFunctionDeclaration(cur)) return cur
    if (ts.isVariableDeclaration(cur) && cur.initializer) {
      const init = cur.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init)) return init
    }
  }
  return null
}

const identifiersIn = (fn: ts.Node): Set<string> => {
  const names = new Set<string>()
  walk(fn, (n) => {
    if (ts.isIdentifier(n)) names.add(n.text)
  })
  return names
}

/** 该函数里每一处 LoadFailNotice 头顶上的条件文本（IfStatement／三元／`cond && <Jsx/>` 三种写法都收，沿父链走到函数边界为止） */
const loadFailGuards = (fn: ts.Node): string[] => {
  const out: string[] = []
  walk(fn, (n) => {
    if (!isOpening(n) || n.tagName.getText() !== 'LoadFailNotice') return
    // 短路写法有两种落法：JSX 直接当右操作数，或整块被圆括号包起来再当右操作数
    // （`{!recommendation && recErr && (<Section>…<LoadFailNotice/>…</Section>)}`）——
    // 所以判"这处提示是不是被这道门挂上来的"，按区间包含算，不按相邻位置猜。
    for (let cur: ts.Node | undefined = n.parent; cur && cur !== fn; cur = cur.parent) {
      if (ts.isIfStatement(cur)) out.push(cur.expression.getText())
      if (ts.isConditionalExpression(cur)) out.push(cur.condition.getText())
      if (
        ts.isBinaryExpression(cur) &&
        cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        n.getFullStart() >= cur.right.getFullStart() &&
        n.getEnd() <= cur.right.getEnd()
      ) {
        out.push(cur.left.getText())
      }
    }
  })
  return out
}

/** 按名字取那个重取函数（顶层或组件内都行）；同名多处就直接红——判据不能挂在"碰巧取到哪一个"上 */
const fnByName = (rel: string, name: string): ts.Node => {
  const hits: ts.Node[] = []
  walk(src(rel), (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) hits.push(n)
    if (ts.isVariableDeclaration(n) && n.name.getText() === name && n.initializer) hits.push(n.initializer)
  })
  expect(hits.length, `${rel} 里名为 ${name} 的函数不止一个/一个都没有，判据要按名字重写`).toBe(1)
  return hits[0]!
}

/** 挂在 JSX 属性上的行内重取函数（lic 那一发就是这种写法） */
const jsxAttrNode = (rel: string, component: string, attr: string): ts.Node => {
  const hits: ts.Node[] = []
  walk(src(rel), (n) => {
    if (!isOpening(n) || n.tagName.getText() !== component) return
    for (const p of n.attributes.properties) {
      if (ts.isJsxAttribute(p) && p.name.getText() === attr && p.initializer) hits.push(p.initializer)
    }
  })
  expect(hits.length, `<${component}> 上的 ${attr} 不是一个或不止一个`).toBe(1)
  return hits[0]!
}

const callsTo = (fn: ts.Node, callee: string): ts.CallExpression[] => {
  const want = norm(callee)
  const out: ts.CallExpression[] = []
  walk(fn, (n) => {
    if (ts.isCallExpression(n) && norm(n.expression.getText()) === want) out.push(n)
  })
  return out
}

/** `setXErr(null)` 的次数（成功侧收回原因） */
const nullClears = (fn: ts.Node, callee: string): number =>
  callsTo(fn, callee).filter((c) => c.arguments.length === 1 && c.arguments[0]?.kind === ts.SyntaxKind.NullKeyword).length

/** 该函数里由 `const X = ipcFailText(...)`／`const X = errText(...)` 绑出来的名字（原因先落变量再写屏，同一族） */
const reasonNames = (fn: ts.Node): Set<string> => {
  const out = new Set<string>()
  walk(fn, (n) => {
    if (!ts.isVariableDeclaration(n) || !n.initializer || !ts.isCallExpression(n.initializer)) return
    const callee = n.initializer.expression.getText()
    if ((callee === 'ipcFailText' || callee === 'errText') && ts.isIdentifier(n.name)) out.add(n.name.text)
  })
  return out
}

/** 把原因写进 err 的落点数：`setXErr(ipcFailText…)`／`setXErr(errText…)`／`setXErr(那条原因变量)`／`failAction(r, setXErr)` */
const failWrites = (fn: ts.Node, callee: string): number => {
  const reasons = reasonNames(fn)
  let n = callsTo(fn, callee).filter((c) => {
    const arg = (c.arguments[0]?.getText() ?? '').trim()
    if (/^(ipcFailText|errText)\(/.test(arg)) return true
    return reasons.has(arg)
  }).length
  for (const c of callsTo(fn, 'failAction')) {
    if (c.arguments[1]?.getText() === callee) n += 1
  }
  return n
}

describe('① 名单制：全渲染层正好七处，四条属性逐字绑到那一格自己的 state 与重取入口', () => {
  it('调用点总数＝7（多一处就是新落点，要人工过目再进名单）', () => {
    expect(noticeSites().length).toBe(REGISTRY.length)
  })

  it('每处的 what／msg／onRetry／testid 逐条对得上（msg 写成常量、onRetry 接错块，都在这里红）', () => {
    for (const r of REGISTRY) {
      const site = siteOf(r.testid)
      expect(site.file, `${r.testid} 不在预期文件里`).toBe(r.file)
      expect(jsxAttr(site.open, 'what'), `${r.格}：what 不是屏上已有的那个名词`).toBe(r.what)
      expect(jsxAttr(site.open, 'msg'), `${r.格}：msg 没绑到那一格的 err`).toBe(r.msg)
      expect(jsxAttr(site.open, 'onRetry'), `${r.格}：onRetry 不是那一格自己的重取入口`).toBe(r.retry)
    }
  })
})

describe('② 同块配对：横幅挂上去时，§222「一发都没读到」那半张脸不许丢', () => {
  it('每一处所在组件里还留着 LoadFailNotice，且它头顶的条件判过"数据缺席"', () => {
    for (const r of REGISTRY) {
      const fn = enclosingFunction(siteOf(r.testid).open)
      expect(fn !== null, `${r.testid}：读不到它在哪一块组件里`).toBe(true)
      const guards = loadFailGuards(fn!)
      expect(guards.length, `${r.格}：那一格的"一发都没读到"没了（旧值横幅不许顶掉它）`).toBeGreaterThan(0)
      expect(
        guards.some((g) => norm(g).includes(norm(r.data))),
        `${r.格}：LoadFailNotice 的条件里没有「${r.data}」＝两句会同时挂（${guards.join(' / ') || '（无）'}）`
      ).toBe(true)
      expect(identifiersIn(fn!).has(r.msg.slice(1, -1)), `${r.格}：那块里没有 err state「${r.msg}」`).toBe(true)
    }
  })
})

describe('③ 三条落点：每处的重取函数要有成功收回、写回数据、两条失败面', () => {
  it('一次 setXErr(null)、一次写回数据、两次把原因写进 err（resolve／reject 各一条）', () => {
    for (const r of REGISTRY) {
      const target = r.loader.jsx ? jsxAttrNode(r.loader.file, r.loader.jsx[0], r.loader.jsx[1]) : fnByName(r.loader.file, r.loader.fn!)
      expect(nullClears(target, r.errSetter), `${r.格}：成功那发没把原因收回＝新值上屏还挂着"这是旧值"`).toBe(1)
      expect(callsTo(target, r.dataSetter).length, `${r.格}：这一发没把读到的值写回`).toBe(1)
      expect(failWrites(target, r.errSetter), `${r.格}：失败面只接了一条，另一条到货的路又能演成"没失败"`).toBe(2)
    }
  })
})

describe('④ 组件本体与那一句', () => {
  it('role="alert" 的容器里没有任何 <button>；重试键是同级的、onClick 直接接 onRetry', () => {
    let alerts = 0
    let buttons = 0
    walk(src(NOTICE), (n) => {
      if (!isOpening(n)) return
      if (jsxAttr(n, 'role') === '"alert"') {
        alerts += 1
        let inner = 0
        walk(n, (c) => {
          if (isOpening(c) && c.tagName.getText() === 'button') inner += 1
        })
        expect(inner, '按钮进了 role="alert" 容器，用例读到的句子就多了「重试」两个字（§268）').toBe(0)
      }
      if (n.tagName.getText() === 'button') {
        buttons += 1
        expect(jsxAttr(n, 'onClick'), '那颗键没直接接 onRetry').toBe('{onRetry}')
        expect(jsxAttr(n, 'data-testid'), '键要带自己的 testid，别靠文字找').toBe('{testid}')
      }
    })
    expect(alerts, '横幅本体只许一句').toBe(1)
    expect(buttons, '横幅本体只许一颗重试键').toBe(1)
  })

  it('句子里只许有那一句＋重试键的既有名词（不另立新话术，也不顺手加第三句）', () => {
    const keys: string[] = []
    walk(src(NOTICE), (n) => {
      if (ts.isCallExpression(n) && n.expression.getText() === 't') {
        const a = n.arguments[0]
        if (a && ts.isStringLiteral(a)) keys.push(a.text)
      }
    })
    expect(keys).toEqual(['common.refreshFailedNamed', 'agent.retryRead'])
  })

  it('四语都有这一句，{what} 与 {msg} 两个槽一个都不许漏', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const dict = fs.readFileSync(path.join(ROOT, `i18n/${lang}.ts`), 'utf-8')
      const line = dict.split(/\r?\n/).find((l) => l.includes("'common.refreshFailedNamed'"))
      expect(line, `${lang} 缺那一句旧值横幅的话`).toBeTruthy()
      expect(line!.includes('{what}'), `${lang} 那句少了 {what}`).toBe(true)
      expect(line!.includes('{msg}'), `${lang} 那句少了 {msg}`).toBe(true)
      expect(line, `${lang} 那句该带点名，不许抄成 §230 的无名版`).not.toContain("'common.refreshFailed':")
    }
  })
})
