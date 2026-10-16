// 根错误边界（V4-Iter-146 / B81）
//
// 这条用例存在的理由是一条**实测事故**，不是预防性铺货：144 的真 Electron 自测里，
// 一次"拉取模型失败"把 `{ok:false}` 写进了 `editing.models`，下一帧 `.map()` 抛错 ⇒ **整屏空白**，
// 而当时全仓没有任何错误边界（grep ErrorBoundary / componentDidCatch 在 renderer 里零命中），
// 用户能看到的只有"打不开"三个字。所以这里钉三件事：
//  ① 子树抛错时给的是**可读的兜底屏**（带错误首行 + 重载），不是空 #root；
//  ② 错误没有 message 时也要兜住（`state.message !== null` 而不是真值判断）；
//  ③ 边界挂在 I18nProvider **之内**——否则兜底文案走不到四语字典。
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import fs from 'node:fs'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AppErrorBoundary } from '../src/renderer/src/components/AppErrorBoundary'
import { zh } from '../src/renderer/src/i18n/zh'

function Boom({ message }: { message?: string }): React.JSX.Element {
  const e = new Error(message ?? '拉取模型失败把对象写进了数组')
  e.stack = 'stack-line-1\nstack-line-2'
  throw e
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('抛错时给可读兜底屏', () => {
  it('子树抛错 ⇒ 出现标题、错误首行与重载按钮，且 #root 不是空的', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubPocketai({})
    mountWithProviders(
      <AppErrorBoundary>
        <div data-testid="sibling">本来要渲染的内容</div>
        <Boom />
      </AppErrorBoundary>
    )
    await waitFor(() => expect(screen.getByText(zh['crash.title'])).toBeTruthy())
    // 关键：错误首行原样显示出来。用户只会说"打不开"，这一行字就是我们能拿到的唯一线索
    expect(screen.getByText('拉取模型失败把对象写进了数组')).toBeTruthy()
    expect(document.getElementById('root')?.childElementCount ?? document.body.childElementCount).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: zh['crash.reload'] })).toBeTruthy()
    expect(errs).toHaveBeenCalled()
  })

  it('反向对照：不抛错时 children 照常渲染（边界不是永远显示兜底屏）', () => {
    stubPocketai({})
    mountWithProviders(
      <AppErrorBoundary>
        <div data-testid="sibling">本来要渲染的内容</div>
      </AppErrorBoundary>
    )
    expect(screen.getByTestId('sibling').textContent).toBe('本来要渲染的内容')
    expect(screen.queryByText(zh['crash.title'])).toBeNull()
  })

  it('错误没有 message 时也要兜住——真值判断会退回"整屏空白"这个本批要消灭的状态', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubPocketai({})
    mountWithProviders(
      <AppErrorBoundary>
        <Boom message="" />
      </AppErrorBoundary>
    )
    await waitFor(() => expect(screen.getByText(zh['crash.title'])).toBeTruthy())
    expect(errs).toHaveBeenCalled()
  })

  it('点重载 ⇒ 调 window.location.reload（不自动重试渲染：重试要清状态，那是另一套口径）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    const before = window.location
    Object.defineProperty(window, 'location', { value: { ...before, reload }, configurable: true })
    stubPocketai({})
    mountWithProviders(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    )
    await waitFor(() => expect(screen.getByRole('button', { name: zh['crash.reload'] })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: zh['crash.reload'] }))
    expect(reload).toHaveBeenCalledTimes(1)
    Object.defineProperty(window, 'location', { value: before, configurable: true })
  })
})

describe('挂载位置（源码 scan：这类"接错位置"只有整进程才暴露）', () => {
  const src = fs.readFileSync('src/renderer/src/main.tsx', 'utf8')

  it('AppErrorBoundary 在 I18nProvider **之内**（否则兜底文案走不到字典）', () => {
    const i18n = src.indexOf('<I18nProvider>')
    const boundary = src.indexOf('<AppErrorBoundary>')
    expect(i18n).toBeGreaterThan(-1)
    expect(boundary, 'main.tsx 没挂根错误边界').toBeGreaterThan(-1)
    expect(boundary).toBeGreaterThan(i18n)
  })

  it('import 里有 AppErrorBoundary（防止只在 JSX 里留着注释而实现被删）', () => {
    expect(src).toMatch(/import \{ AppErrorBoundary \} from '.\/components\/AppErrorBoundary'/)
  })
})
