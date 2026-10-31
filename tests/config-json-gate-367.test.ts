// V4-Iter-367 的常驻闸门：config.json 这一份「三把钥匙共用」的文件，读写各只有一个人管
//
// 它盯的是形状，但每一颗形状都挂着 367 那批行为用例演过的后果：
//  · 写不许直接打 CONFIG_PATH（改前三发都是 writeFileSync(CONFIG_PATH, …)＝断电就留半截）
//  · 三个写点必须都经 mutateConfigFile，体内不许再有 JSON.parse（改前正是各自 parse 一次、
//    解析失败就 catch 里一句"损坏则重建"把整份文件按空对象重写＝抹掉兄弟键）
//  · 三个读点必须都经 readConfigFile，且「没有文件／读不出／解析失败」三档各有一句
//  · swallow 侧（salt／KDF）不许静默：catch 里要有 log.warn；恢复包那侧不许咽：要 throw
// 读法先钉（不证读法，下面所有 0 与 1 都可能是分类器瞎了）：函数名逐个读得到、调用点与第一
// 实参取到一颗已知函数；再把改前的三种形状喂进同一套读法，必须各报出来。
// 本文件一律用字符扫描而不是含斜杠的正则——`(//…)` 这种写法会让词法器在正则里看到"注释"。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const REPO = path.join(process.cwd(), 'src', 'main', 'db', 'repositories', 'app-config.repo.ts')
const SRC = readFileSync(REPO, 'utf8')

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
}

/** 顶层 function 声明的名字 → 函数体文本 */
function functions(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.set(n.name.text, n.body.getText())
    ts.forEachChild(n, walk)
  }
  walk(parse(text))
  return out
}

/** 调用点名：`foo(` 取 foo，`a.b(` 取 b（这样 JSON.parse 才看得见） */
function calledNames(bodyText: string): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) out.push(n.expression.text)
      else if (ts.isPropertyAccessExpression(n.expression)) out.push(n.expression.name.text)
    }
    ts.forEachChild(n, walk)
  }
  walk(parse('function __probe(): void {' + bodyText + '}'))
  return out
}

/** 某个调用的第一实参文本：用来问"这发 writeFileSync 打的是哪个路径变量" */
function firstArgOf(bodyText: string, fn: string): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn) {
      out.push(n.arguments[0] ? n.arguments[0].getText() : '')
    }
    ts.forEachChild(n, walk)
  }
  walk(parse('function __probe(): void {' + bodyText + '}'))
  return out
}

/** 从某个 catch 开头往后取它自己的体（配平花括号） */
function catchBodyOf(body: string, opener: string): string | null {
  const i = body.indexOf(opener)
  if (i < 0) return null
  let depth = 0
  for (let j = i + opener.length - 1; j < body.length; j++) {
    if (body[j] === '{') depth++
    else if (body[j] === '}') {
      depth--
      if (depth === 0) return body.slice(i + opener.length, j).trim()
    }
  }
  return null
}

/** 把注释剥掉后还剩不剩代码（注释不算"做了事"） */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += text[i]
    i++
  }
  return out.trim()
}

/**
 * 这一发 parse 失败是不是被**彻底咽掉**：catch 体里除了注释什么都不做，
 * 而且catch 之后也没有留档／throw／说一句——只有"后面有人处理"才不算咽。
 * （改前的读点是 catch { return null }，catch 体里有动作，但那是把"读不出"当成"没有"，
 *   由 ④ 那面单独盯；这一把尺子只管"咽到底"那一种。）
 */
