// 委派的失败**码 → 四语文案**这条契约（V4-Iter-152）
//
// 撞出来的现场：147 的真机自测在 ko 界面看到「이번에는 판정이 없습니다: 探测未跑完：3/3 次请求失败…」——
// 前半句是界面按语言出的，后半句是主进程写死的中文句子。修法不是"界面别拼它"，而是主进程**只回码 + 数**，
// 句子全部住在这里的话术表里（`DELEGATE_FAILURE_KEYS`）。
//
// 所以本文件守三件事：
//  ① 每个码在**四本字典**里都有非空、互不相同的文案（键是动态取的 ⇒ `i18n-parity` 那条只扫字面 `t('a.b')` 的
//     用例扫不到，必须在这儿反查一遍；同 `agent.role.*` 的处理办法）；
//  ② 翻出来的句子在当前语言里**不夹中文**（这就是那条缺陷的直接反向断言）；
//  ③ `capability` 这类内部枚举值不许被用户直接读到 —— 它得先过三态标签映射。
import { describe, it, expect } from 'vitest'
import {
  DELEGATE_FAILURE_KEYS,
  FAILURE_QUOTED_BUTTON_KEYS,
  delegateFailureText,
  type DelegateFailure,
  type DelegateFailureCode
} from '../src/shared/delegate-capability'
import { delegateNoticeText } from '../src/renderer/src/modules/settings/DelegateCapabilityBadge'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS
const CODES = Object.keys(DELEGATE_FAILURE_KEYS) as DelegateFailureCode[]
/** 中日韩统一表意文字（汉字）——en/ko 的成品句子里出现它，就是中英夹排 */
const HAN = /[\u4e00-\u9fff]/

const tOf = (lang: Lang) => (key: string, params?: Record<string, string | number>): string => {
  let out = (DICTS[lang] as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) out = out.replaceAll(`{${k}}`, String(v))
  return out
}

describe('码 → 键 → 四语文案', () => {
  it('四条码都在，且没有哪条码复用同一句文案', () => {
    expect(CODES.sort()).toEqual(['never_probed', 'not_capable', 'probe_incomplete', 'text_protocol_forced'])
    for (const [lang, dict] of Object.entries(DICTS)) {
      const values = CODES.map((c) => (dict as Record<string, string>)[DELEGATE_FAILURE_KEYS[c]])
      for (const v of values) expect(String(v), `${lang} 有空文案`).not.toBe('')
      expect(new Set(values).size, `${lang} 四条码的话术雷同`).toBe(CODES.length)
    }
  })

  it('翻出来的句子在非中文界面里不夹汉字（这就是那条缺陷的反向断言）', () => {
    const cases: DelegateFailure[] = [
      { code: 'text_protocol_forced' },
      { code: 'probe_incomplete', params: { failed: 3, total: 3 } },
      { code: 'never_probed' },
      { code: 'not_capable', params: { capability: 'fence_only', hits: 0, samples: 3 } }
    ]
    for (const f of cases) {
      for (const lang of ['en', 'ko'] as Lang[]) {
        const text = delegateFailureText(tOf(lang), f, 'FALLBACK')
        expect(text, `${lang} 界面不该出现汉字：${text}`).not.toMatch(HAN)
        expect(text).not.toBe('FALLBACK')
      }
    }
  })

  it('数与判定值一个都不丢（码不是把信息抹平，只是换谁说这句话）', () => {
    const text = delegateFailureText(tOf('en'), { code: 'probe_incomplete', params: { failed: 1, total: 3 } }, 'FB')
    expect(text).toContain('1/3')
    const zhText = delegateFailureText(tOf('zh'), { code: 'not_capable', params: { capability: 'fence_only', hits: 0, samples: 3 } }, 'FB')
    expect(zhText).toContain('0/3')
  })

  it('不认识的码 ⇒ 回落通用文案，绝不回落某句中文', () => {
    const junk = { code: 'made_up_code' } as unknown as DelegateFailure
    for (const lang of ['en', 'ko', 'ja'] as Lang[]) {
      const text = delegateFailureText(tOf(lang), junk, 'FALLBACK')
      // 这一条原先写成 `expect(text, 'FALLBACK')`（少了 `.toBe`）⇒ 变异"未知码回落成中文句子"当场不红，
      // 是本批的变异实测把它照出来的。断言必须带匹配器，否则等于没断。
      expect(text).toBe('FALLBACK')
      expect(text).not.toMatch(HAN)
    }
  })
})

describe('本簇的"几发成了"只有一个说法（V4-Iter-155）', () => {
  /**
   * 155 之前 ja 一句写「ヒット」、另一句写「成功」；ko 一句「적중」、一句「성공」——
   * 同一个计数在同一个屏上有两个名字，用户会以为是两件事。（别处的「캐시 적중」「初回ヒット」是
   * "缓存命中 / 检索排名"那个 hit，与本簇无关，所以不在本条断言范围内。）
   */
  it('ja 用「成功」、ko 用「성공」，且本簇里不再出现「ヒット」「적중」「完走」', () => {
    const forLang: Array<{ lang: Lang; word: string; banned: string[] }> = [
      { lang: 'ja', word: '成功', banned: ['ヒット', '完走', '命中'] },
      { lang: 'ko', word: '성공', banned: ['적중'] }
    ]
    for (const { lang, word, banned } of forLang) {
      const d = DICTS[lang] as unknown as Record<string, string>
      const keys = Object.keys(d).filter((k) => k.startsWith('provider.cap') || k.startsWith('delegate.fail'))
      expect(keys.length, `${lang} 筛到的键太少`).toBeGreaterThanOrEqual(12)
      // 计数那两处（悬停说明 + 判定不符的拒绝）必须用同一个词
      expect(d['provider.capHint'], `${lang} capHint 没用「${word}」`).toContain(word)
      expect(d['delegate.failNotCapable'], `${lang} failNotCapable 没用「${word}」`).toContain(word)
      for (const k of keys)
        for (const b of banned) expect(d[k], `${lang}.${k} 还留着「${b}」`).not.toContain(b)
    }
  })
})

