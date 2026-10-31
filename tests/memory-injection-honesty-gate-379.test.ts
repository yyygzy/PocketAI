// V4-Iter-379 闸门：记忆注入那一圈"预算语义"与"披露"不许漂回原样。
//
// 三面各守一个形状：
//  A 主进程：总预算那道判断放行的是 `continue`（逐条试放），不是 `break`（一条长记忆把后面塞得下的短记忆整批挤掉）；
//  B 数字同源：三档上限只住在 `src/shared/schemas/memory.ts` 一份，主进程与渲染层都 import 它；
//  C 披露：四语 `set.memoryHint` 各带 {items}／{itemChars}／{totalChars} 三颗占位符，
//    数字由调用点的 params 带出（字典里写死数字＝§361 那族"文案与代码各说一套"）。
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf-8').replace(/\r\n/g, '\n')

const MEMORY = read('main/assistant/memory.ts')
const SHARED = read('shared/schemas/memory.ts')
const PANEL = read('renderer/src/modules/settings/UserMemoryPanel.tsx')

const sf = (name: string, src: string): ts.SourceFile => ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** 取 `export function name(...)` 的函数节点 */
function findFn(file: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let hit: ts.FunctionDeclaration | undefined
  walk(file, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) hit = n
  })
  return hit
}

/** 取"总预算那道判断"＝条件里同时读到 total 与 line.length 的那颗 IfStatement */
function findBudgetIf(src: string): { node: ts.IfStatement; file: ts.SourceFile } | undefined {
  const file = sf('memory-probe.ts', src)
  const fn = findFn(file, 'buildMemoryContext')
  if (!fn) throw new Error('找不到 buildMemoryContext（读法失效，不是代码失效）')
  let hit: ts.IfStatement | undefined
  walk(fn, (n) => {
    if (!ts.isIfStatement(n)) return
    const cond = n.expression.getText(file)
    if (cond.includes('total') && cond.includes('line.length')) hit = n
  })
  return hit ? { node: hit, file } : undefined
}

const BUDGET_BEFORE =
  'export function buildMemoryContext(): string {\n' +
  '  const lines: string[] = []\n' +
  '  let total = 0\n' +
  '  for (const item of items) {\n' +
  '    const line = `- ${item}`\n' +
  '    if (total + line.length > MAX_TOTAL_CHARS) break\n' +
  '    lines.push(line)\n' +
  '    total += line.length\n' +
  '  }\n' +
  '  return lines.join(String.fromCharCode(10))\n' +
  '}'

describe('读法自证（先证明这套读法读得到东西，也认得改前那一形）', () => {
  it('现源码里那道"总预算判断"读得到，且放行那一支是单条语句（不是块）', () => {
    const hit = findBudgetIf(MEMORY)
    expect(hit, '读法在现源码里找不到那颗判断（条件形状变了，判据要跟着改）').toBeTruthy()
    expect(ts.isContinueStatement(hit!.node.thenStatement) || ts.isBreakStatement(hit!.node.thenStatement),
      '放行那一支既不是 continue 也不是 break＝这一形本闸门不认识，得人工过目').toBe(true)
  })

  it('漏杀对照：把改前那一形喂进同一套读法，它必须被认成 break（否则第 A 面是空的）', () => {
    const hit = findBudgetIf(BUDGET_BEFORE)
    expect(hit, '改前那一形没被读出（条件写法变了？）').toBeTruthy()
    expect(ts.isBreakStatement(hit!.node.thenStatement), '改前那一形没被认成 break').toBe(true)
  })

  it('三档常量在 shared 里各定义一次（读法读得到＝下面的计数不是对空集说话）', () => {
    for (const name of ['MEMORY_INJECT_MAX_ITEMS', 'MEMORY_INJECT_MAX_ITEM_CHARS', 'MEMORY_INJECT_MAX_TOTAL_CHARS']) {
      expect(SHARED, `shared 里没有 ${name}`).toContain(`export const ${name} =`)
    }
  })
})

describe('A：总预算那一圈放行的是「逐条试放」，不是「整批放弃」', () => {
  it('那颗判断的 then 支必须是 continue', () => {
    const hit = findBudgetIf(MEMORY)!
    expect(ts.isContinueStatement(hit.node.thenStatement), '又变回 break＝一条长记忆挤掉后面塞得下的短记忆').toBe(true)
  })

  it('整个函数里不许出现任何 break（换个地方整批放弃）', () => {
    const file = sf('memory.ts', MEMORY)
    const fn = findFn(file, 'buildMemoryContext')!
    let breaks = 0
    walk(fn, (n) => {
      if (ts.isBreakStatement(n)) breaks++
    })
    expect(breaks, '注入循环里还有 break').toBe(0)
  })

  it('预算比较用的是 shared 那颗总量常量（不许把 2000 又抄回主进程）', () => {
    const hit = findBudgetIf(MEMORY)!
    expect(hit.node.expression.getText(hit.file), '比较的不是 shared 常量').toContain('MEMORY_INJECT_MAX_TOTAL_CHARS')
    expect(MEMORY).not.toMatch(/>\s*2000\b/)
  })
})

