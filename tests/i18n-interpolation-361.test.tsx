// §361 i18n 插值的「调用点侧」——两条各自会漂的轴
//
// 轴一＝**值被当替换串**（`t()` 本体）：`str.replace(re, String(v))` 的第二参是字符串时，值里的
//   `$&`／`$'`／`` $` ``／`$$`／`$1` 会被当成「引用这份文案自己」的模式展开。参数值多数取自库外
//   （模型回文、导出路径、用户起的技能名、导入目录里的字段名），于是「删除技能「$&」？」这种名字
//   渲染成「删除技能「{name}」？」，`$'` 更把占位符右侧的整段文案搬进来再重复一遍。
//   这一面用真挂载的 `t()` 演：五种 `$` 形状各一条＋一颗正向对照（普通名字），期望值另用
//   `split/join` 手算，不借被测实现。
//
// 轴二＝**占位符与参数没对上**（调用点侧）：`i18n-parity` 只核「四本字典的 key 集合一致」，
//   `i18n-brace-and-takeover-331` 只核「双花括号不许带参」，都不看某一发调用到底把 `{e}` 填上没有。
//   §361 现数到的真缺陷就是这一发：`SettingsModule.tsx:1254` 把整句话 `bk.mergeFail`（'合并失败：{e}'）
//   当 `errText` 的兜底串用 ⇒ e 不是 Error／不是非空字符串时，屏上剩一颗没填的 `{e}`。
//   同一族的另一种写法是 `t(key).replace('{x}', …)` 手替：字符串型 replace 只换**第一处**，
//   所以字典里出现两次的占位符（`usage.exportCsvTruncated` 的 `{limit}`×2）会漏掉第二处。本批
//   把 7 处手替收干成 `t(key, params)`，并把「手替点数＝0」钉住。
//
// 分类器口径（两头钉）：占位符取**四语并集**；`{{x}}` 是提示词/变量标记的字面文本，不算占位符
//   （§331 那 14 颗键继续由反向钉守着，这里只断言它们不进并集）；第二参不是对象字面量／带展开
//   ⇒ 判不了，落进「动态」桶；第一参不是字符串字面量（`t(\`reminder.menu.${k}\`)`）同样判不了，
//   数量单独钉住，改动要人工对账。判不了的两桶在下面各有一条「漏杀对照」，证明分类器真能看见改前形状。
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import ts from 'typescript'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { useI18n } from '../src/renderer/src/i18n'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const ROOT = path.resolve(__dirname, '..')
/** 四本字典在本文件里当"数据"读，需要字符串索引（原文是逐键字面量类型） */
const asDict = (d: object): Record<string, string> => d as unknown as Record<string, string>
const ZH = asDict(zh)
const DICT: Record<string, Record<string, string>> = { zh: ZH, en: asDict(en), ja: asDict(ja), ko: asDict(ko) }
const LANGS = ['zh', 'en', 'ja', 'ko']
/** §331 钉住的双花括号模板标记键（提示词变量／占位样式），不是插值位 */
const TEMPLATE_KEYS = [
  'snippet.contentPh', 'snippet.hint',
  'ae.var.date', 'ae.var.time', 'ae.var.weekday', 'ae.var.user', 'ae.var.knowledge', 'ae.var.tools', 'ae.var.skills',
  'ae.kbLabel', 'ae.toolsLabel', 'ae.skillsLabel',
  'skill.usageHint', 'ccb.kbHint'
]

/** 字典值里的插值位：先把 `{{…}}` 折成哨兵，剩下的 `{标识符}` 才算占位符 */
function placeholdersOf(text: string): Set<string> {
  const stripped = text.replace(/\{\{[^}]*\}\}/g, '\u0000')
  const out = new Set<string>()
  for (const m of stripped.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g)) out.add(m[1]!)
  return out
}

/** 一把 key 在四语里要求填的位（并集：某一语多写一颗也要看得见） */
function needOf(key: string): Set<string> {
  const out = new Set<string>()
  for (const lang of LANGS) {
    const v = DICT[lang]?.[key]
    if (v !== undefined) for (const p of placeholdersOf(v)) out.add(p)
  }
  return out
}

