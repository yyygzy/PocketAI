// 工具调用能力判卷（P0-4b）——纯函数表 + 四条界线
//
// 要钉住的不是"四档名字"，而是这四件事：
// ① 请求失败 ≠ 不会调工具（失败必须落 unknown，且不覆盖旧判定）；
// ② 端点明确拒绝 tools 才是确定性"不会"（这条由主进程分支负责，这里只测码表）；
// ③ 围栏格式 ≠ 能用（当前引擎只认 ```tool_call，照旧直说"用不了"）；
// ④ 部分命中 ≠ 会调（2/3 只能算"可能"）。
import { describe, it, expect } from 'vitest'
import {
  MAX_TOOL_CAP_ENTRIES,
  MIN_TOOL_PROBE_RUNS,
  TOOL_PROBE,
  findToolModelDigest,
  hasFencedToolCall,
  isLegalToolProbeArgs,
  isToolEntryStale,
  judgeToolProbe,
  normalizeToolEntries,
  replyToToolProbeSample,
  skippedToolEntry,
  toolCapabilityKey,
  toolFailureText,
  toolReasonText,
  toolTierText,
  type ToolCapabilityTier,
  type ToolProbeFailureCode,
  type ToolProbeReason,
  type ToolProbeReply
} from '../src/shared/tool-capability'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const native = (over: Partial<ToolProbeReply> = {}): ToolProbeReply => ({
  ok: true,
  nativeCall: true,
  fencedCall: false,
  ...over
})

describe('judgeToolProbe —— 四档与 unknown 的来源', () => {
  it('3/3 原生调用 ⇒ usable（3 发是既有探针同一档，不改阈值）', () => {
    const j = judgeToolProbe([native(), native(), native()])
    expect(j.tier).toBe('usable')
    expect(j.samples).toBe(MIN_TOOL_PROBE_RUNS)
    expect(j.reason).toBeUndefined()
  })

  it('2/3 原生调用 ⇒ likely_unusable（"偶尔会"不能记成"会"）', () => {
    const j = judgeToolProbe([native(), native(), native({ nativeCall: false })])
    expect(j.tier).toBe('likely_unusable')
    expect(j.nativeHits).toBe(2)
    expect(j.reason).toBe('partial_native_calls')
  })

  it('零原生调用、但三次都写围栏 ⇒ known_unusable/fence_only（不许写成"能用"）', () => {
    const j = judgeToolProbe([
      native({ nativeCall: false, fencedCall: true }),
      native({ nativeCall: false, fencedCall: true }),
      native({ nativeCall: false, fencedCall: true })
    ])
    expect(j.tier).toBe('known_unusable')
    expect(j.reason).toBe('fence_only')
    expect(j.fenceHits).toBe(3)
  })

  it('既不调也不写围栏 ⇒ known_unusable/no_native_call（1.5B 直接自己作答的真实形状）', () => {
    const j = judgeToolProbe([
      native({ nativeCall: false }),
      native({ nativeCall: false }),
      native({ nativeCall: false })
    ])
    expect(j.tier).toBe('known_unusable')
    expect(j.reason).toBe('no_native_call')
  })

  it('反向对照：一次请求失败就压成 unknown，不许落成"不会调工具"', () => {
    const j = judgeToolProbe([native(), native(), native({ ok: false, nativeCall: false, fencedCall: false })])
    expect(j.tier).toBe('unknown')
    expect(j.reason).toBe('some_requests_failed')
  })

  it('反向对照：有效样本不足（2 发）⇒ unknown，不许凑成结论', () => {
    const j = judgeToolProbe([native(), native()])
    expect(j.tier).toBe('unknown')
    expect(j.reason).toBe('insufficient_runs')
  })

  it('反向对照：零样本 ⇒ unknown/no_samples', () => {
    const j = judgeToolProbe([])
    expect(j.tier).toBe('unknown')
    expect(j.reason).toBe('no_samples')
  })
})

