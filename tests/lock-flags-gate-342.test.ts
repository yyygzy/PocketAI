// V4-Iter-342 闸门第八面：锁屏事件到达时必须重读加密态，且"读＋写回"只许有一份
//
// 形状＝主进程状态在渲染层留了一份只在挂载时取的副本，而副本的使用点（锁屏遮罩）在很久之后。
// 两个窗口（主窗口 App.tsx／浮窗 DetachedApp.tsx）各自订一份，所以判据两头都要钉：
// ① 两边的 onLockStateChange 回调里都必须重读（少一处＝那一扇窗继续按旧值渲染）；
// ② `setDbEncrypted(s.dbEncrypted)` 这行"写回"在全渲染层只许出现一次（在 utils/lock-flags.ts 里），
//    出现第二次就是又开了一份会漂的副本。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../src/renderer/src')

/** 返回该文件里每个 onLockStateChange 回调的源码文本（没有订阅就是空数组） */
function lockHandlers(text: string): string[] {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'onLockStateChange'
    ) {
      const cb = node.arguments[0]
      if (cb) found.push(cb.getText())
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

/** 数这个文件里真正调了几次 `syncEnc()`（读 AST，注释里写什么都数不清） */
function syncCalls(text: string): number {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let n = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'syncEnc') n += 1
    ts.forEachChild(node, visit)
  }
  visit(src)
  return n
}

/**
 * 找出某个 i18n 键被引用时**头顶上所有三元表达式的条件**（读 AST、沿父链往上走）。
 * 为什么要一整串而不是"它紧挨着的那个条件"：这句「数据仍是明文」在源码里挂在
 * `encKnown ? (dbEncrypted ? 已激活 : 明文) : …` 的第二层上，只看内层会读到 dbEncrypted，
 * 于是"外层到底有没有先问过 encKnown"这件事就没人管了（§343 要的正是这一条）。
 */