describe('B：三档数字只住一份（主进程与渲染层都 import）', () => {
  it('memory.ts 里不许再有本地常量定义（改前三行 const MAX_* = 数字）', () => {
    expect(MEMORY, '本地又定义了一份上限＝两处各写一遍，改一处就漂').not.toMatch(/^const MAX_/m)
    expect(MEMORY).toMatch(/from '[^']*shared\/schemas\/memory'/)
  })

  it('条数与单条长度两处比较也都走 shared 名（slice/map 那两发不许写裸数字）', () => {
    expect(MEMORY).toMatch(/slice\(0,\s*MEMORY_INJECT_MAX_ITEMS\)/)
    expect(MEMORY).toMatch(/slice\(0,\s*MEMORY_INJECT_MAX_ITEM_CHARS\)/)
    expect(MEMORY, '裸 50 或裸 200 回来了').not.toMatch(/slice\(\s*0,\s*(50|200)\s*\)/)
  })

  it('shared 那三颗的值就是行为用例钉的 50／200／2000（改了数字要两头一起改）', () => {
    expect(SHARED).toMatch(/MEMORY_INJECT_MAX_ITEMS = 50/)
    expect(SHARED).toMatch(/MEMORY_INJECT_MAX_ITEM_CHARS = 200/)
    expect(SHARED).toMatch(/MEMORY_INJECT_MAX_TOTAL_CHARS = 2000/)
  })
})

describe('C：设置页那句提示把三档上限说出来（数字由 params 带出）', () => {
  const DICTS = { zh, en, ja, ko } as const

  it('四语都在，且三颗占位符一颗不缺', () => {
    for (const lang of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const s = (DICTS[lang] as Record<string, string>)['set.memoryHint']
      expect(s, `${lang} 缺 set.memoryHint`).toBeTruthy()
      for (const p of ['{items}', '{itemChars}', '{totalChars}']) {
        expect(s, `${lang} 那句里没有 ${p}`).toContain(p)
      }
      expect(s, `${lang} 用了双花括号（t() 只替换单花括号＝屏上会留字面大括号）`).not.toContain('{{')
    }
  })

  it('字典里不许出现裸数字（数字必须由调用点从 shared 带出，否则改了上限文案还说旧数）', () => {
    for (const lang of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const s = (DICTS[lang] as Record<string, string>)['set.memoryHint']
      expect(s, `${lang} 那句里写死了数字`).not.toMatch(/\d{2,}/)
    }
  })

  it('调用点带三颗 params 且键名与占位符同名（少一颗就是屏上留 {items}）', () => {
    const file = sf('UserMemoryPanel.tsx', PANEL)
    let hit: ts.CallExpression | undefined
    walk(file, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 't') return
      const a = n.arguments[0]
      if (a && ts.isStringLiteral(a) && a.text === 'set.memoryHint') hit = n
    })
    expect(hit, '调用点找不到 t(\'set.memoryHint\', …)').toBeTruthy()
    const params = (hit as ts.CallExpression).arguments[1]
    expect(params && ts.isObjectLiteralExpression(params), '第二参不是对象字面量').toBe(true)
    const keys = (params as ts.ObjectLiteralExpression).properties
      .map((p) => (ts.isPropertyAssignment(p) ? p.name.getText(file) : ''))
      .sort()
      .join('/')
    expect(keys, 'params 的三颗键名漂了（少一颗＝屏上留字面 {items}）').toBe('itemChars/items/totalChars')
    const body = (params as ts.ObjectLiteralExpression).getText(file)
    for (const c of ['MEMORY_INJECT_MAX_ITEMS', 'MEMORY_INJECT_MAX_ITEM_CHARS', 'MEMORY_INJECT_MAX_TOTAL_CHARS']) {
      expect(body, `params 里 ${c} 不是取自 shared`).toContain(c)
    }
  })

  it('反向钉：渲染层不许自己 .replace 那三颗占位符（手替只换第一处＝§361 那族）', () => {
    expect(PANEL, '手写替换占位符回来了').not.toMatch(/replace\(['"`]\{items/)
    expect(PANEL).not.toMatch(/replace\(['"`]\{itemChars/)
    expect(PANEL).not.toMatch(/replace\(['"`]\{totalChars/)
  })
})
