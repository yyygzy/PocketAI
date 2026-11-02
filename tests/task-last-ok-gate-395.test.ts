// §395 常驻闸门：维护任务「跑过」与「跑成功了」是两件事，从写入到上屏一条链都不许塌
//
// 钉的是**结构**（行为那一半在 `task-scheduler-last-ok-395.test.ts` / `data-health-task-last-ok-395.test.ts`，
// 屏上的脸在 `renderer-task-last-ok-face-395.test.tsx`）：
//   A 写入侧：两档各记各的（成功支不落、失败支落 `ok = false`），两颗都写在同一颗保护里
//     ＆ flag 排在时间戳之前＆键名只在一处拼
//   B 读侧：两条任务各读自己两颗键；那一读只认两个记号，脏值＝"不知道"
//   C 契约：四颗字段齐，两颗 flag 是必填的三档（不许 `?:` 让消费面把 undefined 当 false）
//   D 屏侧：三档机关只有一份定义、两行各自按身份绑门（warn 读 initializer 的标识符，第 36 条）、
//     不许出现把 null 折成失败／成功的写法、不许硬写中文
//   E 四语齐＋措辞说"未报错"（跳过的一跑没抛错，但不是"校验通过"）
//   F 读法自证：分类器在合成片段上要能认出"只写时间戳"与"warn 绑 truthy"两种坏形状
//
// 计数一律读**去掉注释后的源码**（第 33 条：自己写的注释会把同一串撑大→假红／假绿）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const raw = (rel: string): string => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8')

/** 剥掉块注释与行注释（字符串与模板原样保留） */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i + 2)
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 取 `<decl>` 之后第一个大括号配平的块（函数体／接口体） */
function blockAfter(src: string, decl: string): string {
  const i = src.indexOf(decl)
  expect(i, `找不到 ${decl}`).toBeGreaterThan(-1)
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1) }
  }
  throw new Error(`${decl} 的大括号不配平`)
}

const SCHED = stripComments(raw('main/backup/task-scheduler.ts'))
const HEALTH = stripComments(raw('main/steward/data-health.ts'))
const TYPES = stripComments(raw('shared/types.ts'))
const PANEL_RAW = raw('renderer/src/modules/settings/DataHealthPanel.tsx')
const PANEL = stripComments(PANEL_RAW)

/** runTask 体的三段（try／catch／finally）：按锚点字符串切。
 *  注意 finally 里还嵌着一颗 try（写不回时间戳只 warn），所以 'try {' 天然出现两次——
 *  这里只要求三个锚点按顺序各出现一次，不比个数。 */
function runTaskArms(): { tryArm: string; catchArm: string; finallyArm: string } {
  const body = blockAfter(SCHED, 'async function runTask')
  const at = (needle: string, after: number): number => {
    const i = body.indexOf(needle, after)
    expect(i, `runTask 体里找不到 ${needle}（在偏移 ${after} 之后）`).toBeGreaterThan(-1)
    return i
  }
  const tryStart = at('try {', 0)
  const catchStart = at('} catch', tryStart)
  const finallyStart = at('} finally', catchStart)
  return {
    tryArm: body.slice(tryStart, catchStart),
    catchArm: body.slice(catchStart, finallyStart),
    finallyArm: body.slice(finallyStart)
  }
}

describe('A 写入侧：两档各记各的，且两颗都写在那颗保护里', () => {
  const arms = runTaskArms()
  const body = blockAfter(SCHED, 'async function runTask')

  it('失败支落 `ok = false`，成功支不落（两档同一个值＝这一颗没有牙）', () => {
    expect(body).toContain('let ok = true')
    expect(arms.catchArm).toContain('ok = false')
    expect(arms.tryArm, `现数成功支：${arms.tryArm}`).not.toContain('ok = false')
  })

  it('两颗写在同一颗保护里：flag 在前、时间戳在后，且都在内层 try 之内（写在保护外＝锁屏时抛出顶掉任务真因）', () => {
    const flagAt = arms.finallyArm.indexOf('setLastOk(task.key, ok)')
    const runAt = arms.finallyArm.indexOf('setLastRun(task.key, at)')
    const innerTry = arms.finallyArm.indexOf('try {')
    const innerCatch = arms.finallyArm.indexOf('} catch')
    expect(innerTry, `现数 finally：${arms.finallyArm}`).toBeGreaterThan(-1)
    expect(innerCatch).toBeGreaterThan(innerTry)
    expect(flagAt, 'flag 没写在 finally 的保护里').toBeGreaterThan(innerTry)
    expect(flagAt).toBeLessThan(innerCatch)
    expect(runAt).toBeGreaterThan(innerTry)
    expect(runAt).toBeLessThan(innerCatch)
    expect(flagAt, '顺序：flag 必须排在时间戳之前').toBeLessThan(runAt)
  })

  it('那一颗的键名只在一处拼（读写两侧不许各抄一份模板）', () => {
    expect(SCHED.match(/task\.\$\{key\}\.last_ok/g)?.length ?? 0).toBe(1)
  })
})

