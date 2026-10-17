// 「一个概念一个词」术语闸门（V4-Iter-158）
//
// 为什么单独一份用例：156 把 60 条推荐语搬进四语字典之后，真正的风险不再是"漏译"（已由
// `tests/model-recommend-codes.test.ts` 逐码钉住），而是**同一个概念在不同屏上被写成两个词**、
// 以及**同一个词被拿去表示两个概念**。这两条都不是"缺键"，任何存在性断言都挡不住。
//
// 撞出它的原委：P1 —— `judgement.*` 早就把 ja「帯域」/ko「구간」当成"VRAM 实测分桶"在用，
// 而我在 `modelRec.summary.nv_mainstream` 里拿同一个词去翻译"性价比档位"（两个不同的概念）。
// 判据屏和推荐屏在同一次滚动里都看得见 ⇒ 用户会读到"帯域"指两件事。**这不是翻译口味问题，是术语污染。**
//
// 扫描粒度（重要，别扩大）：只扫**句子层的用词**，且只扫表里声明过的 scope。
// 反例就在仓里：`enc.kdfValue` 写的是 `scrypt N=2^{tier} r=8 p=1` —— 那个 `{tier}` 是公式占位符，
// 与"模型档位"同字但不同义。用例 ⑦ 专门钉住这条边界：它必须**不在**扫描范围内
// （一旦有人把 scope 扩成全字典，这一条就会误红，而误红的闸门第二天就会被关掉）。
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

type Lang = 'zh' | 'en' | 'ja' | 'ko'
const DICTS: Record<Lang, Record<string, string>> = { zh, en, ja, ko }
const LANGS: Lang[] = ['zh', 'en', 'ja', 'ko']

/** 扫描范围：只在这三个前缀里取值 */
const MODEL_REC = 'modelRec.'
const JUDGEMENT = 'judgement.'
const WIZARD_MODEL = 'wizard.model'

interface Term {
  concept: string
  /** key 前缀：这个概念只在这些屏上出现 */
  scope: string[]
  /** 每语唯一的正字 */
  canonical: Record<Lang, string>
  /** 曾经漂过 / 会被误用的写法（这些串在 scope 内出现即红） */
  banned?: Partial<Record<Lang, string[]>>
  /** 声明"这个词归表外另一族管"的理由（闸门只在自己的 scope 里说话，但要知道为什么禁） */
  ownedElsewhere?: Partial<Record<Lang, string>>
}

const TERMS: Term[] = [
  {
    concept: '模型档位（推荐那一栏与向导标题里的"档"）',
    scope: [MODEL_REC, WIZARD_MODEL],
    canonical: { zh: '档位', en: 'tier', ja: 'クラス', ko: '등급' },
    banned: {
      // ①「帯域／구간」是下面 VRAM 分桶那个词的专属，不许拿来当"档位"
      // ②「ランク」在 ja 已被"重排 rerank"一族占用（kb.rerank*），混用会造出下一个 P1
      // ③「階層」是 158 之前向导里的旧写法
      ja: ['帯域', 'ランク', '階層'],
      ko: ['구간']
    },
    ownedElsewhere: { ja: 'ランク 属于 kb.rerank*（检索重排）那一族，拿来当"档位"就是下一个 P1' }
  },
  {
    concept: 'VRAM 实测分桶（本机判据屏那一行）',
    scope: [JUDGEMENT],
    canonical: { zh: '显存档', en: 'bucket', ja: '帯域', ko: '구간' },
    // 反向：判据屏那侧也不许改用"档位"那个词，否则闸门只挡住一半
    banned: { ja: ['クラス'], ko: ['등급'] }
  }
]

/** 本批逐条判定后禁掉的写法（中文直译 / 孤立造词 / 语法不顺），四语都按 scope 扫 */
const BANNED_COPY: Array<{ lang: Lang; needle: string; why: string }> = [
  { lang: 'ja', needle: '全程', why: '「可全程 GPU」直译，158 前全字典只有我写的 3 处' },
  { lang: 'ja', needle: '成績', why: '「表现好」直译成考试分数' },
  { lang: 'ko', needle: '성적', why: '同上' },
  { lang: 'ko', needle: '우선하세요', why: '生硬，改为「먼저 쓰세요」' },
  { lang: 'ko', needle: '메모리가 되면', why: '语法不顺，改为「여유가 되면」' },
  { lang: 'en', needle: 'feel good', why: '"体验良好"直译，读起来像模型有感觉' },
  { lang: 'en', needle: 'friendly to', why: '"友好"直译' },
  { lang: 'en', needle: 'general ability', why: '"通用能力"直译' },
  { lang: 'en', needle: 'dims', why: '维度单位与字典既有写法（dimension / dim）不一致' }
]

const inScope = (lang: Lang, prefixes: string[]): Array<[string, string]> =>
  Object.entries(DICTS[lang]).filter(([k]) => prefixes.some((p) => k.startsWith(p))) as Array<[string, string]>