function guardConditionsOf(text: string, key: string): string[] {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text === key) {
      for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
        if (ts.isConditionalExpression(cur)) out.push(cur.condition.getText())
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

/**
 * 取 <LockOverlay> 上某个属性的** initializer 源码文本**（没有该属性返回 null）。
 * 只判"属性在不在"是不够的（§343 变异 N4 就是这么活的）：把 encPending 写成常量 false
 * 等于"确认中那一格永远不会出现"，而属性名照样在——所以判据必须读到值那一层。
 */
function overlayPropInit(text: string, prop: string): string | null {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText() === 'LockOverlay') {
        for (const a of node.attributes.properties) {
          if (!ts.isJsxAttribute(a) || a.name.getText() !== prop) continue
          const init = a.initializer
          if (!init || !ts.isJsxExpression(init) || !init.expression) continue
          const e = init.expression
          // {x} 的占位槽在属性文本里带花括号，剥掉后再比对，免得把 "{dbEncPending}" 当成字面量
          found = e.getText().trim()
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('① 检测器自己要有牙', () => {
  const WITH = `window.pocketai.onLockStateChange((e) => { setLocked(e.state === 'locked'); void syncEnc().catch(f) })`
  const WITHOUT = `window.pocketai.onLockStateChange((e) => { setLocked(e.state === 'locked') })`

  it('认得出"回调里重读了"与"没重读"', () => {
    expect(lockHandlers(WITH).some((b) => b.includes('syncEnc('))).toBe(true)
    expect(lockHandlers(WITHOUT).some((b) => b.includes('syncEnc('))).toBe(false)
  })

  it('漏杀对照：订阅整个不写 ⇒ 检测器给空数组（判据不是恒绿）', () => {
    expect(lockHandlers(`const a = 1`)).toEqual([])
    expect(lockHandlers(WITH)).toHaveLength(1)
  })

  it('漏杀对照：数调用次数只数真调用（注释里写一百遍 syncEnc() 也不算）', () => {
    const TWO = `const a = () => { void syncEnc() }\nconst b = () => { void syncEnc() }`
    const ONE = `const a = () => { void syncEnc() }\n// const b = () => { void syncEnc() }`
    expect(syncCalls(TWO)).toBe(2)
    expect(syncCalls(ONE)).toBe(1)
  })
})

describe('② 两个窗口都订、都重读', () => {
  for (const rel of ['App.tsx', 'detached/DetachedApp.tsx']) {
    it(`${rel}：onLockStateChange 的回调里必须重读加密态`, () => {
      const handlers = lockHandlers(read(rel))
      expect(handlers.length, '这一屏必须订阅锁屏事件').toBe(1)
      expect((handlers[0] ?? '').includes('syncEnc('), '锁屏事件到达时必须重读（§342）').toBe(true)
    })
  }

  it('两处都用同一份同步器，不许有人自己再写一遍读＋落值', () => {
    const writers = walk(ROOT).filter((f) => read(path.relative(ROOT, f).replace(/\\/g, '/')).includes('setDbEncrypted(s.dbEncrypted)'))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
      .sort()
    expect(writers, '「读回来直接写进本窗副本」这行只许在 lock-flags.ts 里出现一次').toEqual(['utils/lock-flags.ts'])
  })

  it('每个窗口都读两发：挂载一发＋锁屏事件一发（摘掉任一发都会红）', () => {
    for (const rel of ['App.tsx', 'detached/DetachedApp.tsx']) {
      expect(syncCalls(read(rel)), `${rel} 必须有「挂载首读」与「锁屏事件重读」两发`).toBe(2)
    }
  })
})

describe('③ 那句「数据仍是明文」只许挂在 encKnown 上（V4-Iter-343）', () => {
  it('两个调用点都把**本窗那份状态**传给遮罩（属性在不够，值不许是常量）', () => {
    const WANT: Record<string, [string, string]> = {
      'App.tsx': ['dbEncKnown', 'dbEncPending'],
      'detached/DetachedApp.tsx': ['encKnown', 'encPending']
    }
    for (const [rel, [known, pending]] of Object.entries(WANT)) {
      const text = read(rel)
      expect(overlayPropInit(text, 'encKnown'), rel).toBe(known)
      expect(overlayPropInit(text, 'encPending'), rel).toBe(pending)
    }
  })

  it('组件里那句只出现一次，且引用它的三元链上必须有人先问过 encKnown', () => {
    const text = read('components/LockOverlay.tsx')
    expect((text.match(/lock\.plainModeNote/g) ?? []).length, '不许有人再加一处无守卫的读者').toBe(1)
    const guards = guardConditionsOf(text, 'lock.plainModeNote')
    expect(guards.length, '这句没被任何条件包着＝它总是先说出来').toBeGreaterThan(0)
    expect(guards.some((g) => g.includes('encKnown')), `整串条件里没问到 encKnown：${JSON.stringify(guards)}`).toBe(true)
  })

  it('漏杀对照一：条件链里抽掉 encKnown ⇒ 判据立刻红（不是恒绿）', () => {
    const GUARDED = `const a = encKnown ? (dbEncrypted ? t('lock.protected') : t('lock.plainModeNote')) : null`
    const LOOSE = `const a = dbEncrypted ? t('lock.protected') : t('lock.plainModeNote')`
    expect(guardConditionsOf(GUARDED, 'lock.plainModeNote').some((g) => g.includes('encKnown'))).toBe(true)
    expect(guardConditionsOf(LOOSE, 'lock.plainModeNote').some((g) => g.includes('encKnown'))).toBe(false)
  })

  it('漏杀对照二：属性在但值被写成常量 ⇒ 值判据必须报出来（变异 N4 的形状）', () => {
    const GOOD = `const a = () => (<LockOverlay dbEncrypted={false} encKnown={dbEncKnown} encPending={dbEncPending} />)`
    const CONST = `const a = () => (<LockOverlay dbEncrypted={false} encKnown={dbEncKnown} encPending={false} />)`
    expect(overlayPropInit(GOOD, 'encPending')).toBe('dbEncPending')
    expect(overlayPropInit(CONST, 'encPending')).not.toBe('dbEncPending')
  })
})
