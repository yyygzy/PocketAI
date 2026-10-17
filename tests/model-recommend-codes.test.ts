// 「模型推荐只回码」的字典对账（V4-Iter-156）
//
// 撞出这件事的原因：`steward:model-recommend` 把 60 条中文整句直接当数据返回，en / ja / ko 界面
// （含**首启向导**那一屏与导出的诊断报告）读到的是中文原样。修法是把句子搬进四语字典、主进程只回码。
//
// 码化之后真正的风险换了位置：**加了硬件分支或新推荐，却忘了登记文案** ⇒ 界面上出现裸码
// （`t()` 的兜底链是"目标语言 → zh → 键本身"，所以漏一个语言不会空白，而是悄悄掉回中文）。
// 所以本文件做四件事：
//  ① 逐分支跑 `pickByHardware`（不猜表），收集它**实际产出**的 tier / summary / reason 码；
//  ② 每条码在**四本字典**都得有非空文案（漏译当场红，且红的是"哪一语缺哪一个键"）；
//  ③ 同一 kind 内文案不许雷同（两条码共用一句 = 其中一条迟早说错话）；en / ko 不含汉字；
//  ④ 反向：实产出的码必须都在 `MODEL_REC_CODES` 清单里，清单里也不许有产不出来的码（防清单漂成摆设）。
import { describe, it, expect, vi } from 'vitest'
import type { HardwareInfo } from '../src/shared/types'
import { MODEL_REC_CODES, modelRecKey, type ModelRecKind } from '../src/shared/model-rec-codes'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

vi.mock('../src/main/steward/hardware', () => ({
  getHardwareInfo: (): HardwareInfo => ({} as HardwareInfo)
}))
import { KB_EMBED_REASON, KB_EMBED_TAG, pickByHardware } from '../src/main/steward/model-recommend'

const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS
const GB = 1024 * 1024 * 1024
const HAN = /[一-龥]/

const hw = (over: Partial<HardwareInfo>): HardwareInfo =>
  ({
    cpu: { model: 'x', cores: 4, threads: 8 },
    memory: { total: 16 * GB, free: 8 * GB },
    gpus: [],
    disk: { type: 'ssd', removable: false, drive: 'C:', volumeLabel: null, filesystem: null, totalSpace: null, freeSpace: null, mediumType: null, busType: null },
    os: { platform: 'win32', release: '10', arch: 'x64' },
    ...over
  }) as HardwareInfo

/** 11 个分支各给一份硬件画像（NVIDIA 显存未识别那条与 <6GB 同码，故只列一次） */
const BRANCHES: Array<() => HardwareInfo> = [
  () => hw({ gpus: [{ name: 'RTX 4090', memory: 24 * GB, cuda: true, mps: false }] }),
  () => hw({ gpus: [{ name: 'RTX 4070', memory: 12 * GB, cuda: true, mps: false }] }),
  () => hw({ gpus: [{ name: 'GTX 1060', memory: 6 * GB, cuda: true, mps: false }] }),
  () => hw({ gpus: [{ name: 'GTX 1050 Ti', memory: 4 * GB, cuda: true, mps: false }] }),
  () => hw({ gpus: [{ name: '未识别', cuda: true, mps: false }] }),
  () => hw({ memory: { total: 32 * GB, free: 30 * GB }, gpus: [{ name: 'M2 Max', cuda: false, mps: true }] }),
  () => hw({ memory: { total: 16 * GB, free: 14 * GB }, gpus: [{ name: 'M2', cuda: false, mps: true }] }),
  () => hw({ memory: { total: 8 * GB, free: 6 * GB }, gpus: [{ name: 'M1', cuda: false, mps: true }] }),
  () => hw({ memory: { total: 32 * GB, free: 30 * GB }, gpus: [] }),
  () => hw({ memory: { total: 16 * GB, free: 14 * GB }, gpus: [] }),
  () => hw({ memory: { total: 8 * GB, free: 6 * GB }, gpus: [] }),
  () => hw({ memory: { total: 4 * GB, free: 2 * GB }, gpus: [] })
]

const emitted = (() => {
  const acc: Record<'tier' | 'summary' | 'reason', string[]> = { tier: [], summary: [], reason: [] }
  for (const make of BRANCHES) {
    const r = pickByHardware(make())
    acc.tier.push(r.tier)
    acc.summary.push(r.summary)
    for (const p of r.picks) acc.reason.push(p.reason)
  }
  return {
    tier: [...new Set(acc.tier)],
    summary: [...new Set(acc.summary)],
    // 向量那条不在分支表里，由 recommendModels 追加 ⇒ 从导出的常量并进
    reason: [...new Set([...acc.reason, KB_EMBED_REASON])]
  }
})()

