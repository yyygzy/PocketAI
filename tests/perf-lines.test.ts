// 日志 [perf] 行解析与跨会话聚合（纯函数，主进程只负责把行喂进来）
import { describe, it, expect } from 'vitest'
import { parsePerfLine, summarizePerf } from '../src/shared/perf-lines'
import type { PerfEvent } from '../src/shared/types'

const T = '2026-10-10 08:12:34'
const EPOCH = Date.parse('2026-10-10T08:12:34')

describe('parsePerfLine', () => {
  it('INFO 级慢事件：label / ms / detail / 时间戳都取到', () => {
    const e = parsePerfLine(`${T} INFO  [perf] [perf] kb.ingest: 4321ms | file=a.pdf`)
    expect(e).toEqual({ label: 'kb.ingest', ms: 4321, detail: 'file=a.pdf', at: EPOCH })
  })

  it('无 detail 的启动/埋点行也能解析（detail 省略）', () => {
    const e = parsePerfLine(`${T} INFO  [perf] [perf] kb.retrieve: 900ms`)
    expect(e).toEqual({ label: 'kb.retrieve', ms: 900, detail: undefined, at: EPOCH })
  })

  it('带冒号的渲染端标签（renderer:longtask）不被拆开', () => {
    const e = parsePerfLine(`${T} INFO  [perf] [perf] renderer:longtask: 260ms`)
    expect(e?.label).toBe('renderer:longtask')
    expect(e?.ms).toBe(260)
  })

  it('DEBUG 级同格式行丢弃：那是未超阈值的快操作，混进来会拉低统计', () => {
    expect(parsePerfLine(`${T} DEBUG [perf] [perf] kb.ingest: 12ms | file=a.pdf`)).toBeNull()
  })

  it('启动阶段的中文可读名（bootMark 实际写入的名字）不参与聚合', () => {
    // bootMark 的 label 是给人看的中文名，不是 ASCII 标识符 ⇒ 正则天然不匹配，
    // 面板另有「本次启动」区块，无需再统计一遍
    expect(parsePerfLine(`${T} INFO  [boot-perf] [perf] 目录/日志初始化: 120ms`)).toBeNull()
    expect(parsePerfLine(`${T} INFO  [boot-perf] [perf] DB 无密码打开+迁移: 800ms`)).toBeNull()
  })

  it('非 [perf] 行一律丢弃（日志原文可能含用户数据，绝不能外传）', () => {
    expect(parsePerfLine(`${T} INFO  [chat] 用户问题：我上周让你写的那份报告在哪里`)).toBeNull()
    expect(parsePerfLine(`${T} ERROR [backup] WebDAV 上传失败: 403`)).toBeNull()
    expect(parsePerfLine('')).toBeNull()
  })

  it('毫秒数缺失或不是 ms 结尾不匹配', () => {
    expect(parsePerfLine(`${T} INFO  [perf] [perf] kb.ingest: ms`)).toBeNull()
    expect(parsePerfLine(`${T} INFO  [perf] [perf] kb.ingest: 12s`)).toBeNull()
  })

  it('时间戳缺失或被截断时 at 归 0，计数与耗时仍可用', () => {
    const e = parsePerfLine('INFO  [perf] [perf] kb.ingest: 50ms')
    expect(e).toEqual({ label: 'kb.ingest', ms: 50, detail: undefined, at: 0 })
  })

  it('detail 里的 model= 只用于归因，不影响解析', () => {
    const e = parsePerfLine(`${T} INFO  [perf] [perf] chat.ttft: 6100ms | model=deepseek-reasoner`)
    expect(e?.label).toBe('chat.ttft')
    expect(e?.detail).toContain('model=deepseek-reasoner')
  })
})

describe('summarizePerf', () => {
  const evt = (label: string, ms: number, at = EPOCH, detail?: string): PerfEvent => ({
    label,
    ms,
    at,
    ...(detail ? { detail } : {})
  })

  it('按 label 聚合 count / p50 / max / lastAt', () => {
    const rows = summarizePerf([
      evt('kb.ingest', 100),
      evt('kb.ingest', 900),
      evt('kb.ingest', 500, EPOCH + 1000),
      evt('kb.retrieve', 200)
    ])
    expect(rows).toHaveLength(2)
    const ingest = rows.find((r) => r.label === 'kb.ingest')!
    expect(ingest.count).toBe(3)
    expect(ingest.maxMs).toBe(900)
    expect(ingest.lastAt).toBe(EPOCH + 1000)
  })

  it('偶数样本 p50 取下中位数（不插值、不虚高）', () => {
    const rows = summarizePerf([
      evt('kb.ingest', 100),
      evt('kb.ingest', 200),
      evt('kb.ingest', 300),
      evt('kb.ingest', 400)
    ])
    expect(rows[0]!.p50Ms).toBe(200)
  })

  it('排序：count 降序，同数按 maxMs 降序，超出 topLabels 截断', () => {
    const events: PerfEvent[] = [
      evt('a', 50),
      evt('a', 60),
      evt('b', 10),
      evt('b', 900),
      evt('c', 1),
      evt('d', 2),
      evt('e', 3),
      evt('f', 4)
    ]
    const rows = summarizePerf(events, 3)
    // a(2 次, max60) 与 b(2 次, max900) 同数 → b 在前；单次的按 max 降序取 f(4)
    expect(rows.map((r) => r.label)).toEqual(['b', 'a', 'f'])
    expect(summarizePerf(events, 0)).toEqual([])
  })

  it('按模型细分：样本数优先、同数按峰值，最多取 3 个模型', () => {
    const rows = summarizePerf([
      evt('chat.ttft', 6000, EPOCH, 'model=a'),
      evt('chat.ttft', 7000, EPOCH, 'model=b'),
      evt('chat.ttft', 8000, EPOCH, 'model=a'),
      evt('chat.ttft', 9000, EPOCH, 'model=c'),
      evt('chat.ttft', 9500, EPOCH, 'model=d')
    ])
    // a 两个样本排最前；其余按峰值降序取 d、c，b 被截掉
    expect(rows[0]!.byModel).toEqual([
      { model: 'a', count: 2, p50Ms: 6000, maxMs: 8000 },
      { model: 'd', count: 1, p50Ms: 9500, maxMs: 9500 },
      { model: 'c', count: 1, p50Ms: 9000, maxMs: 9000 }
    ])
    // 标签行仍是总数（模型维度只是细分，不该把样本丢掉）
    expect(rows[0]!.count).toBe(5)
  })

  it('detail 里没有 model= 时 byModel 为空数组（入库类事件没有模型维度）', () => {
    const rows = summarizePerf([evt('kb.ingest', 1200, EPOCH, 'file=a.pdf')])
    expect(rows[0]!.byModel).toEqual([])
  })

  it('agent 的 detail 带 step= 时仍只按 model= 归因', () => {
    const rows = summarizePerf([evt('agent.ttft', 6000, EPOCH, 'model=glm-4 step=2')])
    expect(rows[0]!.byModel).toEqual([{ model: 'glm-4', count: 1, p50Ms: 6000, maxMs: 6000 }])
  })

  it('空输入返回空数组（面板据此显示空态而不是 0 行表头）', () => {
    expect(summarizePerf([])).toEqual([])
  })
})