function swallowsFailure(body: string): boolean {
  for (const opener of ['catch {', 'catch (e) {']) {
    let from = 0
    for (;;) {
      const i = body.indexOf(opener, from)
      if (i < 0) break
      from = i + 1
      const inner = catchBodyOf(body, opener.slice(0, opener.length))
      if (inner === null) continue
      // 重新按位置取一次体（catchBodyOf 只找第一处，这里要逐处）
      let depth = 0
      let end = -1
      for (let j = i + opener.length - 1; j < body.length; j++) {
        if (body[j] === '{') depth++
        else if (body[j] === '}') {
          depth--
          if (depth === 0) { end = j; break }
        }
      }
      if (end < 0) continue
      if (stripComments(body.slice(i + opener.length, end)) !== '') continue
      const after = body.slice(end + 1)
      if (!/log\.warn|throw |renameSync\(|renameWithRetry\(/.test(after)) return true
    }
  }
  return false
}

const FN = functions(SRC)
const WRITERS = ['writeSaltToConfigFile', 'writeRecoveryBlobToConfigFile', 'writeKdfToConfigFile']
const READERS = ['readSaltFromConfigFile', 'readRecoveryFromConfigFile', 'readKdfFromConfigFile']

describe('读法自证：分类器看得到这份源码里的函数、调用点与第一实参', () => {
  it('顶层函数逐个读得到（读不到＝下面所有判定都在数空气）', () => {
    expect([...FN.keys()].sort()).toEqual([
      'clearAppConfigCache',
      'loadConfigForWrite',
      'mutateConfigFile',
      'readConfigFile',
      'readKdfFromConfigFile',
      'extractRecoveryBlob',
      'readRecoveryFromConfigFile',
      'salvageRecoveryFromUnparseableFile',
      'readSaltFromConfigFile',
      'renameWithRetry',
      'saveConfigFile',
      'sleepSync',
      'writeKdfToConfigFile',
      'writeRecoveryBlobToConfigFile',
      'writeSaltToConfigFile'
    ].sort())
    expect(FN.size, '顶层函数总数（再加一条读写通道或 rename 辅助要人工过目）').toBe(15)
  })

  it('已知函数的调用点与第一实参取得到（拿 saveConfigFile 当对照）', () => {
    const body = FN.get('saveConfigFile') ?? ''
    const calls = calledNames(body)
    for (const want of ['writeFileSync', 'renameWithRetry', 'unlinkSync', 'stringify']) {
      expect(calls, '少了 ' + want).toContain(want)
    }
    expect(firstArgOf(body, 'writeFileSync'), '写的那一发打的应该是临时文件变量').toEqual(['tmp'])
  })

  it('catch 体的取法与"咽到底"的判法本身有牙（三种 fixture 各算出不同的数）', () => {
    expect(catchBodyOf('try { a() } catch { b() } finally { c() }', 'catch {'), '配平只到 catch 自己').toBe('b()')
    // ① 空体、后面没人处理 ⇒ 咽
    expect(swallowsFailure('function f(): void { try { JSON.parse(x) } catch { /* 忽略 */ } }')).toBe(true)
    // ② 空体、但 catch 之后留了档 ⇒ 不算咽（现在源码的长相）
    expect(swallowsFailure('function f(): void { try { JSON.parse(x) } catch { /* 落下 */ } renameSync(a, b); log.warn("说了") }')).toBe(false)
    // ③ catch 体里直接说话 ⇒ 不算咽
    expect(swallowsFailure('function f(): void { try { JSON.parse(x) } catch (e) { log.warn(String(e)) } }')).toBe(false)
  })
})

describe('① 写：整个模块只有一发写文件，且打的是独占临时文件', () => {
  it('writeFileSync 的第一实参里不许出现 CONFIG_PATH（改前三发都是它）', () => {
    const hitting = [...FN.entries()].flatMap(([name, body]) =>
      firstArgOf(body, 'writeFileSync').filter((a) => a.includes('CONFIG_PATH')).map((a) => name + ':' + a)
    )
    expect(hitting.join('\n'), '直接写目标文件的站点').toBe('')
  })

  it('写文件的站点数＝1，且就挂在 saveConfigFile 上（新增第二发要连"兄弟键带着走"一起证）', () => {
    const sites = [...FN.entries()].flatMap(([name, body]) => firstArgOf(body, 'writeFileSync').map((a) => name + '(' + a + ')'))
    expect(sites.sort().join(' + '), '现查写入站点').toBe('saveConfigFile(tmp)')
  })

  it('saveConfigFile 里 flag: "wx"（独占建）与 renameWithRetry(tmp, CONFIG_PATH)（原子换）两样都在', () => {
    const body = FN.get('saveConfigFile') ?? ''
    expect(body).toContain("flag: 'wx'")
    expect(body).toContain('renameWithRetry(tmp, CONFIG_PATH)')
  })

  it('§374 renameWithRetry 那一层两头钉：自己体内真打 renameSync(from, to) 且只在瞬时码上退避', () => {
    const body = FN.get('renameWithRetry') ?? ''
    expect(body, '退避重试最终还要落到真原子换').toContain('renameSync(from, to)')
    // 反向钉：不许把非瞬时错误也咽了——耗尽／非瞬时都要 throw
    expect(body).toMatch(/throw e/)
    expect(body, '只认这三把瞬时锁').toContain("code === 'EPERM'")
    expect(body).toContain("code === 'EACCES'")
    expect(body).toContain("code === 'EBUSY'")
  })
})

describe('② 三个写点都只经 mutateConfigFile，体内不再各自 parse 整文件', () => {
  it.each(WRITERS)('%s 经唯一出口，且不自己 parse、不自己写', (name) => {
    const body = FN.get(name)
    expect(body, name + ' 不存在').toBeTruthy()
    const calls = calledNames(body ?? '')
    expect(calls, name + ' 必须经 mutateConfigFile').toContain('mutateConfigFile')
    expect(calls, name + ' 不许自己 parse 整文件').not.toContain('parse')
    expect(calls, name + ' 不许自己写文件').not.toContain('writeFileSync')
  })

  it('mutateConfigFile 的顺序＝先 load 再 save（少了 load 就退化成整文件覆盖）', () => {
    const calls = calledNames(FN.get('mutateConfigFile') ?? '')
    const iLoad = calls.indexOf('loadConfigForWrite')
    const iSave = calls.indexOf('saveConfigFile')
    expect(iLoad, '必须有 load（没有 load＝每次写都从头造一份文件）').toBeGreaterThanOrEqual(0)
    expect(iSave).toBeGreaterThanOrEqual(0)
    expect(iSave, 'save 必须在 load 之后').toBeGreaterThan(iLoad)
    expect(calls, '真正要落的那次改写还得真发生').toContain('mutate')
  })
})

describe('③ 坏文件不许被当空对象：留档、说话、拒写三件都在 loadConfigForWrite 里', () => {
  it('解析失败那一条路上：改名留档 + 那句"原文已留档"，且没有空 catch', () => {
    const body = FN.get('loadConfigForWrite') ?? ''
    expect(body).toContain('renameWithRetry(CONFIG_PATH, archive)')
    expect(body).toContain('原文已留档')
    expect(swallowsFailure(body), '解析失败这一支不许咽到底（后面必须真的留档）').toBe(false)
    expect(body).not.toContain('损坏则重建')
  })

  it('连文件内容都读不出时是 throw，不是 return 空对象（改前是 catch 之后当空对象）', () => {
    const body = FN.get('loadConfigForWrite') ?? ''
    const inner = catchBodyOf(body, 'catch (e) {')
    expect(inner, '第一道 catch 取不到').toBeTruthy()
    expect(inner, '读不出必须拒绝这次改写').toContain('throw new Error')
    expect(inner).toContain('本次不改写')
  })
})

describe('④ 三个读点都经 readConfigFile，三种事实分三档说话', () => {
  it.each(READERS)('%s 走共享入口且不自己 parse', (name) => {
    const calls = calledNames(FN.get(name) ?? '')
    expect(calls, name + ' 必须走 readConfigFile').toContain('readConfigFile')
    expect(calls, name + ' 不许自己 parse').not.toContain('parse')
  })

  it('readConfigFile 里三档各有一句：没文件静默返回、读不出 warn、解析失败 warn', () => {
    const body = FN.get('readConfigFile') ?? ''
    expect(body).toContain('if (!existsSync(CONFIG_PATH)) return null')
    expect(body).toContain('config.json 在，但读不出')
    expect(body).toContain('config.json 解析失败')
  })

  it('label 由调用方传进来（三把钥匙各有各的说法，共用一句会让两颗没牙）', () => {
    const labels: string[] = []
    for (const r of READERS) {
      const args = firstArgOf(FN.get(r) ?? '', 'readConfigFile')
      expect(args.length, r + ' 只该调一次共享入口').toBe(1)
      const label = args[0] ?? ''
      expect(label, r + ' 必须带自己的 label').toMatch(/^'.+'$/)
      labels.push(label)
    }
    expect(new Set(labels).size, '三个 label 必须两两不同').toBe(3)
    expect(WRITERS.length, '写点与读点成对').toBe(READERS.length)
  })
})

describe('⑤ 吞与不吞按各通道自己的契约钉死', () => {
  it.each(['writeSaltToConfigFile', 'writeKdfToConfigFile'])(
    '%s：回退副本仍在，所以可以不当失败抛，但 catch 里必须留痕（静默是改前的形状）',
    (name) => {
      const body = FN.get(name) ?? ''
      const inner = catchBodyOf(body, 'catch (e) {')
      expect(inner, name + ' 的 catch 取不到').toBeTruthy()
      expect(inner, name + ' 必须说一句').toContain('log.warn')
      expect(inner).toContain('写 config.json 失败')
    }
  )

  it('writeRecoveryBlobToConfigFile：恢复包没有第二份，catch 必须 throw 不许降级成 warn', () => {
    const body = FN.get('writeRecoveryBlobToConfigFile') ?? ''
    const inner = catchBodyOf(body, 'catch (e) {')
    expect(inner).toBeTruthy()
    expect(inner, '这一侧不许咽').toContain('throw new Error')
    expect(inner).toContain('恢复密钥写入 config.json 失败')
    expect(body).not.toContain('log.warn')
  })
})

describe('⑥ 漏杀对照：改前的三种形状喂进同一套读法，必须各报出来', () => {
  const OLD_SALT = [
    'function writeSaltToConfigFile(b64: string | null): void {',
    '  try {',
    '    let cfg: Record<string, unknown> = {}',
    '    if (existsSync(CONFIG_PATH)) {',
    '      try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) ?? {} } catch { /* 损坏则重建 */ }',
    '    }',
    '    if (b64 === null) delete cfg.masterPasswordSalt',
    '    else cfg.masterPasswordSalt = b64',
    '    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 })',
    '  } catch { /* 写失败不阻塞主流程：DB 内仍有备份 */ }',
    '}'
  ].join('\n')

  const OLD_READER = [
    'function readSaltFromConfigFile(): string | null {',
    '  try {',
    '    if (!existsSync(CONFIG_PATH)) return null',
    '    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))',
    '    return typeof cfg?.masterPasswordSalt === "string" ? cfg.masterPasswordSalt : null',
    '  } catch {',
    '    return null',
    '  }',
    '}'
  ].join('\n')

  it('改前写点：第一实参是 CONFIG_PATH、体内自己 parse、没有唯一出口、还带静默 catch ⇒ 四条都认得出', () => {
    const body = functions(OLD_SALT).get('writeSaltToConfigFile') ?? ''
    expect(firstArgOf(body, 'writeFileSync')).toEqual(['CONFIG_PATH'])
    expect(calledNames(body)).toContain('parse')
    expect(calledNames(body)).not.toContain('mutateConfigFile')
    expect(body).toContain('损坏则重建')
    expect(swallowsFailure(body), 'catch 里只有注释、后面也没人处理＝咽到底').toBe(true)
  })

  it('改前读点：没有 label、没有分档、解析失败与"没有这个键"混成一个 null', () => {
    const body = functions(OLD_READER).get('readSaltFromConfigFile') ?? ''
    expect(calledNames(body)).toContain('parse')
    expect(calledNames(body)).not.toContain('readConfigFile')
    expect(calledNames(body)).not.toContain('warn')
  })

  it('反向对照：现在的源码里这些形状一处都没有', () => {
    expect(SRC).not.toContain('损坏则重建')
    expect(firstArgOf(FN.get('writeSaltToConfigFile') ?? '', 'writeFileSync')).toEqual([])
    const swallows = [...FN.entries()].filter(([, b]) => swallowsFailure(b)).map(([n]) => n)
    expect(swallows.join(' | '), 'parse 失败被静默咽掉的函数').toBe('')
  })
})