describe('探针请求体与判据同源', () => {
  it('原生调用 + 合法参数才算命中', () => {
    const s = replyToToolProbeSample({
      content: '',
      toolCalls: [{ name: TOOL_PROBE.toolName, arguments: JSON.stringify({ query: 'POCKETAI-TOOL-PROBE' }) }]
    })
    expect(s).toEqual({ ok: true, nativeCall: true, fencedCall: false })
  })

  it('调了别的工具 / 参数缺失 / 非法 JSON 都不算命中', () => {
    for (const args of ['{}', 'not-json']) {
      const s = replyToToolProbeSample({ content: '', toolCalls: [{ name: TOOL_PROBE.toolName, arguments: args }] })
      expect(s.nativeCall).toBe(false)
    }
    const other = replyToToolProbeSample({
      content: '',
      toolCalls: [{ name: 'other_tool', arguments: '{"query":"x"}' }]
    })
    expect(other.nativeCall).toBe(false)
  })

  it('请求失败 ⇒ ok:false，且不参与任何"不会"的判据', () => {
    expect(replyToToolProbeSample({ content: '', requestOk: false })).toEqual({
      ok: false,
      nativeCall: false,
      fencedCall: false
    })
  })

  it('围栏识别：json 标签也算（诊断用，不等于引擎放宽解析）', () => {
    const text = '```json\n{"name":"tool_probe","arguments":{"query":"x"}}\n```'
    expect(hasFencedToolCall(text)).toBe(true)
    expect(hasFencedToolCall('```\nnot json\n```')).toBe(false)
    expect(hasFencedToolCall('```json\n{"name":"other","arguments":{}}\n```')).toBe(false)
  })

  it('参数校验只看必填项存在且非空（能力探测不考核参数质量）', () => {
    expect(isLegalToolProbeArgs({ query: 'x' })).toBe(true)
    expect(isLegalToolProbeArgs({ query: '   ' })).toBe(false)
    expect(isLegalToolProbeArgs({})).toBe(false)
    expect(isLegalToolProbeArgs(null)).toBe(false)
  })
})

