// 文案里"引起来的界面名字"必须就是界面上那三个字（V4-Iter-154）
//
// 撞出来的现场：153 之后我做了一次全量对账，查出四类手抄漂了的名字——
//  · ja/ko 的向导话术教用户去「設定 → モデル提供元」「설정 → 모델 제공처」，而那一栏的标题逐字是
//    `provider.title` = 「モデルプロバイダー」「모델 공급자」⇒ **照着找不到**；
//  · ja/ko 的悬停写「管理役可」「관리자 가능」，徽标真名是「管理役が可能」「관리자 역할 가능」；
//  · zh/en 的拒探话术写「走文本协议」/"text protocol"，开关真名是「文本协议」/'Text protocol'；
//  · 四语 `provider.capHint` 各引了一句"探针问的话"，而探针**压根没那样问过**
//    （`DELEGATE_PROBE.userPrompt` 是「帮我写一段给老板看的汇报…」，"必须派给子代理"写在 system 里）。
//
// 两条断言的分工：
//  ① `QUOTED_LABELS` 是一张**登记表**：每条文案引的是哪条 label，逐语断"句子含那条 label 的原文"；
//  ② 扫描这一簇里**每一个**被引号包起来的片段：要么是占位符、要么等于某条 label、要么是能拆成两条 label 的路径，
//     要么在 `PROSE_QUOTES` 里写明"它不是界面名字"⇒ 新增一处没登记的手抄当场红。
// 口径与 153 一致：**手抄本身不是错，没被钉住的手抄才是**。
import { describe, it, expect } from 'vitest'
import { MIN_PROBE_RUNS } from '../src/shared/delegate-capability'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS
type Dict = Record<string, string>

/** 允许被文案引用的"界面上的名字"。要引别的名，先把那条键加进来（逼一次判断：那真的是个界面名字吗） */
const LABEL_KEYS = [
  'provider.capNative',
  'provider.capFence',
  'provider.capNone',
  'provider.capUnknown',
  'provider.capProbe',
  'provider.fetch',
  'provider.title',
  'agent.textProtocol',
  'agent.textProtocolOn',
  'sidebar.settings'
] as const

/** ① 登记表：文案键 → 它引的 label 键（四语都得含各自那条的原文） */
const QUOTED_LABELS: Record<string, string[]> = {
  'provider.capHint': ['provider.capNative'],
  'provider.capDelegationNeedsProbe': ['provider.capNative'],
  'delegate.failTextProtocol': ['agent.textProtocol'],
  'delegate.failNeverProbed': ['provider.capNative'],
  'delegate.failNotCapable': ['provider.capNative'],
  // 路径型引用：两段各是一条 label
  'wizard.probeHint': ['sidebar.settings', 'provider.title'],
  'wizard.probeNotEnabled': ['sidebar.settings', 'provider.title'],
  // 156 新搬进字典的那句也引了栏位名（原来它是主进程里的中文整句，写着「模型提供商」这个不存在的名字）
  'modelRec.onlineHint.low_end': ['sidebar.settings', 'provider.title']
}

/** ② 例外：口语强调，**不是**界面名字，所以不登记进 ①（每条都得写明为什么） */
const PROSE_QUOTES: Partial<Record<Lang, string[]>> = {
  // zh 的完成页标题「这台模型能不能"派活"」——"派活"是本模块一贯的口语说法，界面上没有这个控件
  zh: ['派活']
}

/** 只扫这一簇：委派徽标 / 委派失败话术 / 首启那一格 / 文本协议开关 */
const CLUSTER = ['provider.cap', 'delegate.fail', 'wizard.probe', 'agent.textProtocol',
  // 156：模型推荐那 60 条也进扫描范围（它们以前在主进程里，压根不在字典的射程内）
  'modelRec.']
const QUOTE_PAT = /「([^」]{1,40})」|“([^”]{1,40})”|"([^"]{1,40})"/g

