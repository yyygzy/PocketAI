// V4-Iter-332（源码级闸门）：这一批里有六条"行为用例演不出每一支"的形状，用 AST 钉住
//
// 为什么这些条不走挂载用例：
//  · 切库族那五处挂载点各带 `key={kb.id}`：挂载用例能演"切库后旧 state 还在"（`tests/renderer-kb-switch-332.test.tsx`
//    挂了两张脸），但 RetrievalTest 切库在 jsdom 里量不出稳定形状 ⇒ 这类形状改由这里守。
//  · 防重入两处（KbForm `saving`／RetrievalTest `loading`）：真机连点两下靠的是 IPC 在飞的时间窗，
//    而"早退必须排在 await **之前**"用位置判据最省。
//  · 七条笔记通道的返回类型：类型撒谎只有 tsc 看得见 ⇒ 闸门直接读类型标注文本。
//  · `openPath` 的返回值被消费、`defaultName` 走那一个派生入口、提醒中心逐行在飞态：
//    都是"数一数有几处、每处形状对不对"，计数型判据一律读 AST（第 33 条：注释会把同一串撑大
//    ⇒ 正则计数会假绿／假红）。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string): { text: string; sf: ts.SourceFile } => {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return { text, sf: parse(rel, text) }
}
const parse = (rel: string, text: string): ts.SourceFile =>
  ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** `const NAME = (...) => (...)` 的函数体（取不到就是改名或挪走 ⇒ 调用方自己判） */
function bodyOf(sf: ts.SourceFile, name: string): ts.Node | undefined {
  let out: ts.Node | undefined
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== name) return
    const init = n.initializer
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) out = init.body
  })
  return out
}

/** 该子树里的 JSX 属性文本：`属性名=表达式文本` */
function jsxAttrs(sf: ts.SourceFile, scope: ts.Node): string[] {
  const out: string[] = []
  walk(scope, (n) => {
    if (!ts.isJsxAttribute(n)) return
    const init = n.initializer
    if (init && ts.isJsxExpression(init) && init.expression) {
      out.push(`${n.name.getText(sf)}=${init.expression.getText(sf)}`)
    }
  })
  return out
}

// ---------- G1：切库族挂载点各带 key={kb.id} ----------
const KB_FILE = 'src/renderer/src/modules/knowledge/KnowledgeModule.tsx'
/** 会带"某一库"的入参、且状态存在组件自己那份里的挂载点。
 *  `KbDetail` 刻意不在名单里：它走的是另一条路（§311 的 `kbIdRef` 归属判据，切库不重挂载）。 */
const KEYED = ['KbForm', 'RetrievalTest', 'KbEvalPanel', 'KbAskPanel', 'AddSourceDialog']

interface Mount {
  tag: string
  /** key 表达式文本；没写 key 就是 null */
  key: string | null
  /** 这一处有没有吃 `kb`／`kbId`（吃了就意味着它挂在"某一库"上） */
  takesKb: boolean
}

function mounts(sf: ts.SourceFile, tags: string[]): Mount[] {
  const out: Mount[] = []
  walk(sf, (n) => {
    if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return
    const tag = n.tagName.getText(sf)
    if (!tags.includes(tag)) return
    const props = n.attributes.properties
    const keyAttr = props.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'key') as ts.JsxAttribute | undefined
    const expr = keyAttr?.initializer && ts.isJsxExpression(keyAttr.initializer)
      ? keyAttr.initializer.expression : undefined
    const takesKb = props.some((p) => ts.isJsxAttribute(p)
      && ['kb', 'kbId'].includes(p.name.getText(sf)))
    out.push({ tag, key: expr ? expr.getText(sf) : null, takesKb })
  })
  return out
}