describe('① 逐分支跑真表，不靠猜', () => {
  it('12 份画像确实跑到 11 个不同分支（少一个就是分支构造没覆盖到）', () => {
    expect(emitted.summary).toHaveLength(11)
    expect(emitted.tier.sort()).toEqual(['entry', 'entry_cpu', 'flagship', 'high', 'high_cpu', 'low', 'mainstream', 'mainstream_cpu'])
    // NVIDIA 入门档与"显存未识别"是同一条分支 ⇒ 至少 30 条 reason（每分支 3 条，去重后 ≥30）
    expect(emitted.reason.length).toBeGreaterThanOrEqual(31)
  })
})

describe('②③ 每个码在四本字典里都得有说法', () => {
  const kinds: ModelRecKind[] = ['tier', 'summary', 'reason', 'tag', 'warn', 'onlineHint']
  /** 实产出的码用①的清单；tag/warn/onlineHint 由 recommendModels 按条件产出，取声明清单 */
  const codesFor = (kind: ModelRecKind): string[] =>
    kind === 'tier' || kind === 'summary' || kind === 'reason'
      ? emitted[kind as 'tier' | 'summary' | 'reason']
      : kind === 'tag'
      ? [...new Set([...MODEL_REC_CODES.tag, KB_EMBED_TAG])]
      : [...MODEL_REC_CODES[kind]]

  for (const kind of kinds) {
    it(`${kind}：每条码四语齐全、非空、互不雷同`, () => {
      const codes = codesFor(kind)
      expect(codes.length, `${kind} 一个码都没有 ⇒ 收集逻辑写坏了`).toBeGreaterThan(0)
      for (const lang of Object.keys(DICTS) as Lang[]) {
        const seen = new Map<string, string>()
        for (const code of codes) {
          const key = modelRecKey(kind, code as string)
          const text = (DICTS[lang] as Record<string, string>)[key] ?? ''
          expect(text, `${lang} 缺 ${key}（界面上会出现裸码或掉回中文）`).not.toBe('')
          const prev = seen.get(text)
          expect(prev, `${lang} 里 ${key} 与 ${prev ? `${kind}.${prev}` : ''} 用的是同一句话`).toBeUndefined()
          seen.set(text, code)
        }
        if (lang === 'en' || lang === 'ko') {
          for (const [text, code] of seen) expect(text, `${lang}.${kind}.${code} 混进了汉字`).not.toMatch(HAN)
        }
      }
    })
  }

  it('总结句的插值参数真给得出值（GPU 名 / 显存 GB 不能只在文案里出现、数据里却没有）', () => {
    for (const make of BRANCHES) {
      const r = pickByHardware(make())
      const declared = (DICTS.zh as Record<string, string>)[modelRecKey('summary', r.summary)] ?? ''
      for (const ph of ['{gpu}', '{vram}']) {
        if (declared.includes(ph)) {
          const value = r.summaryParams[ph.slice(1, -1)]
          expect(value, `summary=${r.summary} 的文案用了 ${ph}，但 summaryParams 没给这个值`).toBeDefined()
          // t() 插值时统一 String(v)，所以数字（显存 GB）也合法
          expect(['string', 'number']).toContain(typeof value)
        }
      }
    }
  })
})

describe('④ 清单不许漂', () => {
  it('实产出的码都在清单里；清单里也不许有产不出来的码（tier / summary / reason）', () => {
    for (const kind of ['tier', 'summary', 'reason'] as const) {
      const list = new Set(MODEL_REC_CODES[kind])
      for (const code of emitted[kind]) expect(list.has(code), `清单里没有 ${kind}.${code}（新增分支忘了登记）`).toBe(true)
      const used = new Set(emitted[kind])
      for (const code of list) expect(used.has(code), `清单里的 ${kind}.${code} 没有任何分支产出（漂了）`).toBe(true)
    }
  })

  it('modelRec.* 的键数 = 清单条数（既不漏也不多）', () => {
    const total = (Object.keys(MODEL_REC_CODES) as ModelRecKind[]).reduce((n, k) => n + MODEL_REC_CODES[k].length, 0)
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const keys = Object.keys(DICTS[lang]).filter((k) => k.startsWith('modelRec.'))
      expect(keys.length, `${lang} 的 modelRec 键数与清单不符`).toBe(total)
    }
    expect(total).toBe(60)
  })
})
