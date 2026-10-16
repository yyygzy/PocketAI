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
