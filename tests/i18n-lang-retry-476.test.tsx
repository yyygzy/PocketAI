// 语言 chunk 失败后的重试语义（只钉这两件事，不碰闸门数字）：
//  1. 浏览器 module map 按 URL 缓存失败：同一 URL 第二次 import 仍会失败，所以重试必须换 URL；
//  2. Provider / setLang 要接住拒绝（留日志、不产生未处理拒绝），界面继续走 zh 兜底，
//     同语言重试成功后必须自己补一次渲染。
// 注入方式：mock chunk-loader，用「URL → 已失败」集合模拟浏览器的真实缓存形状。
// 不用 waitFor（避免动 tests/waitfor-gate-364 的 AWAIT_CAP）。
// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const state = vi.hoisted(() => ({
  loads: 0,
  urls: [] as string[],
  // 模拟浏览器 module map：失败过的 URL 在世界里永久失败
  failedUrls: new Set<string>(),
  breakOnce: false,
  alwaysFail: false
}))

vi.mock('../src/renderer/src/i18n/chunk-loader', () => ({
  buildLocaleChunkUrl: (lang: string, attempt: number) => `test://i18n/${lang}.js?retry=${attempt}`,
  importLocaleChunk: async (url: string) => {
    state.loads += 1
    state.urls.push(url)
    if (state.alwaysFail || state.breakOnce || state.failedUrls.has(url)) {
      state.breakOnce = false
      state.failedUrls.add(url)
      throw new Error(`语言 chunk 读取失败（测试注入）：${url}`)
    }
    return {
      en: { 'probe.lang': 'EN-OK' },
      ja: { 'probe.lang': 'JA-OK' },
      ko: { 'probe.lang': 'KO-OK' }
    }
  }
}))

type I18nModule = typeof import('../src/renderer/src/i18n')

/** 每个用例拿一份全新的 i18n 模块（langPromises / dicts / attempts 都是模块级状态） */
async function freshI18n(): Promise<I18nModule> {
  vi.resetModules()
  return import('../src/renderer/src/i18n')
}

function makeProbe(useI18n: I18nModule['useI18n'], onSetLang?: (setLang: (l: 'en' | 'zh') => void) => void) {
  return function Probe(): React.JSX.Element {
    const { t, setLang } = useI18n()
    onSetLang?.(setLang)
    return <span data-testid="probe">{t('probe.lang')}</span>
  }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('pocketai.lang', 'en')
  state.loads = 0
  state.urls = []
  state.failedUrls.clear()
  state.breakOnce = false
  state.alwaysFail = false
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('语言 chunk 失败后的重试', () => {
  it('第一次失败后，下一次 ensureLang 换新 URL 重新加载（同 URL 会被 module map 钉死）', async () => {
    state.breakOnce = true
    const mod = await freshI18n()

    await mod.preloadInitialLang(150)
    expect(state.loads).toBe(1)
    expect(state.urls[0]).toContain('retry=0')

    await mod.preloadInitialLang(150)
    expect(state.loads).toBe(2)
    // 关键：第二次必须换 URL；若仍用 retry=0，模拟缓存会再次拒绝，下面的渲染断言会失败
    expect(state.urls[1]).not.toBe(state.urls[0])
    expect(new Set(state.urls).size).toBe(2)

    const Probe = makeProbe(mod.useI18n)
    render(
      <mod.I18nProvider>
        <Probe />
      </mod.I18nProvider>
    )
    await flush()
    expect(screen.getByTestId('probe').textContent).toBe('EN-OK')
  })

  it('持续失败时 Provider 接住拒绝、留一条日志，界面停在 zh 兜底且无未处理拒绝', async () => {
    state.alwaysFail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onReject = vi.fn()
    window.addEventListener('unhandledrejection', onReject)
    const mod = await freshI18n()

    const Probe = makeProbe(mod.useI18n)
    render(
      <mod.I18nProvider>
        <Probe />
      </mod.I18nProvider>
    )
    await flush()
    await flush()

    expect(screen.getByTestId('probe').textContent).toBe('probe.lang')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('i18n.ensureLang'))).toBe(true)
    expect(onReject).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', onReject)
  })

  it('同语言再切一次：chunk 恢复后换新 URL 加载成功并立即重渲染，不用重启窗口', async () => {
    state.breakOnce = true
    const mod = await freshI18n()

    let setLangRef: ((l: 'en' | 'zh') => void) | null = null
    const Probe = makeProbe(mod.useI18n, (setLang) => {
      setLangRef = setLang as (l: 'en' | 'zh') => void
    })
    render(
      <mod.I18nProvider>
        <Probe />
      </mod.I18nProvider>
    )
    await flush()
    // 首次加载失败 → zh 兜底
    expect(screen.getByTestId('probe').textContent).toBe('probe.lang')

    // 用户再点一次 English（lang 不变）：必须重新发起加载并渲染成英文
    await act(async () => {
      setLangRef?.('en')
    })
    await flush()

    expect(state.loads).toBe(2)
    expect(new Set(state.urls).size).toBe(2)
    expect(screen.getByTestId('probe').textContent).toBe('EN-OK')
  })
})
