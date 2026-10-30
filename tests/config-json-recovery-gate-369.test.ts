// V4-Iter-369 的常驻闸门：坏文件里"按字段扫恢复包"这根松口子，只许开在唯一没有第二份的那把钥匙上
//
// 行为面在 tests/config-json-recovery-carry-369.test.ts（写路径带上／读路径当场扫／截断不接／
// 主动删除不复活／标记与包成对）。这里盯的是**形状**，因为这一族的失效方式全是"以后有人顺手把它 widened"：
//  · 松口子扩到 salt／档位（那两把各有 DB 回退副本，把未校验的字节当权威＝净倒退）；
//  · 改成扫留档目录（目录里那份可能是用户主动删包之前留下的＝替他复活他删掉的东西）；
//  · 写路径只留档不带包（回到 §367 那句"请从留档取回"＝没有取回的脚）；
//  · 用户重新生成后那句"取回"的话还挂着（来源标记与包不成对）；
//  · 通道形状回退成布尔＝屏上那句没有料可读。
// 一律用字符扫描／AST，不用含斜杠的正则（§367 撞过一次：`(//…)` 会让词法器在正则里看到"注释"）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const P = (...parts: string[]): string => path.join(process.cwd(), ...parts)
const REPO = P('src', 'main', 'db', 'repositories', 'app-config.repo.ts')
const MANAGER = P('src', 'main', 'crypto', 'recovery-key.ts')
const HANDLER = P('src', 'main', 'ipc', 'handlers', 'encryption.ts')
const PRELOAD = P('src', 'preload', 'index.ts')
const SETTINGS = P('src', 'renderer', 'src', 'modules', 'settings', 'SettingsModule.tsx')

const REPO_SRC = readFileSync(REPO, 'utf8')
const MANAGER_SRC = readFileSync(MANAGER, 'utf8')
const HANDLER_SRC = readFileSync(HANDLER, 'utf8')
const PRELOAD_SRC = readFileSync(PRELOAD, 'utf8')
const SETTINGS_SRC = readFileSync(SETTINGS, 'utf8')

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

/** 调用点名：`foo(` 取 foo，`a.b(` 取 b */
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

/** 数一个标识符在一段文本里出现几次（带词边界，中文相邻也算边界） */
function countOf(hay: string, needle: string): number {
  let n = 0
  let i = 0
  for (;;) {
    const j = hay.indexOf(needle, i)
    if (j < 0) return n
    n++
    i = j + needle.length
  }
}

const FN = functions(REPO_SRC)
/** 恢复包这一把的"专用通道"三个名字 */
const SALVAGE = 'salvageRecoveryFromUnparseableFile'
const EXTRACT = 'extractRecoveryBlob'

describe('读法自证：分类器看得见这份源码里的这些函数与调用点', () => {
  it('三根新机关的体都取得到（取不到＝下面所有判定都在数空气）', () => {
    for (const name of [EXTRACT, SALVAGE, 'readRecoveryFromConfigFile']) {
      const body = FN.get(name)
      expect(body, name + ' 取不到').toBeTruthy()
      expect((body ?? '').length, name + ' 体不该是空的').toBeGreaterThan(20)
    }
  })

  it('调用点取法有牙：拿已知的一份 fixture 算出 1、另一份算出 0', () => {
    expect(calledNames('function a(){ ' + EXTRACT + '(raw); return 1 }').includes(EXTRACT)).toBe(true)
    expect(calledNames('function a(){ return readConfigFile("x") }').includes(EXTRACT)).toBe(false)
    expect(countOf('readdirSync(a)\nreaddirSync(b)', 'readdirSync(')).toBe(2)
    expect(countOf('const x = 1', 'readdirSync(')).toBe(0)
  })

  it('五份源文件各就各位（拿不到文件名＝读法漂了）', () => {
    expect(REPO_SRC).toContain('function loadConfigForWrite')
    expect(MANAGER_SRC).toContain('recoveryStatus()')
    expect(HANDLER_SRC).toContain('IPC.ENCRYPTION_HAS_RECOVERY')
    expect(PRELOAD_SRC).toContain('hasRecoveryKey:')
    expect(SETTINGS_SRC).toContain('export const RecoveryKeyCard')
  })
})

describe('① 松口子只开在一把钥匙上', () => {
  it.each(['readSaltFromConfigFile', 'readKdfFromConfigFile'])(
    '%s 体内不许出现按字段扫／当场救（那两把各有 DB 回退副本，未校验的字节不当权威）',
    (name) => {
      const calls = calledNames(FN.get(name) ?? '')
      expect(calls, name + ' 不该扫坏文件').not.toContain(EXTRACT)
      expect(calls, name + ' 不该当场救').not.toContain(SALVAGE)
    }
  )

  it('扫的锚点只认 `rv1:` 那一段（去掉前缀＝任何残留字符串都会被当包接回）', () => {
    const body = FN.get(EXTRACT) ?? ''
    expect(body).toContain('rv1:')
    expect(body).toContain('recoveryBlob')
  })

  it('恢复包这一把的读点确实只挂了一处当场救', () => {
    const calls = calledNames(FN.get('readRecoveryFromConfigFile') ?? '')
    expect(calls.filter((c) => c === SALVAGE).length).toBe(1)
  })

  it('整个模块里 readdirSync／statSync 一处都没有＝不做留档目录扫描（删掉的东西不许被顶回来）', () => {
    expect(countOf(REPO_SRC, 'readdirSync'), '有人加回了目录扫描').toBe(0)
    expect(countOf(REPO_SRC, 'statSync'), '按 mtime 挑留档＝同一件事的另一根入口').toBe(0)
  })
})

