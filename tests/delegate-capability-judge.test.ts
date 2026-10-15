// 委派能力判卷（V4-Iter-142）——纯函数表 + 两条界线反向对照
//
// 关键不是"三态对不对"，而是两条界线：
// ① 诊断用的宽松围栏匹配 **不等于** 引擎的解析放宽（决策①已定论不放宽 ```tool_call 标签）；
// ② 请求失败 **不等于** 这台模型不派活。
import { describe, it, expect } from 'vitest'
import {
  DELEGATE_PROBE,
  DELEGATE_PROBE_TOOL,
  hasFencedDelegateCall,
  isLegalDelegateArgs,
  judgeDelegateProbe,
  normalizeDelegateEntries,
  replyToProbeSample,
  type ProbeReply
} from '../src/shared/delegate-capability'
import { extractTextToolCalls } from '../src/shared/text-tool-protocol'

const native = (over: Partial<ProbeReply> = {}): ProbeReply => ({
  ok: true,
  nativeCall: true,
  fencedCall: false,
  ...over
})

describe('judgeDelegateProbe —— 三态 + unknown 的来源', () => {
  it('3/3 原生调用 ⇒ native_tools_ok（M7 实测 3b 就是这一档）', () => {
    const j = judgeDelegateProbe([native(), native(), native()])
    expect(j.capability).toBe('native_tools_ok')
    expect(j.samples).toBe(3)
  })

  it('3 发里只有 2 发原生调用 ⇒ no_delegation（"偶尔会"不能记成"会"）', () => {
    const j = judgeDelegateProbe([native(), native(), native({ nativeCall: false })])
    expect(j.capability).toBe('no_delegation')
    expect(j.nativeHits).toBe(2)
  })

  it('零原生调用、但有 ```json 围栏形状 ⇒ fence_only（coder-1.5b 的真实形状）', () => {
    const j = judgeDelegateProbe([
      native({ nativeCall: false, fencedCall: true }),
      native({ nativeCall: false, fencedCall: true }),
      native({ nativeCall: false, fencedCall: true })
    ])
    expect(j.capability).toBe('fence_only')
    expect(j.nativeHits).toBe(0)
    expect(j.fenceHits).toBe(3)
  })

  it('既不调也不写围栏 ⇒ no_delegation（1.5b-instruct 直接自己作答）', () => {
    const j = judgeDelegateProbe([native({ nativeCall: false }), native({ nativeCall: false }), native({ nativeCall: false })])
    expect(j.capability).toBe('no_delegation')
  })

  it('反向对照：一次请求失败就把结论压成 unknown，不许落成"不派活"', () => {
    const j = judgeDelegateProbe([native(), native(), native({ ok: false, nativeCall: false, fencedCall: false })])
    expect(j.capability).toBe('unknown')
    expect(j.reason).toBe('some_requests_failed')
  })

  it('样本不足（<3）不出结论，也不猜', () => {
    expect(judgeDelegateProbe([native()]).capability).toBe('unknown')
    expect(judgeDelegateProbe([native()]).reason).toBe('insufficient_runs')
    expect(judgeDelegateProbe([]).reason).toBe('no_samples')
  })
})

