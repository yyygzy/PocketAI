// 语言 chunk 失败后的重试语义（只钉这两件事，不碰闸门数字）：
//  1. 一次 import 失败不能把 rejected promise 钉死在 langPromises 里——第二次 ensureLang 必须真的重新加载；
//  2. Provider 的 effect 要接住拒绝（留日志、不产生未处理拒绝），界面继续走 zh 兜底。
// 注入方式：把 en 字典的导出做成 getter，用 state.failNext 控制下一次访问抛错。
// 不用 waitFor（避免动 tests/waitfor-gate-364 的 AWAIT_CAP）。
// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const state = vi.hoisted(() => ({
  // Vitest 包装 mock 导出时可能提前摸 getter，用 armed 把这次排除在失败开关外
  armed: false,
  loads: 0,
  failNext: false,
  alwaysFail: false
}))

vi.mock('../src/renderer/src/i18n/en', () => ({
  get en() {
    if (!state.armed) return { 'probe.lang': 'EN-OK' }
    state.loads += 1
    if (state.alwaysFail || state.failNext) {
      state.failNext = false
      throw new Error('语言 chunk 读取失败（测试注入）')
    }
    return { 'probe.lang': 'EN-OK' }
  }
}))

type I18nModule = typeof import('../src/renderer/src/i18n')

/** 每个用例拿一份全新的 i18n 模块（langPromises / dicts 都是模块级状态） */
async function freshI18n(): Promise<I18nModule> {
  vi.resetModules()
  return import('../src/renderer/src/i18n')
}

function makeProbe(useI18n: I18nModule['useI18n']) {
  return function Probe(): React.JSX.Element {
    const { t } = useI18n()
    return <span data-testid="probe">{t('probe.lang')}</span>
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('pocketai.lang', 'en')
  state.armed = true
  state.loads = 0
  state.failNext = false
  state.alwaysFail = false
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('语言 chunk 失败后的重试', () => {
  it('第一次加载失败后，第二次 ensureLang 重新 import 并成功', async () => {
    state.failNext = true
    const mod = await freshI18n()

    await mod.preloadInitialLang(150)
    expect(state.loads).toBe(1)

    // 旧实现会把第一次的 rejected promise 缓存下来，第二次不会真正加载
    await mod.preloadInitialLang(150)
    expect(state.loads).toBe(2)

    const Probe = makeProbe(mod.useI18n)
    render(
      <mod.I18nProvider>
        <Probe />
      </mod.I18nProvider>
    )
    expect(screen.getByTestId('probe').textContent).toBe('EN-OK')
  })

  it('持续失败时 Provider 接住拒绝、留一条日志，界面停在 zh 兜底', async () => {
    state.alwaysFail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await freshI18n()

    const Probe = makeProbe(mod.useI18n)
    render(
      <mod.I18nProvider>
        <Probe />
      </mod.I18nProvider>
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('probe').textContent).toBe('probe.lang')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('i18n.ensureLang'))).toBe(true)
  })
})
