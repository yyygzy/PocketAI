// 跨会话慢事件聚合：日志行 → 面板可用的统计行
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ readLogTail: vi.fn<() => string[]>(() => []) }))
vi.mock('../src/main/logger', () => ({ readLogTail: h.readLogTail }))

import { getPerfHistory } from '../src/main/steward/perf-history'

const T = '2026-10-10 08:12:34'

beforeEach(() => {
  h.readLogTail.mockReset()
  h.readLogTail.mockReturnValue([])
})

describe('getPerfHistory', () => {
  it('同名标签跨行合并计数，取到中位数与峰值', () => {
    h.readLogTail.mockReturnValue([
      `${T} INFO  [perf] [perf] kb.ingest: 1000ms | file=a.pdf`,
      `${T} INFO  [perf] [perf] kb.ingest: 3000ms | file=b.pdf`,
      `${T} INFO  [perf] [perf] kb.retrieve: 800ms`
    ])
    const rows = getPerfHistory()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.label).toBe('kb.ingest')
    expect(rows[0]!.count).toBe(2)
    expect(rows[0]!.maxMs).toBe(3000)
  })

  it('只外传统计行：日志原文（含用户数据）不出现在结果里', () => {
    h.readLogTail.mockReturnValue([
      `${T} INFO  [chat] 用户问题：我上周让你写的那份报告在哪里`,
      `${T} WARN  [backup] 备份失败：路径 C:\\Users\\某某\\secret.txt`,
      `${T} INFO  [perf] [perf] kb.ingest: 5000ms | file=季度报告.pdf`
    ])
    const rows = getPerfHistory()
    expect(rows.map((r) => r.label)).toEqual(['kb.ingest'])
    const json = JSON.stringify(rows)
    expect(json).not.toContain('用户问题')
    expect(json).not.toContain('secret.txt')
    expect(json).not.toContain('季度报告')
  })

  it('DEBUG 级快操作不入统计（开发环境日志会同时落两类行）', () => {
    h.readLogTail.mockReturnValue([
      `${T} DEBUG [perf] [perf] kb.retrieve: 30ms`,
      `${T} DEBUG [perf] [perf] kb.retrieve: 40ms`
    ])
    expect(getPerfHistory()).toEqual([])
  })

  it('日志不可读时返回空数组而不是抛错（面板只是少一块数据）', () => {
    h.readLogTail.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(getPerfHistory()).toEqual([])
  })
})