describe('§332 G1 切库族：带"某一库"的挂载点各带 key={kb.id}', () => {
  const { sf } = read(KB_FILE)
  const list = mounts(sf, KEYED)

  it('五个标签都在场（防改名让闸门空转）', () => {
    for (const tag of KEYED) expect(list.map((m) => m.tag), `${tag} 必须还在被挂载`).toContain(tag)
  })

  it('凡吃 kb／kbId 的那一处都必须 key={kb.id}（一份屏上一本库）', () => {
    const bad = list.filter((m) => m.takesKb && m.key !== 'kb.id')
    expect(bad.map((m) => `${m.tag}(key=${m.key})`), `没带 key 的挂载点：${bad.map((m) => m.tag).join(', ')}`).toEqual([])
  })

  it('唯一的例外是新建库那份 KbForm：它不吃 kb（例外要成立，不能顺手盖住别处）', () => {
    const exempt = list.filter((m) => !m.takesKb)
    expect(exempt.map((m) => m.tag), `不吃库的挂载点：${exempt.map((m) => m.tag).join(', ')}`).toEqual(['KbForm'])
    expect(exempt[0]?.key, '新建库那份没有库可键，key 应当为空').toBeNull()
  })

  it('漏杀对照：逐处摘掉 key ⇒ 那一处判成缺 key，其余四处不受影响', () => {
    const { text } = read(KB_FILE)
    for (const tag of KEYED) {
      // 各处的 key 都是**第一个**属性（`=>` 里含 `>`，正则不越过它匹配）
      const re = new RegExp(`(<${tag}\\b\\s*)key=\\{kb\\.id\\}(\\s*)`)
      expect(re.test(text), `锚点 <${tag} key={{kb.id}} 取不到（源码形状变了，对照要跟着改）`).toBe(true)
      const cut = text.replace(re, '$1$2')
      const after = mounts(parse(KB_FILE, cut), KEYED)
      const victim = after.filter((m) => m.tag === tag && m.takesKb)
      expect(victim.some((m) => m.key !== 'kb.id'), `摘掉 ${tag} 的 key 必须判成缺 key`).toBe(true)
      const stillBad = after.filter((m) => m.takesKb && m.key !== 'kb.id')
      expect(stillBad.map((m) => m.tag), `摘一处不许把别处也判没（${tag} 之外）`).toEqual([tag])
    }
  })
})

// ---------- G2／G3：两屏的防重入早退必须排在 await 之前 ----------
const GUARDED: Array<{ file: string; comp: string; fn: string; cond: string; reset: string; label: string }> = [
  { file: KB_FILE, comp: 'KbForm', fn: 'handleSave', cond: 'saving', reset: 'setSaving', label: 'KbForm 保存那颗键' },
  { file: KB_FILE, comp: 'RetrievalTest', fn: 'handleSearch', cond: '!query.trim() || loading', reset: 'setLoading', label: 'RetrievalTest 搜索那颗键' }
]

interface GuardShape {
  found: boolean
  earlyReturn: boolean
  resetInFinally: boolean
}

function guardShape(sf: ts.SourceFile, comp: string, fnName: string, condText: string, resetName: string): GuardShape {
  const none: GuardShape = { found: false, earlyReturn: false, resetInFinally: false }
  const compBody = bodyOf(sf, comp)
  if (!compBody) return none
  let fn: ts.Node | undefined
  walk(compBody, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === fnName) {
      const init = n.initializer
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fn = init.body
    }
  })
  if (!fn) return none

  let earlyReturn = false
  let resetInFinally = false
  let firstAwait: number | undefined
  walk(fn, (n) => {
    if (ts.isAwaitExpression(n) && firstAwait === undefined) firstAwait = n.getStart(sf)
    if (ts.isIfStatement(n) && n.expression.getText(sf) === condText) {
      const returns = ts.isReturnStatement(n.thenStatement)
        || (ts.isBlock(n.thenStatement) && n.thenStatement.statements.some((s) => ts.isReturnStatement(s)))
      // 早退必须排在 await 之前：排在写之后＝谎已经画出去了
      if (returns && (firstAwait === undefined || n.getStart(sf) < firstAwait)) earlyReturn = true
    }
    if (ts.isTryStatement(n) && n.finallyBlock) {
      walk(n.finallyBlock, (inner) => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === resetName) {
          resetInFinally = true
        }
      })
    }
  })
  return { found: true, earlyReturn, resetInFinally }
}

