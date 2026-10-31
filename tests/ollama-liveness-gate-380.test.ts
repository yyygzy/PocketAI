// V4-Iter-380 闸门：11434 探测的三态不许在任何一屏上折回两态
//
// 起点＝缺陷 hunt 候选 #6。回读发现同一把谎有**两处独立探针**、六个可见面：
//   探针①`main/ollama/ollama-runtime.ts`（`/api/version`）→ 面板来源徽标／安装引导／停止键／模型清单
//   探针②`main/steward/model-recommend.ts`（`/api/tags`）→ 管家徽标＋`no_ollama` 那句告警
// 本闸门守六件事：
//   A 契约：三态类型齐全，两处契约里都不许再留布尔 `running`
//   B 「未运行／Stopped」这一句只许在 `down` 那一支出场；「无法确认／Unknown」只在排除了 up 与 down 之后出场
//   C 模型清单那圈必须先判 `up` 再读（`[]` 在非 up 那一支是"没去取"，不是"取到的是空的"）
//   D 两处探针共用同一份分类判据（一份判据、两处都用，不许修一面留一面）
//   E 面板那句的秒数与探针常量同源（字典只写占位符、数字由调用点带出——§379 那族跨层手抄）
//   F 读法自证：改前那几形喂进同一套读法，必须被认成"没绑态"
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import { OLLAMA_PROBE_TIMEOUT_MS } from '../src/shared/ollama-probe'

