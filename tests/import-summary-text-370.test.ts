// V4-Iter-370：渲染层那份 helper 把码与计数翻成四语实话——用**真字典**逐条渲染
//
// 为什么单独立一份而不是挂 ChatModule：全仓没有挂载 ChatModule 的用例（代价不成比例，§253 起就判过），
// 而这两句的风险全在"字符串怎么拼"上：占位符没填（§361 那一族）、明细把零的那类也说一遍、
// 一个都没丢时画一句"0 条"、认不出的码把 `IMPORT_XXX` 原样贴给用户（§243 真撞过一次）。
//
// 这里的 `mkT` 逐句镜像 `src/renderer/src/i18n/index.tsx` 里 provider 的 t()（第二参给函数、/g 全局替换）；
// 镜像会不会漂由 `tests/import-warning-shape-370.test.ts` 的 G5 钉住（那边的 t 仍是函数替换＋全局）。
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import { IMPORT_WARNING_KEYS, importDroppedText, importWarningText } from '../src/renderer/src/utils/import-summary'
import type { ExternalDroppedMessages, ExternalWarning, ExternalWarningCode } from '../src/shared/conversation-import-external'

const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS
const LANGS = Object.keys(DICTS) as Lang[]

function mkT(lang: Lang): (key: string, params?: Record<string, string | number>) => string {
  const dict = DICTS[lang]
  return (key, params) => {
    let str = (dict as Record<string, string>)[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v))
    }
    return str
  }
}

const ALL_CODES = Object.keys(IMPORT_WARNING_KEYS) as ExternalWarningCode[]

describe('导入告警的码 → 四语句子', () => {
  it('H1 六个码在四语都渲染得出句子：非空、不含裸码、不含没填的占位符', () => {
    for (const lang of LANGS) {
      const t = mkT(lang)
      for (const code of ALL_CODES) {
        const w: ExternalWarning = { code, args: { max: 1000, err: 'SQLITE_FULL' } }
        const s = importWarningText(w, t)
        expect(s.length, `${lang}/${code} 空句`).toBeGreaterThan(3)
        expect(s, `${lang}/${code} 漏了裸码`).not.toMatch(/IMPORT_[A-Z_]+/)
        expect(s, `${lang}/${code} 占位符没填`).not.toMatch(/\{[a-z]+\}/)
      }
    }
  })

  it('H2 带出处时两句都在，且间隔符取自字典（不在代码里硬写「：」）', () => {
    for (const lang of LANGS) {
      const t = mkT(lang)
      const one = t(IMPORT_WARNING_KEYS.IMPORT_NOT_ARRAY)
      const withWhere = importWarningText({ code: 'IMPORT_NOT_ARRAY', where: 'conversations.json' }, t)
      expect(withWhere).toContain('conversations.json')
      expect(withWhere).toContain(one)
      // 句式模板里除了这两段不该再多塞别的内容：长度＝两处内容＋模板本身去掉两个槽后的固定字符
      const template = t('chat.importExternalWarnWhere')
      expect(withWhere.length).toBe(one.length + 'conversations.json'.length + (template.length - '{where}'.length - '{text}'.length))
    }
  })

  it('H3 明细只列非零那几类：一类非零时其余三句都不许出现', () => {
    for (const lang of LANGS) {
      const t = mkT(lang)
      const dropped: ExternalDroppedMessages = { badJson: 3, notEvent: 0, nonText: 0, emptyText: 0 }
      const s = importDroppedText(dropped, t)!
      expect(s).toContain(t('chat.importExternalDropBadJson', { n: 3 }))
      for (const k of ['chat.importExternalDropNotEvent', 'chat.importExternalDropNonText', 'chat.importExternalDropEmptyText'] as const) {
        // 取"不带数字的那半截"来判在场与否：整串带 {n}＝1 时也可能与别的类同字
        const label = t(k, { n: 987654 })
        expect(s, `${lang} 把零的那类 ${k} 也说了一遍`).not.toContain(label)
      }
      expect(s).toContain('3')
    }
  })

  it('H4 四类各有一发时：总数是四者之和（1＋2＋3＋4＝10），四类标签都在场', () => {
    for (const lang of LANGS) {
      const t = mkT(lang)
      const s = importDroppedText({ badJson: 1, notEvent: 2, nonText: 3, emptyText: 4 }, t)!
      expect(s).toContain(t('chat.importExternalDropBadJson', { n: 1 }))
      expect(s).toContain(t('chat.importExternalDropNotEvent', { n: 2 }))
      expect(s).toContain(t('chat.importExternalDropNonText', { n: 3 }))
      expect(s).toContain(t('chat.importExternalDropEmptyText', { n: 4 }))
      expect(s).toContain('10')
      // 那句的总数槽与明细槽都得被填掉
      expect(s).not.toMatch(/\{[a-z]+\}/)
    }
  })

  it('H5 一个都没丢 ⇒ null（不许画一句「另有 0 条」）', () => {
    for (const lang of LANGS) {
      expect(importDroppedText({ badJson: 0, notEvent: 0, nonText: 0, emptyText: 0 }, mkT(lang))).toBeNull()
    }
  })

  it('H6 老主进程没有这个字段 ⇒ 一句都不说（把"没有这个数"演成"确实没丢东西"是谎报形状）', () => {
    for (const lang of LANGS) {
      expect(importDroppedText(undefined, mkT(lang))).toBeNull()
    }
  })

  it('H7 认不出的码回落成通用那句，绝不把裸码贴给用户', () => {
    for (const lang of LANGS) {
      const t = mkT(lang)
      const s = importWarningText({ code: 'IMPORT_FROM_THE_FUTURE' as ExternalWarningCode, where: 'x.json' }, t)
      expect(s).not.toContain('IMPORT_FROM_THE_FUTURE')
      expect(s).toContain(t('chat.importExternalWarnUnknown'))
      expect(s).toContain('x.json')
    }
  })

  it('H8 出处与错误文本取自库外（文件名／SQLite 原文）：带 $&／$\' 这类替换模式时原样上屏', () => {
    // t() 的第二参必须是函数——传字符串会让 $& 反吐占位符本身、$' 把右侧文案搬进来（§361 实测）。
    // 这里判的是 helper 没有再自己拼一次替换。
    for (const lang of LANGS) {
      const t = mkT(lang)
      const s = importWarningText({ code: 'IMPORT_WRITE_FAILED', args: { err: "SQLITE $& FAIL" }, where: "note$'s name" }, t)
      expect(s).toContain("SQLITE $& FAIL")
      expect(s).toContain("note$'s name")
    }
  })
})