describe('§332 G2／G3 防重入：早退守卫排在首个 await 之前，复位走 finally', () => {
  for (const g of GUARDED) {
    it(`${g.label}：if (${g.cond}) return 在首个 await 之前，且 ${g.reset} 在 finally 里`, () => {
      const { sf } = read(g.file)
      const shape = guardShape(sf, g.comp, g.fn, g.cond, g.reset)
      expect(shape.found, `${g.comp} 里的 ${g.fn} 取不到（改名或挪走了）`).toBe(true)
      expect(shape.earlyReturn, '没有"在飞就早退"的守卫').toBe(true)
      expect(shape.resetInFinally, `${g.reset} 没在 finally 里 ⇒ 一发失败就永久锁死那颗键`).toBe(true)
    })
  }

  it('两颗键各自还挂 disabled（早退管程序化派发与 Enter，disabled 管浏览器真点——两层都在）', () => {
    const { sf } = read(KB_FILE)
    const form = bodyOf(sf, 'KbForm')
    const test = bodyOf(sf, 'RetrievalTest')
    expect(form && test, '两个组件取不到').toBeTruthy()
    if (form) {
      const attrs = jsxAttrs(sf, form)
      expect(attrs.filter((a) => a === 'disabled=saving').length, 'KbForm 那颗保存键').toBe(1)
    }
    if (test) {
      const attrs = jsxAttrs(sf, test)
      expect(attrs.filter((a) => a === 'disabled=loading').length, 'RetrievalTest 输入框＋那颗按钮').toBe(2)
    }
  })

  it('那颗保存键的文案跟着在飞态走（点了以后按钮自己说话，不只是变灰）', () => {
    const { sf } = read(KB_FILE)
    const form = bodyOf(sf, 'KbForm')
    expect(form, 'KbForm 取不到').toBeTruthy()
    const ternaries: string[] = []
    if (form) {
      walk(form, (n) => {
        if (ts.isConditionalExpression(n) && n.condition.getText(sf) === 'saving') ternaries.push(n.getText(sf))
      })
    }
    expect(ternaries, '没有一处按 saving 取的三元').toEqual(["saving ? t('common.saving') : t('common.save')"])
  })

  it('漏杀对照：早退换成 false && 中和（§266 Z7 那一族：只数 token 的判据对这种写法是瞎的）', () => {
    for (const g of GUARDED) {
      const { text } = read(g.file)
      const cut = text.replace(`if (${g.cond}) return`, `if (false && ${g.cond}) return`)
      expect(cut, `锚点 if (${g.cond}) return 取不到`).not.toBe(text)
      expect(guardShape(parse(g.file, cut), g.comp, g.fn, g.cond, g.reset).earlyReturn,
        `${g.label} 被 false && 中和必须判成没守卫`).toBe(false)
    }
  })

  it('漏杀对照：finally 不再复位（一发失败就永久锁死那颗键）必须判成没兜底', () => {
    const g = GUARDED[1]!
    const { text } = read(g.file)
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    const cut = text
      .split(nl)
      .map((l) => (l.trim() === 'setLoading(false)' ? 'void 0' : l))
      .join(nl)
    expect(cut, '那两处 setLoading(false) 取不到（源码形状变了）').not.toBe(text)
    expect(guardShape(parse(g.file, cut), g.comp, g.fn, g.cond, g.reset).resetInFinally,
      'finally 不再复位必须判成没兜底').toBe(false)
  })
})

// ---------- G3b：检索测试那颗输入框的 Enter 与输入法 ----------
describe('§332 G3b 检索测试输入框：Enter 这条路自己判在飞，且认输入法合成中', () => {
  const { sf } = read(KB_FILE)
  const body = bodyOf(sf, 'RetrievalTest')
  const attrs = body ? jsxAttrs(sf, body) : []
  const enter = attrs.filter((a) => a.startsWith('onKeyDown='))

  it('那颗输入框的 onKeyDown 判 isComposing（同屏 KbAskPanel 早已判，这一行改前没有）', () => {
    expect(body, 'RetrievalTest 取不到').toBeTruthy()
    expect(enter.length, '至少有一颗 Enter 路由的 onKeyDown').toBeGreaterThanOrEqual(1)
    expect(enter.some((a) => a.includes('isComposing')), `Enter 必须判输入法：${enter.join(' / ')}`).toBe(true)
  })

  it('反向钉：那颗输入框的 Enter 走的是同一个带守卫的入口（内联另发一发就会绕过它）', () => {
    expect(enter.some((a) => a.includes('handleSearch()')),
      `Enter 必须走 handleSearch 那个入口：${enter.join(' / ')}`).toBe(true)
  })
})

// ---------- G4：会话导出的默认文件名只有一个派生入口 ----------
const CHAT_FILE = 'src/renderer/src/modules/chat/ChatModule.tsx'

function exportNameShape(sf: ts.SourceFile): { viaHelper: number; raw: string[] } {
  let viaHelper = 0
  const raw: string[] = []
  walk(sf, (n) => {
    if (!ts.isPropertyAssignment(n) || n.name.getText(sf) !== 'defaultName') return
    const init = n.initializer
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'messagesExportName') {
      viaHelper += 1
      return
    }
    raw.push(init.getText(sf))
  })
  return { viaHelper, raw }
}

