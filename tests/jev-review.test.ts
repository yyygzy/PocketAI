// Jev 语义审核增强回归：默认关/开关读写/阈值/以及最重要的 fail-open。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const { state, runMock } = vi.hoisted(() => ({
  state: { store: new Map<string, string>() },
  runMock: { fn: null as null | ((r: unknown) => Promise<unknown>) }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => state.store.get(k) ?? null,
    set: (k: string, v: string) => { state.store.set(k, v) }
  }
}))
vi.mock('../src/main/ollama/systemone', () => ({
  runSystemOne: (r: unknown) => runMock.fn ? runMock.fn(r) : Promise.reject(new Error('no mock'))
}))

import {
  isJevReviewEnabled, setJevReviewEnabled, getJevModel, setJevModel,
  getJevThreshold, setJevThreshold, getJevReviewPrefs, JEV_DEFAULT_MODEL, JEV_DEFAULT_THRESHOLD
} from '../src/main/agent/jev-review-prefs'
import { reviewToolCall } from '../src/main/agent/jev-review'

beforeEach(() => {
  state.store.clear()
  runMock.fn = null
})

describe('Jev 审核配置', () => {
  it('默认关闭，模型/阈值走默认值', () => {
    expect(isJevReviewEnabled()).toBe(false)
    expect(getJevModel()).toBe(JEV_DEFAULT_MODEL)
    expect(getJevThreshold()).toBe(JEV_DEFAULT_THRESHOLD)
  })

  it('开关读写；模型空串回默认、非法值拒绝不改库；阈值值域 0-1', () => {
    setJevReviewEnabled(true)
    expect(isJevReviewEnabled()).toBe(true)
    expect(setJevModel('')).toBe(JEV_DEFAULT_MODEL)
    expect(setJevModel('nimble:9b')).toBe('nimble:9b')
    expect(setJevModel('bad model')).toBeNull()
    expect(getJevModel()).toBe('nimble:9b')
    expect(setJevThreshold(0.85)).toBe(0.85)
    expect(setJevThreshold(1.5)).toBeNull()
    expect(getJevThreshold()).toBe(0.85)
    expect(getJevReviewPrefs()).toEqual({ enabled: true, model: 'nimble:9b', threshold: 0.85 })
  })
})

describe('reviewToolCall fail-open', () => {
  it('开关关 ⇒ 不发决策请求，直接 passthrough', async () => {
    let called = false
    runMock.fn = async () => { called = true; return { model: 'x', answers: {} } }
    const r = await reviewToolCall({ toolName: 'shell.exec', argsSummary: 'rm -rf /' })
    expect(called).toBe(false)
    expect(r.decision).toBe('passthrough')
    expect(r.reason).toBe('disabled')
  })

  it('score 按三档归一化到 0-1 再比阈值：超阈值 ⇒ confirm', async () => {
    setJevReviewEnabled(true)
    setJevThreshold(0.7)
    // 三档加权分范围 0-2；1.6/2=0.8 ≥ 0.7 ⇒ confirm
    runMock.fn = async () => ({ model: 'x', answers: { risk: { type: 'score', score: 1.6 } } })
    const high = await reviewToolCall({ toolName: 'shell.exec', argsSummary: 'x' })
    expect(high.decision).toBe('confirm')
    expect(high.score).toBeCloseTo(0.8)
  })

  it('归一化后低于阈值 ⇒ passthrough（实测 tev1:0.8b 的 1.07 → 0.535）', async () => {
    setJevReviewEnabled(true)
    setJevThreshold(0.7)
    runMock.fn = async () => ({ model: 'x', answers: { risk: { type: 'score', score: 1.07 } } })
    const r = await reviewToolCall({ toolName: 'shell.exec', argsSummary: 'x' })
    expect(r.decision).toBe('passthrough')
    expect(r.score).toBeCloseTo(0.535)
  })

  it('决策请求抛错（服务没跑/模型没拉）⇒ fail-open passthrough，不抛给调用方', async () => {
    setJevReviewEnabled(true)
    runMock.fn = async () => { throw new Error('model not found') }
    const r = await reviewToolCall({ toolName: 'shell.exec', argsSummary: 'x' })
    expect(r.decision).toBe('passthrough')
    expect(r.reason).toBe('error')
  })

  it('返回结构坏（无 risk/非 score/非数）⇒ fail-open passthrough', async () => {
    setJevReviewEnabled(true)
    for (const bad of [
      { model: 'x', answers: {} },
      { model: 'x', answers: { risk: { type: 'choice', choice: 'a' } } },
      { model: 'x', answers: { risk: { type: 'score', score: 'NaN' } } }
    ]) {
      runMock.fn = async () => bad
      expect((await reviewToolCall({ toolName: 'x', argsSummary: 'x' })).decision).toBe('passthrough')
    }
  })
})

describe('引擎接入形状（源码闸门）', () => {
  const engine = readFileSync('src/main/agent/engine.ts', 'utf8')

  it('Jev 只升级 allow：默认判定仍是规则式，升级为 confirm 走现成审批', () => {
    expect(engine).toContain("import { reviewToolCall } from './jev-review'")
    expect(engine).toMatch(/decision: 'confirm' as const, reason: 'JEV_RISK'/)
    expect(engine).toMatch(/jevUpgraded\.has\(i\)/)
    // fail-open 判据在模块里：失败返回 passthrough，不抛
    const mod = readFileSync('src/main/agent/jev-review.ts', 'utf8')
    expect(mod).toContain("decision: 'passthrough'")
  })

  it('不碰 deny/原 confirm 分支，也不改路由（§237 自动路由仍不启用）', () => {
    expect(engine).toContain("if (classifications[idx]!.decision !== 'allow') return false")
  })
})