describe('B 读侧：两条任务各读自己两颗键，脏值＝不知道', () => {
  it('四把键齐（两条任务 × 时间戳与 flag）', () => {
    for (const k of [
      'task.kb_health_check.last_run_at',
      'task.kb_health_check.last_ok',
      'task.backup_verify.last_run_at',
      'task.backup_verify.last_ok'
    ]) {
      expect(HEALTH, `data-health 没读 ${k}`).toContain(`'${k}'`)
    }
  })

  it('那一读只认两个记号：1⇒true、0⇒false、其余⇒null（不许把脏值折成任一档）', () => {
    const read = blockAfter(HEALTH, 'function readLastOk')
    expect(read).toContain(`=== '1'`)
    expect(read).toContain(`=== '0'`)
    expect(read).toMatch(/null/)
    expect(read, `现数读体：${read}`).not.toMatch(/Boolean\(/)
    expect(read).not.toMatch(/!==\s*'0'/)
  })

  it('那一读抛错回 null（未解锁时 appConfigRepo 会抛，不能把"读不出来"说成"上次失败"）', () => {
    expect(blockAfter(HEALTH, 'function readLastOk')).toMatch(/catch\s*\{[^}]*return null/)
  })
})

describe('C 契约：四颗字段齐、flag 是必填的三档', () => {
  const iface = (() => {
    const i = TYPES.indexOf('tasks: {')
    expect(i, '找不到 DataHealthReport 的 tasks 块').toBeGreaterThan(-1)
    const open = i + 'tasks: '.length
    let depth = 0
    for (let j = open; j < TYPES.length; j++) {
      if (TYPES[j] === '{') depth++
      else if (TYPES[j] === '}') { depth--; if (depth === 0) return TYPES.slice(open, j + 1) }
    }
    throw new Error('tasks 块大括号不配平')
  })()

  it('两颗 flag 写成 `boolean | null` 且不带 ?（可选＝消费面把 undefined 当 false 的入口）', () => {
    for (const f of ['kbHealthCheckLastOk', 'backupVerifyLastOk']) {
      expect(iface, `契约缺 ${f}`).toContain(`${f}: boolean | null`)
      expect(iface, `${f} 不许是可选字段`).not.toContain(`${f}?:`)
    }
    for (const f of ['kbHealthCheckLastRunAt', 'backupVerifyLastRunAt']) {
      expect(iface).toContain(`${f}: number | null`)
    }
  })
})

describe('D 屏侧：三档机关一份定义、两行按身份各自绑门', () => {
  const sf = ts.createSourceFile('panel.tsx', PANEL_RAW, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX)

  /** 收集 `<Row ... />` 自闭合元素上的属性文本 */
  const rowsOf = (labelKey: string): Map<string, string> => {
    const found: Map<string, string>[] = []
    const walk = (n: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === 'Row') {
        const attrs = new Map<string, string>()
        for (const p of n.attributes.properties) {
          if (ts.isJsxAttribute(p) && p.initializer) attrs.set(p.name.getText(sf), p.initializer.getText(sf))
        }
        if ((attrs.get('label') ?? '').includes(labelKey)) found.push(attrs)
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
    expect(found.length, `屏上 ${labelKey} 那一行读到 ${found.length} 处（应当恰好 1）`).toBe(1)
    const only = found[0]
    // 空 Map 只喂 tsc：上面那句数过才是牙（那一行不是恰好一处就当场红）
    return only ?? new Map<string, string>()
  }

  const TASKS = ['kbHealthCheck', 'backupVerify'] as const
  const KEYS: Record<(typeof TASKS)[number], string> = {
    kbHealthCheck: 'dh.task.kbHealthCheck',
    backupVerify: 'dh.task.backupVerify'
  }

  it('两行各自 taskResult(tasks.<自己>LastRunAt, tasks.<自己>LastOk)（同一条任务的两颗字段，不许交叉）', () => {
    for (const t of TASKS) {
      const expr = rowsOf(KEYS[t]).get('value') ?? ''
      expect(
        expr,
        `${t} 的 value 没走那份三档机关：${expr}`
      ).toMatch(new RegExp(`^\\{taskResult\\(tasks\\.${t}LastRunAt, tasks\\.${t}LastOk\\)\\}$`))
    }
  })

  it('warn 绑在 `=== false` 上（读 initializer 的标识符，第 36 条：truthy 判据会把 null 也画红）', () => {
    for (const t of TASKS) {
      const expr = rowsOf(KEYS[t]).get('warn') ?? ''
      expect(expr, `${t} 的 warn 没绑到自己那颗 flag：${expr}`).toBe(`{tasks.${t}LastOk === false}`)
    }
  })

  it('那份机关只有一份定义，且三档各有出口（true／false／其余只报时间）', () => {
    expect(PANEL.match(/const taskResult = /g)?.length ?? 0).toBe(1)
    const defn = blockAfter(PANEL, 'const taskResult = ')
    expect(defn).toContain('lastOk === true')
    expect(defn).toContain('lastOk === false')
    expect(defn).toContain("t('dh.never')")
    expect(defn).toContain("t('dh.task.lastOk')")
    expect(defn).toContain("t('dh.task.lastFailed')")
  })

  it('那两行不许硬写中文（句子只能来自字典）', () => {
    const defn = blockAfter(PANEL, 'const taskResult = ')
    expect(defn, `现数机关体：${defn}`).not.toMatch(/[一-龥]/)
  })
})

describe('E 四语：两颗键齐、措辞说"未报错"', () => {
  const dicts = ['zh', 'en', 'ja', 'ko'].map((lang) => ({
    lang,
    src: stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${lang}.ts`), 'utf8'))
  }))

  it('四份字典都带这两颗键', () => {
    for (const d of dicts) {
      for (const key of ['dh.task.lastOk', 'dh.task.lastFailed']) {
        expect(d.src, `${d.lang} 缺 ${key}`).toContain(`'${key}'`)
      }
    }
  })

  it('zh 那句说"未报错"而不是"成功"：跳过的一跑没抛错、但也没验任何东西', () => {
    const zh = dicts.find((d) => d.lang === 'zh')!.src
    const line = zh.split('\n').find((l) => l.includes("'dh.task.lastOk'")) ?? ''
    expect(line).toContain('未报错')
    expect(line, `现数那一行：${line}`).not.toContain('成功')
  })
})

describe('F 读法自证：分类器认得两种坏形状', () => {
  it('合成一段"只写时间戳"的 runTask ⇒ A 的两颗判据都必须抓红', () => {
    const bad = stripComments(`async function runTask(task: TaskDef): Promise<void> {
  const at = Date.now()
  try {
    await task.run()
  } catch (e) {
    log.warn(String(e))
  } finally {
    try {
      setLastRun(task.key, at)
    } catch (e) {
      log.warn(String(e))
    }
  }
}`)
    const body = blockAfter(bad, 'async function runTask')
    const catchArm = body.slice(body.indexOf('} catch'), body.indexOf('} finally'))
    const finallyArm = body.slice(body.indexOf('} finally'))
    expect(catchArm.includes('ok = false'), '改前形状＝失败支不落那一颗（分类器若放行＝闸门无牙）').toBe(false)
    expect(finallyArm.includes('setLastOk'), '改前形状＝根本没写那一颗').toBe(false)
  })

  it('合成一段"flag 写在保护外"的 runTask ⇒ 那颗位置判据必须抓红', () => {
    const bad = stripComments(`async function runTask(task: TaskDef): Promise<void> {
  const at = Date.now()
  let ok = true
  try {
    await task.run()
  } catch (e) {
    ok = false
  } finally {
    setLastOk(task.key, ok)
    try {
      setLastRun(task.key, at)
    } catch (e) {
      log.warn(String(e))
    }
  }
}`)
    const finallyArm = bad.slice(bad.indexOf('} finally'))
    const innerTry = finallyArm.indexOf('try {')
    expect(finallyArm.indexOf('setLastOk') < innerTry, '写在保护外＝库一关就抛出顶掉真因，分类器必须认出这形').toBe(true)
  })

  it('合成一行"warn 绑 truthy"的 Row ⇒ D 的那颗判据必须抓红', () => {
    const bad = `const x = <Row label={t('dh.task.kbHealthCheck')} value={y} warn={!tasks.kbHealthCheckLastOk} />`
    const badSf = ts.createSourceFile('bad.tsx', bad, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX)
    let attrs: Map<string, string> | null = null
    const walk = (n: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(badSf) === 'Row') {
        attrs = new Map()
        for (const p of n.attributes.properties) {
          if (ts.isJsxAttribute(p) && p.initializer) attrs.set(p.name.getText(badSf), p.initializer.getText(badSf))
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(badSf)
    expect((attrs as unknown as Map<string, string>).get('warn')).not.toBe('{tasks.kbHealthCheckLastOk === false}')
  })
})