interface Site {
  file: string
  line: number
  key: string
  /** 第二参是对象字面量时读出的键名 */
  params: string[]
  /** 第二参存在但读不出具体键名（变量／展开）⇒ 这一发判不了 */
  opaqueParams: boolean
}
interface Scan {
  sites: Site[]
  /** 第一参不是字符串字面量的 `t(...)`：判不了，单独数 */
  dynamicKey: Array<{ file: string; line: number }>
  /** `t(…).replace('{x}', …)` 手替点（链上每一环都数） */
  handReplace: Array<{ file: string; line: number; pattern: string }>
}

const lineOf = (sf: ts.SourceFile, pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1

/**
 * 一条 replace 链的最左端是谁。要连着穿「`.replace(…)` 这一环本身也是 CallExpression」，
 * 否则链式两环只数得到第一环（漏杀对照 ② 就是这条）。
 */
function chainRoot(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.text === 'replace') {
      cur = cur.expression.expression
      continue
    }
    return cur
  }
}
const isT = (expr: ts.Expression): boolean =>
  (ts.isIdentifier(expr) && expr.text === 't') ||
  (ts.isPropertyAccessExpression(expr) && expr.name.text === 't')

function scanSource(file: string, text: string): Scan {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: Scan = { sites: [], dynamicKey: [], handReplace: [] }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isT(node.expression)) {
      const a0 = node.arguments[0]
      const a1 = node.arguments[1]
      const params: string[] = []
      let opaqueParams = false
      if (a1) {
        if (ts.isObjectLiteralExpression(a1)) {
          for (const prop of a1.properties) {
            if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
              params.push(prop.name.text)
            } else if (ts.isShorthandPropertyAssignment(prop)) params.push(prop.name.text)
            else opaqueParams = true // 展开等读不出具体键名
          }
        } else opaqueParams = true
      }
      if (a0 && ts.isStringLiteral(a0)) {
        out.sites.push({ file, line: lineOf(sf, node.getStart(sf)), key: a0.text, params, opaqueParams })
      } else if (a0) {
        out.dynamicKey.push({ file, line: lineOf(sf, node.getStart(sf)) })
      }
    }
    // 手替：t(…).replace('{x}'|/\{x\}/, …)——链上每一环都数（`.parent` 在这里是 PropertyAccess，不是 Call，
    // 所以按「这一发 replace 的链最左端是不是 t(…)」判，而不是往上找父节点）
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'replace') {
      const root = chainRoot(node)
      if (ts.isCallExpression(root) && isT(root.expression)) {
        const key0 = root.arguments[0]
        if (key0 && ts.isStringLiteral(key0)) {
          const pat = node.arguments[0]
          const lit = pat && ts.isStringLiteral(pat) ? pat.text : pat && ts.isRegularExpressionLiteral(pat) ? pat.text : null
          if (lit !== null && /\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/.test(lit)) {
            out.handReplace.push({ file, line: lineOf(sf, node.getStart(sf)), pattern: lit })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 产品码全量语料：src 下所有 ts/tsx，四本字典自身除外（它们的值是数据，不是调用点） */
function scanCorpus(): Scan {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        walk(p)
      } else if (/\.(ts|tsx)$/.test(e.name) && !p.includes(`${path.sep}i18n${path.sep}`)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'src'))
  const merged: Scan = { sites: [], dynamicKey: [], handReplace: [] }
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    const one = scanSource(rel, fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
    merged.sites.push(...one.sites)
    merged.dynamicKey.push(...one.dynamicKey)
    merged.handReplace.push(...one.handReplace)
  }
  return merged
}

const CORPUS = scanCorpus()
const rel = (s: { file: string; line: number }): string => `${s.file}:${s.line}`
/** 该发的占位符没被参数填满 */
const unfilledOf = (site: Site): string[] => {
  const need = needOf(site.key)
  if (need.size === 0 || site.opaqueParams) return []
  return [...need].filter((p) => !site.params.includes(p))
}
/** 传了字典里根本不存在的参数名，或给没有占位符的键传参＝值白给 */
const extraOf = (site: Site): string[] => {
  if (site.opaqueParams) return []
  const need = needOf(site.key)
  if (need.size === 0) return site.params.length > 0 ? site.params : []
  return site.params.filter((p) => !need.has(p))
}
const placeholderKeys = Object.keys(zh).filter((k) => needOf(k).size > 0)
const coveredSites = CORPUS.sites.filter((s) => needOf(s.key).size > 0 && !s.opaqueParams)

describe('§361 轴一：t() 不许把插值当替换串（真挂载演 $ 家族）', () => {
  beforeEach(() => {
    localStorage.clear()
    stubPocketai()
  })

  const DEL = 'skill.deleteConfirm'
  const TRUNC = 'usage.exportCsvTruncated'

  /** 期望值另算：按位切开后原样拼回去，不经过被测实现，也不解释 $ */
  const join = (key: string, params: Record<string, string | number>): string => {
    let out = ZH[key] ?? ''
    for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v))
    return out
  }

  function Probe({ cases }: { cases: Array<{ slot: string; key: string; params?: Record<string, string | number> }> }): React.ReactElement {
    const { t } = useI18n()
    return (
      <div>
        {cases.map((c) => (
          <span key={c.slot} data-slot={c.slot}>
            {t(c.key, c.params)}
          </span>
        ))}
      </div>
    )
  }

  const CASES: Array<{ slot: string; key: string; params: Record<string, string | number> }> = [
    // 正向对照：普通名字要照原样进位——这条红了就说明整面没在数真东西
    { slot: 'plain', key: DEL, params: { name: '天气查询' } },
    { slot: 'amp', key: DEL, params: { name: '$&' } },
    { slot: 'after', key: DEL, params: { name: "$'" } },
    { slot: 'before', key: DEL, params: { name: '$`' } },
    { slot: 'dollar', key: DEL, params: { name: '$$' } },
    { slot: 'group', key: DEL, params: { name: '$1' } },
    // 同一颗占位符出现两次：非全局替换只填第一处（手替那一族的失效形状）
    { slot: 'twice', key: TRUNC, params: { limit: 500 } },
    // 数字参数仍要变成文本
    { slot: 'number', key: 'kb.evalRecall', params: { k: 3 } }
  ]

  it('zh 挂载下八发各落各的位（值原样、两处占位符都换、数字转文本）', () => {
    localStorage.setItem('pocketai.lang', 'zh')
    const { container } = mountWithProviders(<Probe cases={CASES} />)
    const at = (slot: string): string => container.querySelector(`[data-slot="${slot}"]`)?.textContent ?? ''
    // 门禁：先确认这一发真的渲染了东西（否则下面全在数空气）
    expect(at('plain')).toBe(join(DEL, { name: '天气查询' }))
    for (const c of CASES) {
      if (c.slot === 'plain') continue
      expect(at(c.slot), `${c.slot} 的成品句`).toBe(join(c.key, c.params!))
    }
    // 改前的三种形状逐个点名（$& 反吐占位符本身、$' 把右侧文案搬进来再说一遍、$$ 掉一个美元符）
    expect(at('amp')).not.toContain('{name}')
    expect(at('after').split('」？已关联的助手将不再注入该技能。').length - 1).toBe(1)
    expect(at('before').startsWith('删除技能「删除技能「')).toBe(false)
    expect(at('dollar')).toContain('$$')
    // 重复占位符：两处都得是 500，一颗不许留原样
    expect(at('twice')).toContain('记录超过 500 条，仅导出最近 500 条')
    expect(at('number')).toBe('recall@3')
  })

  it('没传参的那一发占位符原样留着——所以调用点侧必须由下面那面对账', () => {
    localStorage.setItem('pocketai.lang', 'zh')
    const { container } = mountWithProviders(<Probe cases={[{ slot: 'bare', key: 'bk.mergeFail' }]} />)
    expect(container.querySelector('[data-slot="bare"]')?.textContent).toBe('合并失败：{e}')
  })
})

