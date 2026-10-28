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
