// V4-Iter-342 闸门第八面：锁屏事件到达时必须重读加密态，且"读＋写回"只许有一份
//
// 形状＝主进程状态在渲染层留了一份只在挂载时取的副本，而副本的使用点（锁屏遮罩）在很久之后。
// 两个窗口（主窗口 App.tsx／浮窗 DetachedApp.tsx）各自订一份，所以判据两头都要钉：
// ① 两边的 onLockStateChange 回调里都必须重读（少一处＝那一扇窗继续按旧值渲染）；
// ② `setDbEncrypted(s.dbEncrypted)` 这行"写回"在全渲染层只许出现一次（在 utils/lock-flags.ts 里），
//    出现第二次就是又开了一份会漂的副本。
// ③＝§343 加的那句「数据仍是明文」只许挂在 encKnown 上（遮罩三张脸的来源）。
// ④＝§344 加的：设置页那一整块 EncryptionStatus 也有三个读者，三发必须共用一份代次守卫。
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

/**
 * 数一个文件里**真调用**了几次这个名字（`x.method()` 与 `method()` 两种写法都算，注释里写多少遍都不算）。
 * 为什么不用字符串计数：本仓的错误话术里到处写着通道名（`logIpcError('settings.getEncryptionStatus', e)`），
 * 数文本会把"记下这次失败"算成"又发了一次读"（纪律第 33 条）。
 */
function ipcCallCount(text: string, method: string): number {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let n = 0
  const visit = (node: ts.Node): void => {
    if (!ts.isCallExpression(node)) return void ts.forEachChild(node, visit)
    const e = node.expression
    const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : ''
    if (name === method) n += 1
    ts.forEachChild(node, visit)
  }
  visit(src)
  return n
}

/** 取 `createEncryptionStatusSyncer({ setStatus: X, setErr: Y, t: Z })` 里某个属性的**值文本**（纪律第 36 条：只判属性在不在＝传错状态量也不红） */
function syncerDepInit(text: string, factory: string, prop: string): string | null {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === factory) {
      const arg = node.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          // `{ setErr }` 这种简写也要认——它的"值"就是同名标识符，漏掉这枝判据就悄悄少一条
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop) found = p.name.text
          else if (ts.isPropertyAssignment(p) && p.name.getText() === prop) found = p.initializer.getText().trim()
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