const labelsOf = (d: Dict): string[] => LABEL_KEYS.map((k) => d[k]).filter((v): v is string => typeof v === 'string' && v !== '')
const quotedIn = (s: string): string[] => Array.from(s.matchAll(QUOTE_PAT), (m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean)

describe('①登记过的引用：句子含该语言自己的那条 label 原文', () => {
  it('表里每条、每一语都含（名字漂了就红，不管漂成简称还是大小写）', () => {
    for (const [textKey, labelKeys] of Object.entries(QUOTED_LABELS)) {
      for (const lang of Object.keys(DICTS) as Lang[]) {
        const d = DICTS[lang] as Dict
        const sentence = d[textKey]
        expect(sentence, `${lang}.${textKey} 不存在`).toBeTruthy()
        for (const lk of labelKeys) {
          const label = d[lk]
          expect(label, `${lang}.${lk} 不存在`).toBeTruthy()
          expect(sentence, `${lang}.${textKey} 没含 ${lk} 的原文「${label}」：${sentence}`).toContain(label)
        }
      }
    }
  })

  it('登记表里不许出现"引了自己"或空表项（防空转）', () => {
    for (const [textKey, labelKeys] of Object.entries(QUOTED_LABELS)) {
      expect(labelKeys.length, `${textKey} 没登记任何 label`).toBeGreaterThan(0)
      for (const lk of labelKeys) expect(lk, `${textKey} 引了自己？`).not.toBe(textKey)
    }
    expect(Object.keys(QUOTED_LABELS).length).toBeGreaterThanOrEqual(8)
  })

  it('capHint 里被引号包起来的**只能**是真判定名（探针没问过那句话，别把它写成"问一句…"）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const d = DICTS[lang] as Dict
      const hint = d['provider.capHint'] ?? ''
      const verdict = d['provider.capNative'] ?? ''
      expect(verdict, `${lang} 的 provider.capNative 是空的`).not.toBe('')
      // 逐语断：引号内容 = 该语言的 provider.capNative，一条不多一条不少
      expect(quotedIn(hint), `${lang} 的 capHint 引了判定名之外的东西：${hint}`).toEqual([verdict])
      // 它承诺的次数必须等于探针真的会发的那几次（同源取常量，别把 3 再抄一遍）
      expect(hint, `${lang} 的 capHint 承诺的次数与 MIN_PROBE_RUNS 不符`).toContain(String(MIN_PROBE_RUNS))
    }
  })
})

describe('②这一簇里不许有没登记的手抄名', () => {
  it('每个被引号包起来的片段：占位符 / 等于某条 label / 能拆成两条 label 的路径 / 在 PROSE 例外里', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const d = DICTS[lang] as Dict
      const labels = labelsOf(d)
      const prose = PROSE_QUOTES[lang] ?? []
      const scanned: string[] = []
      for (const key of Object.keys(d).filter((k) => CLUSTER.some((p) => k.startsWith(p)))) {
        const value = d[key]
        if (typeof value !== 'string') continue
        for (const q of quotedIn(value)) {
          scanned.push(`${key}「${q}」`)
          if (/^\{[a-zA-Z_]+\}$/.test(q)) continue // {btn} / {capability} 这类运行时填的
          if (labels.includes(q)) continue
          const parts = q.split(/→|-/).map((p) => p.trim()).filter(Boolean)
          if (parts.length > 1 && parts.every((p) => labels.includes(p))) continue // 「设置 → 模型服务商」
          expect(prose, `${lang} 的 ${key} 引了「${q}」：既不是界面名字，也没写进 PROSE_QUOTES`).toContain(q)
        }
      }
      // 防扫描空转：这一簇确实扫得到东西。阈值取**下限 4**而不是当前实测条数——
      // 原先拍的是 "> 6"（就是今天的条数），结果 M6 那种"合法地把一处引号删掉"也把它撞红了：
      // 那是在考"文案不许变短"，不是"筛选条件有没有写坏"。
      expect(scanned.length, `${lang} 一个引号片段都没扫到 ⇒ 筛选条件写坏了`).toBeGreaterThanOrEqual(4)
      // 还得扫到"至少一条等于 label 的"与"至少一条占位符"，否则等于没筛
      expect(scanned.some((s) => labels.some((l) => s.includes('「' + l + '」'))), `${lang} 没扫到任何 label 引用`).toBe(true)
      expect(scanned.some((s) => s.includes('{')), `${lang} 没扫到任何占位符引用`).toBe(true)
    }
  })

  it('PROSE 例外不许腐烂：写进去的每一条都还得真的出现在这一簇里', () => {
    for (const [lang, list] of Object.entries(PROSE_QUOTES)) {
      const d = DICTS[lang as Lang] as Dict
      const all = Object.keys(d)
        .filter((k) => CLUSTER.some((p) => k.startsWith(p)))
        .map((k) => quotedIn(String(d[k] ?? '')))
        .flat()
      for (const q of list) expect(all, `${lang} 的例外「${q}」已经不在文案里了，删掉这条`).toContain(q)
    }
  })

  it('四语那一栏的标题与侧栏名都被逐字用进了路径话术（"照着找不到"就是这条用例存在的理由）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const d = DICTS[lang] as Dict
      for (const key of ['wizard.probeHint', 'wizard.probeNotEnabled']) {
        expect(d[key], `${lang}.${key} 缺路径话术`).toContain(d['provider.title'])
      }
    }
  })
})