describe('§361 轴二：调用点与字典占位符对账（源码级）', () => {
  it('读法自证：字典与站点都在预期量级（分类器坏了这里先红）', () => {
    expect(LANGS.every((l) => Object.keys(DICT[l] ?? {}).length === Object.keys(ZH).length), '四语键数一致').toBe(true)
    expect(placeholderKeys.length, `现数 ${placeholderKeys.length} 把带占位符的键`).toBeGreaterThanOrEqual(200)
    expect(CORPUS.sites.length, `现数 ${CORPUS.sites.length} 发字面量键调用点`).toBeGreaterThanOrEqual(3000)
    expect(coveredSites.length, `现数 ${coveredSites.length} 发带参且键确有占位符`).toBeGreaterThanOrEqual(300)
  })

  it('每一发带占位符的调用点都把占位符填满（改前 SettingsModule 那发兜底串是唯一的漏网）', () => {
    const bad = CORPUS.sites.flatMap((s) => unfilledOf(s).map((p) => `${rel(s)} ${s.key} 缺 {${p}}`))
    expect(bad, `没填满的调用点：\n${bad.join('\n')}`).toEqual([])
  })

  it('没有多传的参数名，也没有给无占位符的键传参（拼错的键名＝值白给）', () => {
    const bad = CORPUS.sites.flatMap((s) => extraOf(s).map((p) => `${rel(s)} ${s.key} 多 ${p}`))
    expect(bad, `对不上占位符的参数：\n${bad.join('\n')}`).toEqual([])
  })

  it('屏上文案不再手替：t(…).replace 归零（字符串型 replace 只换第一处，且绕开本面全部判据）', () => {
    expect(CORPUS.handReplace.map(rel), `手替点：\n${CORPUS.handReplace.map(rel).join('\n')}`).toEqual([])
  })

  it('双花括号那 14 颗模板键不进占位符并集，也没有一发带参（§331 口径的延伸）', () => {
    const withNeed = TEMPLATE_KEYS.filter((k) => needOf(k).size > 0)
    expect(withNeed, '这些模板标记键被当成了插值位').toEqual([])
    const parametrized = CORPUS.sites.filter((s) => TEMPLATE_KEYS.includes(s.key) && s.params.length > 0)
    expect(parametrized.map(rel), '模板标记键被带参调用＝渲染出半个字面大括号').toEqual([])
  })

  it('动态 key 调用点钉在 99 发：本面判不了它们，新增一发要人工对账后改这个数', () => {
    expect(CORPUS.dynamicKey.length, `现数 ${CORPUS.dynamicKey.length}：\n${CORPUS.dynamicKey.map(rel).join('\n')}`).toBe(99)
  })

  it('漏杀对照：改前三颗形状各自放回源码文本，分类器一一报出（不是空转）', () => {
    // ① 把整句话当兜底串（SettingsModule:1254 的改前形状）
    const bare = scanSource('fx1.tsx', `const x = errText(e, t('bk.mergeFail'))\n`)
    expect(bare.sites.length).toBe(1)
    expect(unfilledOf(bare.sites[0]!), '改前那发要报「缺 {e}」').toEqual(['e'])
    // ② 手替：链式两环都要报（KbEvalPanel:121 的改前形状）
    const hand = scanSource('fx2.tsx', `const y = t('kb.evalCases').replace('{n}', String(m.cases)).replace('{ms}', String(ms))\n`)
    expect(hand.handReplace.length, '链式手替只数到一环＝链没走全').toBe(2)
    // ③ 参数名拼错 ⇒ 多传与缺填同时报
    const typo = scanSource('fx3.tsx', `const z = t('skill.deleteConfirm', { nmae: s.name })\n`)
    expect(extraOf(typo.sites[0]!)).toEqual(['nmae'])
    expect(unfilledOf(typo.sites[0]!)).toEqual(['name'])
    // ④ 判不了的两桶：变量参数／模板拼 key，各进各的桶而不是被当成"过"
    const opaque = scanSource('fx4.tsx', `const w = t('bk.mergeFail', params)\n`)
    expect(opaque.sites[0]!.opaqueParams).toBe(true)
    expect(unfilledOf(opaque.sites[0]!)).toEqual([])
    const tpl = scanSource('fx5.tsx', 'const v = t(`reminder.menu.${k}`)\n')
    expect(tpl.dynamicKey.length).toBe(1)
  })
})