/** 读的是代码形状：注释里出现的字样（包括本批写下的"改前是 running:…"）一律先剥掉 */
function stripComments(src: string): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  return out
    .split('\n')
    .map((line) => {
      let inS: string | null = null
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (inS) {
          if (c === '\\') i++
          else if (c === inS) inS = null
          continue
        }
        if (c === '"' || c === "'" || c === '`') inS = c
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

const read = (rel: string): string =>
  stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf-8').replace(/\r\n/g, '\n'))

const RUNTIME = read('main/ollama/ollama-runtime.ts')
const RECOMMEND = read('main/steward/model-recommend.ts')
const PANEL = read('renderer/src/components/OllamaPanel.tsx')
const STEWARD = read('renderer/src/modules/steward/StewardModule.tsx')
const REPORT = read('renderer/src/utils/diagnostic-report.ts')
const PULLHOOK = read('renderer/src/hooks/useOllamaPull.ts')
const TYPES = read('shared/types.ts')
const CODES = read('shared/model-rec-codes.ts')
const PROBE = read('shared/ollama-probe.ts')

const sf = (name: string, src: string): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/**
 * 找出源码里文本恰好等于 `exact` 的那些节点（取最小那一层，不取包住它的更大同文本节点），
 * 返回"包住它们的条件文本"清单。三种落法都要认（§345/§352 数过的三种）：
 *   `if (cond) {…}`／`cond ? a : b`／`cond && (<JSX/>)`
 *
 * `jsxOnly`：只看**真的会渲染上屏**的那些出现。管家页的报表标签是 `ollamaStopped: t('steward.ollamaStopped')`
 * 这种查表写法（它不决定哪张脸上屏，决定在 `diagnostic-report.ts` 那一侧，由 B3 钉），
 * 它自己没有任何条件——把它算进"每处都要绑"会让判据恒假。
 */
function guardingConditions(src: string, fileName: string, exact: string, jsxOnly = false): string[][] {
  const file = sf(fileName, src)
  const leaves: ts.Node[] = []
  walk(file, (n) => {
    if (n.getText(file) !== exact) return
    let childSame = false
    n.forEachChild((c) => {
      if (c.getText(file) === exact) childSame = true
    })
    if (childSame) return
    if (jsxOnly) {
      let inJsx = false
      let p: ts.Node | undefined = n.parent
      while (p) {
        if (ts.isJsxElement(p) || ts.isJsxFragment(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxText(p)) inJsx = true
        p = p.parent
      }
      if (!inJsx) return
    }
    leaves.push(n)
  })
  return leaves.map((leaf) => {
    const conds: string[] = []
    let cur: ts.Node | undefined = leaf.parent
    while (cur) {
      if (ts.isIfStatement(cur)) conds.push(cur.expression.getText(file))
      if (ts.isConditionalExpression(cur)) conds.push(cur.condition.getText(file))
      if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        conds.push(cur.left.getText(file))
      }
      cur = cur.parent
    }
    return conds
  })
}

/** 每一处出现都被"某个条件里含 needle 串"包住才算绑住（一处没绑＝那一屏还在折档） */
const boundTo = (conds: string[][], ...needles: string[]): boolean =>
  conds.length > 0 && conds.every((chain) => needles.every((n) => chain.some((c) => c.includes(n))))

/** 成对的另一头：出现次数也要数（新增一处"无条件渲染"会把这条撞红，而不是悄悄溜过） */
const countOf = (src: string, needle: string): number => src.split(needle).length - 1

// ───────────────────────────── A 契约 ─────────────────────────────
describe('A 契约面：三态类型与两处字段', () => {
  it('OllamaLiveness 正好三档（up／down／unknown）', () => {
    const file = sf('types.ts', TYPES)
    let hit: ts.TypeAliasDeclaration | undefined
    walk(file, (n) => {
      if (ts.isTypeAliasDeclaration(n) && n.name.text === 'OllamaLiveness') hit = n
    })
    expect(hit, '读法失效：找不到 OllamaLiveness（改名了要人工过目）').toBeTruthy()
    const members = hit!
      .type.getText(file)
      .split('|')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .sort()
    expect(members).toEqual(['down', 'unknown', 'up'])
  })

  it('OllamaRuntimeStatus 有 liveness、没有 running；ModelRecommendation 有 ollamaLiveness、没有 ollamaRunning', () => {
    const file = sf('types.ts', TYPES)
    const membersOf = (iface: string): string[] => {
      let names: string[] = []
      walk(file, (n) => {
        if (ts.isInterfaceDeclaration(n) && n.name.text === iface) {
          names = n.members.filter(ts.isPropertySignature).map((m) => m.name?.getText(file) ?? '')
        }
      })
      return names
    }
    const status = membersOf('OllamaRuntimeStatus')
    expect(status).toContain('liveness')
    expect(status).not.toContain('running')
    const rec = membersOf('ModelRecommendation')
    expect(rec).toContain('ollamaLiveness')
    expect(rec).not.toContain('ollamaRunning')
  })

  it('反向对照：上面那两条不是恒真——改前那两形喂进同一套读法，running 会被读出来', () => {
    const BEFORE =
      'export interface OllamaRuntimeStatus { installed: boolean; running: boolean; models: string[] }\n' +
      'export interface ModelRecommendation { ollamaRunning: boolean; installedModels: string[] }\n'
    const file = sf('before.ts', BEFORE)
    const membersOf = (iface: string): string[] => {
      let names: string[] = []
      walk(file, (n) => {
        if (ts.isInterfaceDeclaration(n) && n.name.text === iface) {
          names = n.members.filter(ts.isPropertySignature).map((m) => m.name?.getText(file) ?? '')
        }
      })
      return names
    }
    expect(membersOf('OllamaRuntimeStatus')).toContain('running')
    expect(membersOf('ModelRecommendation')).toContain('ollamaRunning')
  })
})

// ───────────────────────────── B 每句话绑哪一态 ─────────────────────────────
describe('B 面：「未运行」只许 down，「无法确认」只在排除 up 与 down 之后出场', () => {
  it('B1 管家徽标那句「○ 未运行」：JSX 里每一处出场都绑 === \'down\'，且总出现次数还是那两处', () => {
    expect(boundTo(guardingConditions(STEWARD, 'StewardModule.tsx', "'steward.ollamaStopped'", true), "=== 'down'")).toBe(true)
    expect(countOf(STEWARD, "'steward.ollamaStopped'"), '徽标一处＋报表标签一处，多一处＝有人新增了没绑态的渲染点').toBe(2)
  })

  it('B2 管家徽标那句「? 状态未知」要同时排除 up 与 down（不许借用 stopped 那一支）', () => {
    expect(
      boundTo(guardingConditions(STEWARD, 'StewardModule.tsx', "'steward.ollamaUnknown'", true), "=== 'up'", "=== 'down'")
    ).toBe(true)
    expect(countOf(STEWARD, "'steward.ollamaUnknown'")).toBe(2)
  })

  it('B3 诊断报告里 Stopped 绑 down、Unknown 只在排除 up 与 down 之后出场（报告也是同一把尺子）', () => {
    expect(boundTo(guardingConditions(REPORT, 'diagnostic-report.ts', 'L.ollamaStopped'), "=== 'down'")).toBe(true)
    expect(boundTo(guardingConditions(REPORT, 'diagnostic-report.ts', 'L.ollamaUnknown'), "=== 'up'", "=== 'down'")).toBe(true)
  })

  it('B4 面板那句「无法确认」的渲染条件里有 === \'unknown\'（&& 那一形也要认）', () => {
    const conds = guardingConditions(PANEL, 'OllamaPanel.tsx', "'ollama.probeUnknown'", true)
    expect(conds.length, '读法失效：面板不再渲染那句').toBe(1)
    expect(boundTo(conds, "=== 'unknown'")).toBe(true)
  })

  it('B5 管家那条 no_ollama 告警只在 liveness === \'down\' 的判断里推，unknown 那一档另有出口', () => {
    const file = sf('model-recommend.ts', RECOMMEND)
    const pushIf = (code: string): string | undefined => {
      let hit: string | undefined
      walk(file, (n) => {
        if (!ts.isIfStatement(n)) return
        if (!n.thenStatement.getText(file).includes(`'${code}'`)) return
        if (!n.expression.getText(file).includes('ollama.liveness')) return
        hit = n.expression.getText(file)
      })
      return hit
    }
    expect(pushIf('no_ollama'), '推 no_ollama 的那句不在"判 liveness"的 if 里＝又折回一肩挑').toContain("=== 'down'")
    expect(pushIf('ollama_unknown'), 'unknown 那一档没有出口＝谎又回来了').toContain("=== 'unknown'")
  })

  it('B6 pullState 那格判的是 !== \'up\'（探测没成功也点不动，但不替界面下"没在跑"的结论）', () => {
    expect(boundTo(guardingConditions(PULLHOOK, 'useOllamaPull.ts', "args.ollamaLiveness !== 'up'"), "!== 'up'")).toBe(true)
  })
})

// ───────────────────────────── C 清单与来源必须先答上话 ─────────────────────────────
describe('C 面：models／source／version 在非 up 那一支不许被当数据读', () => {
  it('C1 面板里每一处读 status.models 都被 liveness === \'up\' 包着', () => {
    const conds = guardingConditions(PANEL, 'OllamaPanel.tsx', 'status.models')
    expect(conds.length, '读法失效：面板一处都不读 status.models 了').toBeGreaterThan(0)
    expect(boundTo(conds, "liveness === 'up'")).toBe(true)
  })

  it('C2 主进程只在 up 那一支才去发 /api/tags 那一发', () => {
    const file = sf('ollama-runtime.ts', RUNTIME)
    let cond: string | undefined
    walk(file, (n) => {
      if (!ts.isVariableDeclaration(n) || n.name.getText(file) !== 'models') return
      const init = n.initializer
      if (init && ts.isConditionalExpression(init)) cond = init.condition.getText(file)
    })
    expect(cond, '读法失效：models 不再是三元取法').toContain("liveness === 'up'")
  })

  it('C3 getStatus 里按 up 分档的地方不止一处（清单、来源各一处以上）', () => {
    const file = sf('ollama-runtime.ts', RUNTIME)
    let hits = 0
    walk(file, (n) => {
      if (ts.isConditionalExpression(n) && n.condition.getText(file).includes("liveness === 'up'")) hits++
    })
    expect(hits, '非 up 那一支没有各自的出口＝又折成一档了').toBeGreaterThanOrEqual(2)
  })
})

// ───────────────────────────── D 两处探针同源 ─────────────────────────────
describe('D 面：分类判据只有一份', () => {
  for (const [name, src] of [
    ['ollama-runtime.ts', RUNTIME],
    ['model-recommend.ts', RECOMMEND]
  ] as const) {
    it(`${name} import 了共享的 classifyProbeFailure，且 catch 那一支用的是它`, () => {
      const file = sf(name, src)
      let imported = false
      walk(file, (n) => {
        if (!ts.isImportDeclaration(n)) return
        if (!n.moduleSpecifier.getText(file).includes('shared/ollama-probe')) return
        if (n.importClause?.getText(file).includes('classifyProbeFailure')) imported = true
      })
      expect(imported, '没有从 shared/ollama-probe 引进分类判据＝两处又各写一套').toBe(true)

      const usedInCatch = [...src.matchAll(/catch\s*\(([^)]*)\)[\s\S]{0,160}?\}/g)].some((m) =>
        m[0].includes('classifyProbeFailure')
      )
      expect(usedInCatch, 'catch 里没把抛出的东西交给 classifyProbeFailure（又写成 return null／running:false）').toBe(true)
    })
  }

  it('反向钉：src 里不再有第二个探测超时常量，也不再有 `running: true|false` 这种把探测折成一档的写法', () => {
    const all = [RUNTIME, RECOMMEND].join('\n')
    expect(all).not.toMatch(/OLLAMA_API_TIMEOUT_MS/)
    expect(all).not.toMatch(/\brunning:\s*(true|false)/)
    expect(CODES).toMatch(/ollama_unknown/)
  })

  it('分类判据本体：down 只认两把"没人接"的码，其余一律 unknown', () => {
    expect(PROBE).toMatch(/ECONNREFUSED/)
    expect(PROBE).toMatch(/EADDRNOTAVAIL/)
    // 不许悄悄扩名单：把 ECONNRESET／ETIMEDOUT 这类"连接中断"也当成否定证据
    expect(PROBE).not.toMatch(/ECONNRESET|ETIMEDOUT|ENOTFOUND/)
  })
})