describe('围栏形状识别 —— 只用于诊断', () => {
  const fencedJson = '我来安排：\n```json\n{"name":"delegate_probe","arguments":{"role":"researcher","task":"查清检索为什么慢"}}\n```'
  const fencedToolCall = '```tool_call\n{"name":"delegate_probe","arguments":{"role":"writer","task":"写汇报"}}\n```'
  const fencedOtherName = '```json\n{"name":"kb_search","arguments":{"query":"x"}}\n```'
  const fencedCodeSample = '```json\n{"name":"tom","arguments":{"k":1}}\n```'

  it('```json 与 ```tool_call 两种标签都被识别为"它想调工具"', () => {
    expect(hasFencedDelegateCall(fencedJson)).toBe(true)
    expect(hasFencedDelegateCall(fencedToolCall)).toBe(true)
    expect(hasFencedDelegateCall('今天天气不错')).toBe(false)
  })

  it('反向对照：引擎的严格解析器对 ```json 仍然抽不到（诊断放宽 ≠ 执行放宽）', () => {
    expect(extractTextToolCalls(fencedJson, new Set([DELEGATE_PROBE_TOOL])).calls).toEqual([])
    // 而 ```tool_call 引擎是能抽到的 —— 说明两者不是同一套规则，谁也不许"顺手"改成另一套
    expect(extractTextToolCalls(fencedToolCall, new Set([DELEGATE_PROBE_TOOL])).calls.length).toBe(1)
  })

  it('名字不是探针工具的围栏块不算（含"恰好带 name/arguments 的普通 JSON 示例"）', () => {
    expect(hasFencedDelegateCall(fencedOtherName)).toBe(false)
    expect(hasFencedDelegateCall(fencedCodeSample)).toBe(false)
    expect(hasFencedDelegateCall('```json\n{坏 JSON,}\n```')).toBe(false)
  })

  it('参数合法性：role 必须在枚举内、task 要够长（防止"空派活"被判成会派活）', () => {
    expect(isLegalDelegateArgs({ role: 'researcher', task: '查清知识库检索为什么慢' })).toBe(true)
    expect(isLegalDelegateArgs({ role: 'boss', task: '查清知识库检索为什么慢' })).toBe(false)
    expect(isLegalDelegateArgs({ role: 'writer', task: '短' })).toBe(false)
    expect(isLegalDelegateArgs({ role: 'writer' })).toBe(false)
    expect(isLegalDelegateArgs(null)).toBe(false)
    expect(DELEGATE_PROBE.roles.length).toBeGreaterThan(0)
  })
})

describe('replyToSample —— 从一次真实回复形状抽判据', () => {
  it('原生 tool_calls 里有合法委派 ⇒ nativeCall', () => {
    const s = replyToProbeSample({
      content: '',
      toolCalls: [{ name: DELEGATE_PROBE_TOOL, arguments: '{"role":"writer","task":"写一段给老板的汇报，说明检索慢的原因"}' }]
    })
    expect(s).toEqual({ ok: true, nativeCall: true, fencedCall: false })
  })

  it('原生调用名字对但参数是坏 JSON ⇒ 不算原生命中（退化去看围栏）', () => {
    const s = replyToProbeSample({ content: '```json\n{"name":"delegate_probe","arguments":{"role":"writer","task":"写一段汇报说明检索慢"}}\n```', toolCalls: [{ name: DELEGATE_PROBE_TOOL, arguments: '{坏' }] })
    expect(s.nativeCall).toBe(false)
    expect(s.fencedCall).toBe(true)
  })

  it('requestOk=false 直接是失败样本（不参与能力判定）', () => {
    expect(replyToProbeSample({ content: '', requestOk: false })).toEqual({ ok: false, nativeCall: false, fencedCall: false })
  })
})

describe('normalizeDelegateEntries —— 落盘清洗（脏值整条丢，不给默认结论）', () => {
  it('脏 JSON / 非数组 ⇒ 空表', () => {
    for (const raw of [null, undefined, {}, 'x', [1, 'a', null]]) {
      expect(normalizeDelegateEntries(raw)).toEqual([])
    }
  })

  it('缺 providerId/model、能力值不认识、键超限都丢；同键只留第一条', () => {
    const good = { providerId: 'p1', model: 'm1', capability: 'native_tools_ok', samples: 3, nativeHits: 3, digest: 'sha256:a', checkedAt: 10 }
    const out = normalizeDelegateEntries([
      good,
      { ...good, model: '' },
      { ...good, capability: 'definitely_ok' },
      { ...good, providerId: 'x'.repeat(300) },
      { providerId: 'p1', model: 'm1', capability: 'no_delegation', samples: 3, nativeHits: 0, digest: '', checkedAt: 9 },
      { providerId: 'p2', model: 'm2', capability: 'fence_only', samples: 3, nativeHits: 0, digest: '', checkedAt: 8 }
    ])
    expect(out.map((e) => e.key)).toEqual(['p1::m1', 'p2::m2'])
    expect(out[0]!.capability).toBe('native_tools_ok')
  })

  it('数值列脏值退 0、超上限截断，不抛', () => {
    const out = normalizeDelegateEntries([
      { providerId: 'p', model: 'm', capability: 'unknown', samples: -5, nativeHits: 'x', digest: 1, checkedAt: 1e30 }
    ])
    expect(out[0]).toMatchObject({ samples: 0, nativeHits: 0, digest: '' })
    expect(out[0]!.checkedAt).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
  })
})