describe('落盘清洗与键形状', () => {
  const good = {
    key: 'stale-key',
    providerId: 'p1',
    model: 'm1',
    tier: 'usable',
    reason: '',
    samples: 3,
    nativeHits: 3,
    fenceHits: 0,
    digest: 'sha256:abc',
    checkedAt: 123
  }

  it('键由 providerId::model 重算，不信任存进来的 key', () => {
    const [e] = normalizeToolEntries([good])
    expect(e!.key).toBe(toolCapabilityKey('p1', 'm1'))
  })

  it('脏项整条丢掉：脏 tier / 缺 model / 超长 providerId 都不许换来一条默认判定', () => {
    const out = normalizeToolEntries([
      { ...good, tier: 'maybe' },
      { ...good, model: '' },
      { ...good, providerId: 'x'.repeat(300) },
      good
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.tier).toBe('usable')
  })

  it('同一键去重；容量上限兜底', () => {
    expect(normalizeToolEntries([good, { ...good, checkedAt: 9 }])).toHaveLength(1)
    const many = Array.from({ length: MAX_TOOL_CAP_ENTRIES + 20 }, (_, i) => ({ ...good, model: `m${i}` }))
    expect(normalizeToolEntries(many)).toHaveLength(MAX_TOOL_CAP_ENTRIES)
  })

  it('非法 reason 落成空串（未知码只影响解释，不影响档位）', () => {
    const [e] = normalizeToolEntries([{ ...good, reason: 'whatever' }])
    expect(e!.reason).toBe('')
  })

  it('跳过检测写 unknown + user_skipped（自动探测据此不再重复问）', () => {
    const e = skippedToolEntry('p1', 'm1')
    expect(e.tier).toBe('unknown')
    expect(e.reason).toBe('user_skipped')
    expect(e.key).toBe('p1::m1')
  })
})

describe('过期判定：拿不到摘要就不许说"模型已更新"', () => {
  const local = new Set(['local'])
  const details = [{ name: 'qwen2.5:3b', digest: 'sha256:new' }]
  const entry = { providerId: 'local', model: 'qwen2.5:3b', digest: 'sha256:old' }

  it('本地且摘要变了 ⇒ stale', () => {
    expect(isToolEntryStale(entry, local, details)).toBe(true)
  })

  it('摘要相同 ⇒ 不过期', () => {
    expect(isToolEntryStale({ ...entry, digest: 'sha256:new' }, local, details)).toBe(false)
  })

  it('云端（无 digest）⇒ 永远不判过期', () => {
    expect(isToolEntryStale({ ...entry, providerId: 'cloud' }, new Set(['local']), details)).toBe(false)
  })

  it('本地但当前取不到摘要 ⇒ 也不算过期（那是"无法核对"）', () => {
    expect(isToolEntryStale({ ...entry, model: 'gone' }, local, [])).toBe(false)
  })

  it('同名优先、家族回落（与委派探针同一套）', () => {
    expect(findToolModelDigest(details, 'qwen2.5:3b')).toBe('sha256:new')
    expect(findToolModelDigest([{ name: 'qwen2.5:7b', digest: 'd7' }], 'qwen2.5:3b')).toBe('d7')
  })
})

describe('文案函数：每个码都有句子（静态 key），占位符逐语一致', () => {
  const dicts: Record<string, Record<string, string>> = { zh, en, ja, ko }
  const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
  const TIERS: ToolCapabilityTier[] = ['unknown', 'usable', 'likely_unusable', 'known_unusable']
  const REASONS: ToolProbeReason[] = [
    'no_samples',
    'some_requests_failed',
    'insufficient_runs',
    'partial_native_calls',
    'no_native_call',
    'fence_only',
    'tools_rejected',
    'user_skipped'
  ]
  const FAILURES: ToolProbeFailureCode[] = [
    'probe_incomplete',
    'probe_timeout',
    'probe_aborted',
    'probe_running',
    'auth_failed',
    'network_failed'
  ]
  interface Call {
    key: string
    params: Record<string, string | number>
  }
  /** 假 t：只记录 key 与参数，返回 key 本身。判"有没有句子"不依赖语言实现 */
  const spy = (calls: Call[]) => (key: string, params?: Record<string, string | number>): string => {
    calls.push({ key, params: params ?? {} })
    return key
  }
  /** 每个码都在四语里，且字典要求的占位符都被调用点填上了（漏参会让界面留下 {x}） */
  const checkCalls = (calls: Call[]): void => {
    for (const { key, params } of calls) {
      for (const [lang, dict] of Object.entries(dicts)) {
        const sentence = dict[key] ?? ''
        expect(sentence, `${lang} 缺 ${key}`).toBeTruthy()
        for (const ph of placeholders(sentence)) {
          expect(Object.keys(params), `${key} 少了参数 {${ph}}`).toContain(ph)
        }
      }
    }
  }

  it('四档：每一档都有静态句', () => {
    const calls: Call[] = []
    const t = spy(calls)
    for (const tier of TIERS) toolTierText(t, tier)
    expect(calls).toHaveLength(TIERS.length)
    checkCalls(calls)
  })

  it('原因码：每一个都有静态句（2/3 这类计数据也填得上）', () => {
    const calls: Call[] = []
    const t = spy(calls)
    for (const reason of REASONS) toolReasonText(t, { reason, nativeHits: 2, samples: 3 })
    expect(calls).toHaveLength(REASONS.length)
    checkCalls(calls)
  })

  it('失败码：每一个都有静态句（超时那发的 {sec} 不漏）', () => {
    const calls: Call[] = []
    const t = spy(calls)
    for (const code of FAILURES) toolFailureText(t, { code, params: { failed: 1, total: 3, sec: 60 } }, 'fallback')
    expect(calls).toHaveLength(FAILURES.length)
    checkCalls(calls)
  })

  it('同一键在四语里的占位符集合一致（插值不会在某种语言里丢参数）', () => {
    const calls: Call[] = []
    const t = spy(calls)
    for (const tier of TIERS) toolTierText(t, tier)
    for (const reason of REASONS) toolReasonText(t, { reason, nativeHits: 2, samples: 3 })
    for (const code of FAILURES) toolFailureText(t, { code, params: { failed: 1, total: 3, sec: 60 } }, 'fallback')
    for (const { key } of calls) {
      const base = placeholders(dicts.zh![key] ?? '').join(',')
      for (const [lang, dict] of Object.entries(dicts)) {
        expect(placeholders(dict[key] ?? '').join(','), `${lang} 的 ${key} 占位符不一致`).toBe(base)
      }
    }
  })
})
