// @vitest-environment jsdom
// P1-4 第三刀：主窗 Composer 的截图入口。
//
// 只做 window/screen：region 仍在浮窗会话里完成，主窗不复制框选叠层（会把浮窗铺屏并抢焦点）。
// 这里钉的是「+ → 截图 → 目标」这条链路：调用主进程截图、图片进既有附件栏、可删、
// 失败原因上屏、全程不自发送。
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ChatAttachment } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const BUDGET = { timeout: 8000, interval: 50 }

const shot = (name: string): ChatAttachment => ({
  type: 'image',
  name,
  mimeType: 'image/png',
  size: 1024,
  data: 'data:image/png;base64,QUJD'
})

beforeAll(() => {
  Element.prototype.scrollIntoView = () => { /* jsdom 没有布局 */ }
})

function mount(onSend = vi.fn()): void {
  stubPocketai({
    // 「+」一打开就惰性拉片段清单（Composer 既有行为），本批不判它但要给空实现
    listPromptSnippets: () => [],
    captureScreenshot: (target: string) => ({
      ok: true,
      target,
      width: 1280,
      height: 720,
      attachment: shot(`${target}-shot.png`)
    })
  })
  mountWithProviders(
    <Composer
      streaming={false}
      canSend
      onSend={onSend}
      onStop={() => { /* 本批不判停止 */ }}
      draftKey="conv-shot"
    />
  )
}

async function openScreenshotView(): Promise<void> {
  fireEvent.click(screen.getByTestId('composer-plus-open'))
  fireEvent.click(await screen.findByTestId('composer-plus-screenshot', {}, BUDGET))
}

describe('P1-4 ③ 主窗 Composer 截图入口', () => {
  it('当前窗口 ⇒ 调 captureScreenshot(window)，图片进附件栏且不自发送', async () => {
    const onSend = vi.fn()
    mount(onSend)

    await openScreenshotView()
    // 主窗这条路只给 window/screen；region 仍归浮窗会话，不在主窗复制叠层
    expect(screen.queryByTestId('composer-plus-capture-region')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-plus-capture-window'))

    await screen.findByAltText('window-shot.png', {}, BUDGET)
    const calls = pocketaiCalls().filter((c) => c.fn === 'captureScreenshot')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toBe('window')
    expect(screen.queryByTestId('composer-plus-menu')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('整个屏幕 ⇒ 调 captureScreenshot(screen)，附件可删', async () => {
    mount()

    await openScreenshotView()
    fireEvent.click(screen.getByTestId('composer-plus-capture-screen'))

    const img = await screen.findByAltText('screen-shot.png', {}, BUDGET)
    const calls = pocketaiCalls().filter((c) => c.fn === 'captureScreenshot')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toBe('screen')

    fireEvent.click(img.parentElement!.querySelector('button')!)
    await waitFor(() => expect(screen.queryByAltText('screen-shot.png')).toBeNull(), BUDGET)
    expect(pocketaiCalls().some((c) => c.fn === 'sendMessage')).toBe(false)
  })

  it('失败原因码 ⇒ 可读提示上屏，不留半张附件', async () => {
    stubPocketai({
      listPromptSnippets: () => [],
      captureScreenshot: () => ({ ok: false, code: 'permission' })
    })
    mountWithProviders(
      <Composer
        streaming={false}
        canSend
        onSend={() => { /* 本批不判发送 */ }}
        onStop={() => { /* 本批不判停止 */ }}
        draftKey="conv-shot-fail"
      />
    )

    await openScreenshotView()
    fireEvent.click(screen.getByTestId('composer-plus-capture-screen'))

    await waitFor(() => {
      const texts = screen.getAllByRole('status').map((e) => e.textContent ?? '').join(' ')
      expect(texts).toContain(L('popup.capture.err.permission'))
      expect(screen.queryByAltText('screen-shot.png')).toBeNull()
    }, BUDGET)
  })
})