// ───────────────────────────── E 数字同源 ─────────────────────────────
describe('E 面：面板那句的秒数与探针常量同源', () => {
  const DICTS = { zh, en, ja, ko } as const

  it('四本字典的 ollama.probeUnknown 都带 {seconds}，且取值里不许出现裸数字（数字只住常量那一份）', () => {
    for (const lang of Object.keys(DICTS) as Array<keyof typeof DICTS>) {
      const v = (DICTS[lang] as Record<string, string>)['ollama.probeUnknown'] ?? ''
      expect(v, `${lang} 缺 ollama.probeUnknown`).not.toBe('')
      expect(v, `${lang} 那句没有 {seconds} 占位符`).toContain('{seconds}')
      const digits = v.replace(/\{seconds\}/g, '').match(/\d+/g)
      expect(digits, `${lang} 那句里手抄了数字：${digits?.join(', ')}`).toBeNull()
    }
  })

  it('调用点把 params 交给 t()，键名逐字是 seconds；且没在手替（.replace 顶掉插值＝§361 那一族）', () => {
    const file = sf('OllamaPanel.tsx', PANEL)
    let ok = false
    walk(file, (n) => {
      if (!ts.isCallExpression(n)) return
      const args = n.arguments
      if (args.length !== 2) return
      const first = args[0]
      if (!first || !ts.isStringLiteral(first) || first.text !== 'ollama.probeUnknown') return
      const second = args[1]
      if (!second || !ts.isObjectLiteralExpression(second)) return
      const prop = second.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'seconds')
      if (prop && prop.initializer.getText(file).includes('OLLAMA_PROBE_TIMEOUT_MS')) ok = true
    })
    expect(ok, '面板那句没把秒数从共享常量带给 t()').toBe(true)
    expect(PANEL).not.toMatch(/t\(\s*['"]ollama\.probeUnknown['"][^)]*\)\s*\.replace\(/)
  })

  it('常量确实是 3000（界面上报 3 秒），且全仓只有 shared 定义那一处', () => {
    expect(OLLAMA_PROBE_TIMEOUT_MS).toBe(3000)
    const defines = [RUNTIME, RECOMMEND, PROBE, PANEL].filter((s) => /OLLAMA_PROBE_TIMEOUT_MS\s*=/.test(s))
    expect(defines.length, '常量被抄成了两份＝迟早漂').toBe(1)
  })
})

// ───────────────────────────── F 读法自证 ─────────────────────────────
describe('F 读法自证：改前那几形喂进同一套读法，必须被认成"没绑态"', () => {
  const BADGE_BEFORE =
    "const x = (rec: any): string => (rec.ollamaRunning ? t('steward.ollamaRunning') : t('steward.ollamaStopped'))\n"
  it('改前的徽标那一形：条件里根本没有 \'down\' ⇒ B1 的判据对它返回 false（有牙）', () => {
    const conds = guardingConditions(BADGE_BEFORE, 'badge-before.tsx', "'steward.ollamaStopped'")
    expect(conds.length).toBe(1)
    expect(boundTo(conds, "=== 'down'")).toBe(false)
    expect(conds[0]?.[0] ?? '').toContain('ollamaRunning')
  })

  const PUSH_BEFORE =
    'async function recommendModels() {\n' +
    '  const ollama = { running: false, models: [] as string[] }\n' +
    '  const warnings: string[] = []\n' +
    "  if (!ollama.running) warnings.push('no_ollama')\n" +
    '  return warnings\n' +
    '}\n'
  it('改前那句一肩挑的告警：条件里没有 `ollama.liveness` ⇒ B5 的取法读不到它（＝旧写法今天过不了关，必须换掉）', () => {
    const file = sf('push-before.ts', PUSH_BEFORE)
    let hit: string | undefined
    walk(file, (n) => {
      if (!ts.isIfStatement(n)) return
      if (!n.thenStatement.getText(file).includes("'no_ollama'")) return
      if (!n.expression.getText(file).includes('ollama.liveness')) return
      hit = n.expression.getText(file)
    })
    expect(hit, '读法把改前那一形也认成"已绑态"＝B5 是空的').toBeUndefined()
  })

  it('stripComments 认 URL 里的 //（引号内不算注释），也认行尾注释——闸门扫的是代码不是注释', () => {
    const probe = "const u = 'http://x/y' // 这里写着 liveness === 'down' 的假样\nconst v = 'x'\n"
    const stripped = stripComments(probe)
    expect(stripped).toContain('http://x/y')
    expect(stripped).not.toContain('假样')
  })

  it('`cond && (<JSX/>)` 这一形也算条件（B4/C1 靠它，否则两处都是空判据）', () => {
    const src = "if (true) { const a = s?.liveness === 'unknown' && (<div>{'ollama.probeUnknown'}</div>) }\n"
    const conds = guardingConditions(src, 'and-form.tsx', "'ollama.probeUnknown'")
    expect(conds.length).toBe(1)
    expect(boundTo(conds, "=== 'unknown'")).toBe(true)
  })
})