describe('§332 G4 会话导出默认名：两处都走 messagesExportName（长标题不再撞爆那道 200 字闸）', () => {
  it('恰好两处 defaultName，且都经由那一个派生入口', () => {
    const { sf } = read(CHAT_FILE)
    const shape = exportNameShape(sf)
    expect(shape.viaHelper, `走派生入口的处数（裸写法：${shape.raw.join(' / ')}）`).toBe(2)
    expect(shape.raw, '不许留裸拼接的 defaultName').toEqual([])
  })

  it('漏杀对照：换成裸模板 ⇒ 必须判成没走派生入口', () => {
    const { text } = read(CHAT_FILE)
    const cut = text.replace('defaultName: messagesExportName(title, picked.length)',
      'defaultName: `${title}-${picked.length}`')
    expect(cut, '锚点取不到（源码形状变了）').not.toBe(text)
    const shape = exportNameShape(parse(CHAT_FILE, cut))
    expect(shape.viaHelper, '摘掉一处必须掉到 1').toBe(1)
    expect(shape.raw.length, '裸写法必须被抓出来').toBe(1)
  })

  it('派生入口自己带 safeFileName（那道长度闸的出处在这里）', () => {
    const { text } = read(CHAT_FILE)
    expect(text).toMatch(/const messagesExportName = \(title: string, count: number\): string => safeFileName\(/)
  })
})

// ---------- G5：七条笔记通道的返回类型带失败分支 ----------
const PRELOAD_FILE = 'src/preload/index.ts'
const NOTE_CHANNELS = ['listNotes', 'getNote', 'createNote', 'updateNote', 'deleteNote', 'searchNotes', 'createNoteFromMessage']

interface ChannelType {
  text: string
  start: number
  end: number
}

function noteChannelTypes(sf: ts.SourceFile): Map<string, ChannelType> {
  const out = new Map<string, ChannelType>()
  walk(sf, (n) => {
    if (!ts.isPropertyAssignment(n) || !ts.isIdentifier(n.name)) return
    const name = n.name.text
    if (!NOTE_CHANNELS.includes(name)) return
    const init = n.initializer
    if (ts.isArrowFunction(init) && init.type) {
      out.set(name, { text: init.type.getText(sf), start: init.type.getStart(sf), end: init.type.getEnd() })
    } else {
      out.set(name, { text: '', start: -1, end: -1 })
    }
  })
  return out
}

describe('§332 G5 preload 笔记七条：返回类型必须带 ok:false 分支', () => {
  const { sf, text } = read(PRELOAD_FILE)
  const types = noteChannelTypes(sf)

  it('七条都在场（防改名或删条目让闸门空转）', () => {
    expect([...types.keys()].sort()).toEqual([...NOTE_CHANNELS].sort())
  })

  it('每一条的返回类型里都有 ok: false（缺哪条就点名哪条）', () => {
    const missing = NOTE_CHANNELS.filter((c) => !types.get(c)?.text.includes('ok: false'))
    expect(missing, `这些通道还在只写成功形状：${missing.join(', ')}`).toEqual([])
  })

  it('漏杀对照：逐条还原成只写成功形状 ⇒ 那一条被点名，其余六条不受影响', () => {
    // 按**字符位置**动刀：七条里有几条的标注文本一模一样，按字符串 replace 会削到别那条头上
    for (const ch of NOTE_CHANNELS) {
      const site = types.get(ch)!
      const successOnly = site.text.replace(
        /\s*\|\s*\{ ok: false; error: string; ipcCode\?: string; ipcArgs\?: string \}/, '')
      expect(successOnly, `${ch} 的失败分支摘不掉（形状变了，对照要跟着改）`).not.toBe(site.text)
      const cut = text.slice(0, site.start) + successOnly + text.slice(site.end)
      const after = noteChannelTypes(parse(PRELOAD_FILE, cut))
      expect(after.get(ch)?.text, `${ch} 还原后必须判成撒谎`).not.toContain('ok: false')
      for (const other of NOTE_CHANNELS.filter((x) => x !== ch)) {
        expect(after.get(other)?.text, `逐条还原不许连带判没别条（${other}）`).toContain('ok: false')
      }
    }
  })
})

// ---------- G6：files-service 消费 shell.openPath 的返回值 ----------
const FILES_SVC = 'src/main/files/files-service.ts'

function openPathShape(sf: ts.SourceFile): { awaited: boolean; judged: boolean; sites: number } {
  let awaited = false
  let judged = false
  let sites = 0
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'shell.openPath') sites += 1
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'failure'
      && n.initializer && ts.isAwaitExpression(n.initializer)
      && n.initializer.expression.getText(sf) === 'shell.openPath(abs)') awaited = true
    if (ts.isIfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === 'failure') judged = true
    if (ts.isConditionalExpression(n) && ts.isIdentifier(n.condition) && n.condition.text === 'failure') judged = true
  })
  return { awaited, judged, sites }
}