describe('② 搬走坏文件那一发必须真把包带上', () => {
  it('loadConfigForWrite 里四件齐：改名留档＋按字段扫＋那句"原文已留档"＋带回来的那一句赋值', () => {
    const body = FN.get('loadConfigForWrite') ?? ''
    expect(body).toContain('renameSync(CONFIG_PATH, archive)')
    expect(body).toContain('原文已留档')
    const calls = calledNames(body)
    expect(calls, '留档那一支要真的扫一次').toContain(EXTRACT)
    expect(body, '带回来的时候必须同时记下来源').toContain('recoveryCarriedFrom')
    expect(body).toContain(EXTRACT + '(raw)')
  })

  it('漏杀对照：改前那一支（留档完直接 return 空对象）在这套读法下要被认出来是"没带包"', () => {
    const OLD = `function loadConfigForWrite(): Record<string, unknown> {
  const archive = CONFIG_PATH + '.corrupt-' + Date.now()
  renameSync(CONFIG_PATH, archive)
  log.warn('原文已留档')
  return {}
}`
    const body = functions(OLD).get('loadConfigForWrite') ?? ''
    expect(body).toContain('原文已留档')
    expect(calledNames(body), '旧形状留了档但没扫＝正是本批要认出的那一发').not.toContain(EXTRACT)
    expect(body).not.toContain('recoveryCarriedFrom')
  })
})

describe('③ 来源标记与那把包成对，谁写谁负责清', () => {
  it('读侧：carriedFrom 只在包存在时才给（有标记没包＝没有主语的话）', () => {
    const body = FN.get('readRecoveryFromConfigFile') ?? ''
    expect(body, '要按 blob 的有无来给来源').toContain('carriedFrom: blob ? carried : null')
  })

  it('写侧：用户自己写这一把（生成或删除）都要把"取回"那句清掉', () => {
    const body = FN.get('writeRecoveryBlobToConfigFile') ?? ''
    expect(body).toContain('delete cfg.recoveryCarriedFrom')
  })

  it.each(['writeSaltToConfigFile', 'writeKdfToConfigFile'])(
    '%s 不许碰那把包的来源标记（互抹＝一句话莫名消失）',
    (name) => {
      expect(FN.get(name) ?? '', name + ' 里出现了 recoveryCarriedFrom').not.toContain('recoveryCarriedFrom')
    }
  )
})

describe('④ 通道三头：这一发回来的是两件事，不是一件事', () => {
  it('主进程入口读的是 recoveryStatus（回到 hasRecovery＝通道没有来源可读）', () => {
    const i = HANDLER_SRC.indexOf('IPC.ENCRYPTION_HAS_RECOVERY')
    expect(i).toBeGreaterThanOrEqual(0)
    const near = HANDLER_SRC.slice(i, i + 200)
    expect(near).toContain('recoveryStatus()')
    expect(near, '旧形状：只回一个布尔').not.toContain('hasRecovery()')
  })

  it('preload 声明的是 { has; carriedFrom } 的形状（回退成 Promise<boolean> 就只有一个人能知道有档）', () => {
    const i = PRELOAD_SRC.indexOf('hasRecoveryKey:')
    expect(i).toBeGreaterThanOrEqual(0)
    const decl = PRELOAD_SRC.slice(i, PRELOAD_SRC.indexOf('=>', i))
    expect(decl).toContain('has: boolean')
    expect(decl).toContain('carriedFrom: string | null')
  })

  it('渲染层两个字段各读各的，且那句话要两件事都在才画', () => {
    expect(SETTINGS_SRC).toContain('setHasKey(v.has)')
    expect(SETTINGS_SRC).toContain('setCarriedFrom(v.carriedFrom)')
    expect(SETTINGS_SRC).toContain('hasKey && carriedFrom')
  })

  it('那句话的调用点把 file 传上了（§361 那一族：占位符在字典里、调用点没给值）', () => {
    const i = SETTINGS_SRC.indexOf("t('enc.recoveryCarried'")
    expect(i, '渲染层没人调用这句').toBeGreaterThanOrEqual(0)
    expect(SETTINGS_SRC.slice(i, i + 80)).toContain('file:')
  })

  it('四语字典都有这一句，且都带着 {file} 占位符', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const src = readFileSync(P('src', 'renderer', 'src', 'i18n', `${lang}.ts`), 'utf8')
      const i = src.indexOf("'enc.recoveryCarried'")
      expect(i, lang + ' 缺这一句').toBeGreaterThanOrEqual(0)
      const line = src.slice(i, src.indexOf('\n', i))
      expect(line, lang + ' 这一句没有占位符').toContain('{file}')
      expect(countOf(src, "'enc.recoveryCarried'"), lang + ' 同一句写了两遍（重复键＝后者悄悄覆盖）').toBe(1)
    }
  })
})