describe('delegateNoticeText：两种失败来源要分流', () => {
  it('IPC 层拒绝（字符串）照原样给，不去话术表里瞎找', () => {
    expect(delegateNoticeText(tOf('en'), 'invalid args: expected string', 'FB')).toBe('invalid args: expected string')
  })

  it('空字符串也不装作有原因：回落通用文案', () => {
    expect(delegateNoticeText(tOf('en'), '', 'FB')).toBe('FB')
    expect(delegateNoticeText(tOf('en'), null, 'FB')).toBe('FB')
  })

  it('params.capability 先过三态标签：用户读到的是"只会写围栏（当前用不了）"，不是 fence_only', () => {
    const f: DelegateFailure = { code: 'not_capable', params: { capability: 'fence_only', hits: 0, samples: 3 } }
    expect(delegateNoticeText(tOf('zh'), f, 'FB')).toContain(zh['provider.capFence'])
    expect(delegateNoticeText(tOf('zh'), f, 'FB')).not.toContain('fence_only')
    const enText = delegateNoticeText(tOf('en'), f, 'FB')
    expect(enText).toContain(en['provider.capFence'])
    expect(enText).not.toMatch(HAN)
  })

  it('不是枚举值的 params 原样透传（映射只认那四个能力值）', () => {
    const f: DelegateFailure = { code: 'probe_incomplete', params: { failed: 2, total: 4 } }
    expect(delegateNoticeText(tOf('zh'), f, 'FB')).toContain('2/4')
  })
})

/**
 * 152 把中文句子换成码之后，界面上还剩一处**手抄**：`delegate.failNeverProbed` 里要点名那颗按钮，
 * 而按钮的名字是抄在句子中的。152 落地时四语只有 zh 抄对了（「探测能否派活」）——
 * en 写 "Probe"（真名 'Probe delegation'）、ja 写「判定する」、ko 写「판정하기」，**后两个在界面上根本不存在**。
 * 修法不是把那三个词改对，而是句子从那颗按钮自己用的键**现取**（`FAILURE_QUOTED_BUTTON_KEYS`）。
 */
describe('指路的按钮名从按钮自己现取（V4-Iter-153）', () => {
  it('要指路的那几条码，四本字典都得出 {btn} 占位符（谁把它抄回成整词就红）', () => {
    const codes = Object.keys(FAILURE_QUOTED_BUTTON_KEYS) as DelegateFailureCode[]
    expect(codes).toEqual(['never_probed'])
    for (const code of codes) {
      const key = DELEGATE_FAILURE_KEYS[code]
      for (const [lang, dict] of Object.entries(DICTS)) {
        expect((dict as Record<string, string>)[key], `${lang}.${key} 没带 {btn}`).toContain('{btn}')
      }
    }
  })

  it('成品句里那颗按钮 = 该语言自己的 provider.capProbe（不是另一本字典的名字）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const dict = DICTS[lang] as Record<string, string>
      const text = delegateFailureText(tOf(lang), { code: 'never_probed' }, 'FB')
      expect(dict['provider.capProbe'], `${lang} 的按钮文案是空的`).not.toBe('')
      expect(text, `${lang} 成品句没带上真按钮名：${text}`).toContain(dict['provider.capProbe'])
      expect(text, `${lang} 成品句漏了插值`).not.toContain('{btn}')
    }
  })

  it('同一句里引到的判定名 = 该语言自己的 provider.capNative（这条仍是手抄，所以更要钉）', () => {
    const cases: DelegateFailure[] = [{ code: 'never_probed' }, { code: 'not_capable', params: { capability: 'fence_only', hits: 0, samples: 3 } }]
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const dict = DICTS[lang] as Record<string, string>
      for (const f of cases) {
        const text = delegateNoticeText(tOf(lang), f, 'FB')
        expect(text, `${lang} 的 ${f.code} 没引到 provider.capNative 的原文：${text}`).toContain(dict['provider.capNative'])
      }
    }
  })
})

/**
 * ja 这一簇原先三个词并存：委派 6 处（中文词，日语几乎不用）／委任 5 处／委譲 6 处 ⇒ 用户会当成三个功能。
 * 用户 2026-10-17 选定「委任」，范围只划在模型服务商 + 委派失败话术这一簇（判据屏 judgement.* 不动）。
 */
describe('ja 委派这一簇的用词统一（V4-Iter-153）', () => {
  it('provider.cap* 与 delegate.fail* 里不再出现「委派」「委譲」', () => {
    const keys = Object.keys(ja).filter((k) => k.startsWith('provider.cap') || k.startsWith('delegate.fail'))
    // 防空转：筛出来必须是这一簇的全部（少于 15 条就是筛选条件写坏了）
    expect(keys.length, `筛到的键太少：${keys.join(', ')}`).toBeGreaterThanOrEqual(15)
    const JA = ja as Record<string, string>
    for (const k of keys) expect(JA[k], `ja.${k}`).not.toMatch(/委派|委譲/)
  })

  it('判据屏按用户选定保持原样（这条钉子守着"范围只到这一簇"这个决定，别顺手改掉）', () => {
    expect(ja['judgement.delegation']).toContain('委譲')
    expect(ja['judgement.note.delegation-on']).toContain('委譲')
  })
})