/** 数工厂体里「我这份不是最新 ⇒ 直接 return」那道守卫的条数（成功路径一条、catch 路径一条，少一条就是漏） */
function staleReturnCount(text: string, fnName: string): number {
  const src = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let n = 0
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      const walk = (inner: ts.Node): void => {
        if (ts.isIfStatement(inner) && /!==\s*gen\b/.test(inner.expression.getText()) && ts.isReturnStatement(inner.thenStatement))
          n += 1
        ts.forEachChild(inner, walk)
      }
      walk(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return n
}

/** 数工厂体里写回状态的那一行出现几次（1 次＝只有一个出口；2 次多半是失败侧也刷了值） */
function setStatusCallCount(text: string, fnName: string): number {
  const src = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let n = 0
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      const walk = (inner: ts.Node): void => {
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.name.text === 'setStatus'
        )
          n += 1
        ts.forEachChild(inner, walk)
      }
      walk(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return n
}

/**
 * 同步器是不是"每个组件实例只造一次"：那道 `if (!xxx.current) xxx.current = 工厂(…)` 守卫在不在。
 * 每次 render 现造一份＝代次计数器每帧归零，迟到守卫立刻没牙——这种写法源码里三发调用点一个不少、
 * 裸读也是 0，只有这一条判据（加 ③④ 那两条真挂载用例）拦得住。
 */
function refHeldCreationGuard(text: string, factory: string): string | null {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let guard: string | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === factory) {
      for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
        if (ts.isIfStatement(cur)) {
          const c = cur.expression
          if (
            ts.isPrefixUnaryExpression(c) &&
            c.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isPropertyAccessExpression(c.operand) &&
            c.operand.name.text === 'current'
          )
            guard = c.getText()
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return guard
}

/** 某个函数里那颗 useEffect 的依赖数组长度（没有第二个参数返回 -1，非数组字面量返回 -2） */
function effectDepsLength(text: string, fnName: string): number {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let out = -99
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      const walk = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'useEffect') {
          const deps = inner.arguments[1]
          out = !deps ? -1 : ts.isArrayLiteralExpression(deps) ? deps.elements.length : -2
        }
        ts.forEachChild(inner, walk)
      }
      walk(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

/** 泛化的 JSX 属性值判据（overlayPropInit 那个写死了 LockOverlay，这一份按标签取） */
function jsxPropInit(text: string, tag: string, prop: string): string | null {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText() === tag) {
        for (const a of node.attributes.properties) {
          if (!ts.isJsxAttribute(a) || a.name.getText() !== prop) continue
          const init = a.initializer
          if (!init || !ts.isJsxExpression(init) || !init.expression) continue
          found = init.expression.getText().trim()
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
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

// ─────────────────────────────────────────────────────────────────────────
// ④ V4-Iter-344：设置页那一整块加密态（EncryptionStatus）的三发读必须共用一份带代次守卫的同步器
//
// 形状＝§342 的姊妹处：一份主进程状态留着当面板数据，读者却有三个（挂载首发、锁屏事件重读、
// 面板动作后 refreshEnc），各写各的 ⇒ 迟到的旧读数能把面板画回改前的样子。
// 那颗「关掉加密」的写点就在面板动作里，所以这不是观感问题：画回「已加密＋已解锁」后，
// 那一格上还会给出改口令／关闭加密两颗键，用户按屏上有的键去点already变明文的库。
describe('④ 设置页的加密态三发读共用一份同步器（V4-Iter-344）', () => {
  const SETTINGS = 'modules/settings/SettingsModule.tsx'
  const FACTORY = 'utils/lock-flags.ts'

  it('新助手自己要有牙：调用计数不把 logIpcError(…) 那种"提到通道名"算成一次读', () => {
    const SAMPLE = `window.pocketai.getEncryptionStatus().then(ok)
logIpcError('settings.getEncryptionStatus', e)
// window.pocketai.getEncryptionStatus() 写在注释里`
    expect(ipcCallCount(SAMPLE, 'getEncryptionStatus')).toBe(1)
  })

  it('依赖值的判据有牙：把 setStatus 接错那份状态量必须报出来', () => {
    const GOOD = `const a = createEncryptionStatusSyncer({ setStatus: setEnc, setErr: setEncErr, t })`
    const WRONG = `const a = createEncryptionStatusSyncer({ setStatus: setLic, setErr: setEncErr, t })`
    expect(syncerDepInit(GOOD, 'createEncryptionStatusSyncer', 'setStatus')).toBe('setEnc')
    expect(syncerDepInit(WRONG, 'createEncryptionStatusSyncer', 'setStatus')).not.toBe('setEnc')
  })

  it('设置页三发读都走 syncEnc()：挂载一发＋锁屏事件一发＋refreshEnc 一发', () => {
    const text = read(SETTINGS)
    expect(syncCalls(text), '三发少一发＝那一发又变成没人管的裸读').toBe(3)
    const handlers = lockHandlers(text)
    expect(handlers.length, '这一屏必须订阅锁屏事件').toBe(1)
    expect((handlers[0] ?? '').includes('syncEnc('), '锁屏事件到达时那一发必须是共享同步器，不是自己再读一遍').toBe(true)
  })

  it('设置页里一处裸读都不许留（`.getEncryptionStatus()` 直接落值＝又开一份会漂的副本）', () => {
    expect(ipcCallCount(read(SETTINGS), 'getEncryptionStatus'), '这一发没有代次守卫，迟到的旧读数会顶掉新读数').toBe(0)
  })

  it('同步器只造一份，且写的就是面板那两份状态（setStatus=setEnc／setErr=setErr）', () => {
    const text = read(SETTINGS)
    expect(ipcCallCount(text, 'createEncryptionStatusSyncer'), '造两份＝两个各自独立的代次计数器，守卫等于没有').toBe(1)
    expect(syncerDepInit(text, 'createEncryptionStatusSyncer', 'setStatus')).toBe('setEnc')
    expect(syncerDepInit(text, 'createEncryptionStatusSyncer', 'setErr')).toBe('setErr')
  })

  it('同步器挂在 ref 上、只在建过一次里（每次 render 重造＝代次计数器每帧归零，守卫没牙）', () => {
    const text = read(SETTINGS)
    expect(refHeldCreationGuard(text, 'createEncryptionStatusSyncer'), '那道 `if (!xxx.current)` 守卫不见了').toMatch(/^!\w+\.current$/)
  })

  it('hook 的订阅 effect 依赖必须是空数组（否则每次 render 重订一次锁屏事件、多发一发读）', () => {
    expect(effectDepsLength(read(SETTINGS), 'useEncryptionCopy')).toBe(0)
  })

  it('两个面板拿到的都是 hook 那份副本（属性值判据，不是"属性在不在"）', () => {
    const text = read(SETTINGS)
    expect(jsxPropInit(text, 'EncryptionPanel', 'enc')).toBe('encCopy.enc')
    expect(jsxPropInit(text, 'EncryptionPanel', 'err')).toBe('encCopy.err')
    expect(jsxPropInit(text, 'EncryptionPanel', 'onChange')).toBe('encCopy.refresh')
    expect(jsxPropInit(text, 'BackupPanel', 'enc')).toBe('encCopy.enc')
  })

  it('漏杀对照三：同步器改成每次 render 现造／effect 依赖漏空数组 ⇒ 两条判据立刻红', () => {
    const REFK = `export function useX() {
  const r = useRef(null)
  if (!r.current) r.current = createEncryptionStatusSyncer({ setStatus: setEnc })
  useEffect(() => { void s() }, [])
  return 1
}`
    const PER_RENDER = REFK.replace('if (!r.current) r.current = createEncryptionStatusSyncer({ setStatus: setEnc })', 'const s = createEncryptionStatusSyncer({ setStatus: setEnc })')
    const NO_DEPS = REFK.replace('}, [])', '})')
    expect(refHeldCreationGuard(REFK, 'createEncryptionStatusSyncer')).toBe('!r.current')
    expect(refHeldCreationGuard(PER_RENDER, 'createEncryptionStatusSyncer')).toBeNull()
    expect(effectDepsLength(REFK, 'useX')).toBe(0)
    expect(effectDepsLength(NO_DEPS, 'useX'), '依赖整个不见了＝每次 render 都重订').toBe(-1)
  })

  it('工厂本体：成功侧与抛出侧各有一道"迟到就 return"，写回只有最新那一发的一个出口', () => {
    const text = read(FACTORY)
    expect(staleReturnCount(text, 'createEncryptionStatusSyncer'), '两条到货的路（resolve／reject）都要判代次，少一条＝那条能顶掉新读数').toBe(2)
    expect(setStatusCallCount(text, 'createEncryptionStatusSyncer'), '写回只许一个出口：失败侧若也写值＝把读不到演成"没加密"').toBe(1)
  })

  it('工厂漏杀对照：摘掉代次守卫／失败侧也写值 ⇒ 判据立刻红（不是恒绿）', () => {
    const GUARDED = `export function createEncryptionStatusSyncer(d: any) {
  let gen = 0
  return async () => {
    const my = ++gen
    try {
      const s = await f()
      if (my !== gen) return
      d.setStatus(s)
    } catch (e) {
      if (my !== gen) return
      d.setStatus(e)
    }
  }
}`
    const LOOSE = GUARDED.replace('      if (my !== gen) return\n      d.setStatus(s)', '      d.setStatus(s)')
    expect(staleReturnCount(GUARDED, 'createEncryptionStatusSyncer')).toBe(2)
    expect(staleReturnCount(LOOSE, 'createEncryptionStatusSyncer'), '摘掉成功侧那道守卫后必须只剩一条').toBe(1)
    expect(setStatusCallCount(GUARDED, 'createEncryptionStatusSyncer'), '失败侧写值＝两个出口').toBe(2)
  })

  it('全渲染层的裸读名单（谁还在自己读这一发）：三处各有理由，新增读者必须先进这张表', () => {
    const readers: Record<string, number> = {}
    for (const f of walk(ROOT)) {
      const n = ipcCallCount(read(path.relative(ROOT, f).replace(/\\/g, '/')), 'getEncryptionStatus')
      if (n) readers[path.relative(ROOT, f).replace(/\\/g, '/')] = n
    }
    expect(readers).toEqual({
      // 两份同步器的本体——"读回来落值"这件事只许写在这里
      'utils/lock-flags.ts': 2,
      // 只在挂载读一次、之后自己乐观更新，两发之间没有并发的读者 ⇒ 无代次守卫（判为设计内）
      'modules/wizard/FirstRunWizard.tsx': 1,
      // 每次判定都要实时问一次，不存副本 ⇒ 没有会漂的状态
      'utils/secret-consent.ts': 1
    })
  })
})