describe('① 表自身', () => {
  it('每个概念四语正字齐备、非空', () => {
    expect(TERMS.length, '概念表空转就等于没有闸门').toBeGreaterThanOrEqual(2)
    for (const t of TERMS) {
      for (const lang of LANGS) expect(t.canonical[lang], `${t.concept} 缺 ${lang} 的正字`).toBeTruthy()
      expect(Object.keys(t.canonical)).toHaveLength(4)
    }
  })

  it('同一个词不许挂在两个概念下（P1 的形状：帯域／구간 既当分桶又当档位）', () => {
    for (const lang of LANGS) {
      const owner = new Map<string, string>()
      for (const t of TERMS) {
        const w = t.canonical[lang]
        const prev = owner.get(w)
        expect(prev, `${lang} 里「${w}」同时被用作「${prev}」与「${t.concept}」两个概念`).toBeUndefined()
        owner.set(w, t.concept)
      }
    }
  })

  it('每个禁词都有出处：要么是本表另一个概念的正字（跨概念借用正是要挡的），要么是已清零的历史写法', () => {
    for (const t of TERMS) {
      for (const lang of LANGS) {
        for (const b of t.banned?.[lang] ?? []) {
          const ownedByAnother = TERMS.some((o) => o !== t && o.canonical[lang] === b)
          if (ownedByAnother || t.ownedElsewhere?.[lang]) continue
          const stillPresent = Object.values(DICTS[lang]).some((v) => v.includes(b))
          expect(stillPresent, `${lang}「${b}」既不是别概念的正字、又还留在字典里 ⇒ 这条禁词写歪了（要么该属于某概念，要么该已清零）`).toBe(false)
        }
      }
    }
  })
})

describe('②③ 用词只有一处', () => {
  it('每个概念：scope 内正字至少出现一次（防止表登记完就空转）', () => {
    for (const t of TERMS) {
      for (const lang of LANGS) {
        const rows = inScope(lang, t.scope)
        expect(rows.length, `${lang} 在 scope ${t.scope} 里一条都没有 ⇒ 这条断言会在空集合上恒真`).toBeGreaterThanOrEqual(5)
        const hit = rows.filter(([, v]) => v.includes(t.canonical[lang]))
        expect(hit.length, `${lang}：「${t.canonical[lang]}」（${t.concept}）在 ${t.scope} 里一次都没出现`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('每个概念：scope 内禁词零命中（新写一处没登记的别名就红）', () => {
    for (const t of TERMS) {
      for (const lang of LANGS) {
        for (const b of t.banned?.[lang] ?? []) {
          const rows = inScope(lang, t.scope).filter(([, v]) => v.includes(b))
          expect(rows.map(([k]) => k), `${lang}：「${b}」被用在了「${t.concept}」那些句子里（${t.scope}）`).toEqual([])
        }
      }
    }
  })

  it('跨概念独占（**由表推导，不靠手写禁词**）：某概念的正字不得出现在别的概念的 scope 里', () => {
    for (const t of TERMS) {
      for (const other of TERMS) {
        if (other === t) continue
        for (const lang of LANGS) {
          const w = other.canonical[lang]
          const rows = inScope(lang, t.scope).filter(([, v]) => v.includes(w))
          expect(rows.map(([k]) => k), `${lang}：「${w}」是「${other.concept}」的正字，却出现在「${t.concept}」的句子（${t.scope}）里 ⇒ 两义`).toEqual([])
        }
      }
    }
  })

  it('本批判掉的写法不许回来（逐条禁词，附理由）', () => {
    for (const { lang, needle, why } of BANNED_COPY) {
      const rows = inScope(lang, [MODEL_REC, JUDGEMENT, WIZARD_MODEL]).filter(([, v]) => v.includes(needle))
      expect(rows.map(([k]) => k), `${lang} 里「${needle}」又出现了（理由：${why}）`).toEqual([])
    }
  })

  it('数字区间的连接符号四语统一（en 曾写 8-16GB，其余三语写 8–16GB）', () => {
    for (const lang of LANGS) {
      for (const [k, v] of inScope(lang, [MODEL_REC])) {
        expect(v, `${lang} ${k} 用了 ASCII 连字符做数字区间：${v.slice(0, 60)}`).not.toMatch(/\d-\d/)
      }
    }
  })
})

describe('⑦ 扫描粒度的边界（防止闸门扩到全字典后误红）', () => {
  it('`enc.kdfValue` 里那个 {tier} 与"模型档位"同字不同义，必须留在范围外', () => {
    expect(en['enc.kdfValue']).toContain('{tier}')
    const scopes = TERMS.flatMap((t) => t.scope)
    expect(scopes.some((p) => 'enc.kdfValue'.startsWith(p)), '若有人把 scope 扩到全字典，这条会立刻误红').toBe(false)
    // 并且：本表登记的 en 正字确实与它同字 ⇒ 证明"这不是假想，是真会撞"
    const tierConcept = TERMS.find((t) => t.canonical.en === 'tier')
    expect(tierConcept, 'en 的"档位"正字应当是 tier').toBeTruthy()
  })
})