describe('§332 G6 openPath 那句错误串不许丢掉（改前"什么都没打开"回的是 ok:true）', () => {
  it('const failure = await shell.openPath(abs)，且 failure 被当条件判', () => {
    const shape = openPathShape(read(FILES_SVC).sf)
    expect(shape.awaited, '那句 await 取不到').toBe(true)
    expect(shape.judged, '取到了却没判＝照旧丢').toBe(true)
  })

  it('漏杀对照：判据换成写死的字面量（等价于改前的"永远成功"）⇒ 必须判成没消费', () => {
    const { text } = read(FILES_SVC)
    const cut = text.replace('return failure ? { ok: false, error: failure } : { ok: true }',
      'return true ? { ok: false, error: failure } : { ok: true }')
    expect(cut, '锚点取不到（源码形状变了）').not.toBe(text)
    expect(openPathShape(parse(FILES_SVC, cut)).judged,
      'judged 数的是标识符条件，写死字面量必须判成没消费').toBe(false)
  })

  it('反向钉：这一族只有一个 openPath 出处（别处再裸调一次就是漏网）', () => {
    expect(openPathShape(read(FILES_SVC).sf).sites, 'openPath 调用处数').toBe(1)
  })
})

// ---------- G7：提醒中心那一屏的在飞态按"行"存 ----------
const REMINDERS_FILE = 'src/renderer/src/components/RemindersModal.tsx'

function busyShape(sf: ts.SourceFile): { rowDisabled: number; singleSlot: string[]; markCalls: number } {
  let rowDisabled = 0
  let markCalls = 0
  const singleSlot: string[] = []
  walk(sf, (n) => {
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === 'disabled' && n.initializer
      && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
      const t = n.initializer.expression.getText(sf)
      if (t === '!!busyIds[r.id]') rowDisabled += 1
      if (/\bbusyId\b/.test(t)) singleSlot.push(t)
    }
    if (ts.isIdentifier(n) && n.text === 'busyId') {
      singleSlot.push(`标识符 @${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'markBusy') markCalls += 1
  })
  return { rowDisabled, singleSlot, markCalls }
}

describe('§332 G7 提醒中心：在飞态一行一格（改前单槽位 ⇒ 迟到回执解锁别那一行）', () => {
  it('四颗行内键各挂 !!busyIds[r.id]，markBusy 四处调用（两开两关），且标识符 busyId 归零', () => {
    const shape = busyShape(read(REMINDERS_FILE).sf)
    expect(shape.rowDisabled, '挂着在飞守卫的行内键处数').toBe(4)
    expect(shape.markCalls, 'markBusy 调用处数（两颗键 × 开／关）').toBe(4)
    expect(shape.singleSlot, `单槽位残留：${shape.singleSlot.join(' / ')}`).toEqual([])
  })

  it('漏杀对照：摘掉其中一颗键的守卫 ⇒ 计数必须掉（反向对照才不是空转）', () => {
    const { text } = read(REMINDERS_FILE)
    const cut = text.replace('disabled={!!busyIds[r.id]}', 'disabled={false}')
    expect(cut, '锚点取不到').not.toBe(text)
    expect(busyShape(parse(REMINDERS_FILE, cut)).rowDisabled, '摘一颗必须掉到 3').toBe(3)
  })

  it('漏杀对照：退回单槽位写法 busyId === r.id ⇒ 计数掉一格、且单槽位残留非零', () => {
    const { text } = read(REMINDERS_FILE)
    const cut = text.replace('disabled={!!busyIds[r.id]}', 'disabled={busyId === r.id}')
    expect(cut, '锚点取不到').not.toBe(text)
    const shape = busyShape(parse(REMINDERS_FILE, cut))
    expect(shape.rowDisabled, '摘一颗必须掉到 3').toBe(3)
    expect(shape.singleSlot.length, '单槽位残留必须非零').toBeGreaterThan(0)
  })
})
