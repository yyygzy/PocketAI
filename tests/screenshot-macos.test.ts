// P1-4 第二刀：macOS 取图的权限预判与 desktopCapturer 接线（不依赖真机授权）。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  mediaStatus: 'granted' as string,
  sources: [] as Array<{ id: string; display_id: string; thumbnail: { toPNG: () => Buffer } }>
}))

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (_type: string) => state.mediaStatus
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => ({
      id: 42,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2
    })
  },
  desktopCapturer: {
    getSources: async (_opts: unknown) => state.sources
  }
}))

import { grabMacOSScreen, macCaptureTarget } from '../src/main/screenshot-macos'

beforeEach(() => {
  state.mediaStatus = 'granted'
  state.sources = [{
    id: 'screen:42:0',
    display_id: '42',
    thumbnail: { toPNG: () => Buffer.from('png-bytes') }
  }]
})

describe('macOS 捕获', () => {
  it('目标窗口退化为整屏，不借用 Windows HWND 口径', () => {
    expect(macCaptureTarget('window')).toBe('screen')
    expect(macCaptureTarget('region')).toBe('screen')
    expect(macCaptureTarget('screen')).toBe('screen')
  })

  it('屏幕录制权限被拒时给 permission 码，不假装拿到图', async () => {
    state.mediaStatus = 'denied'
    const r = await grabMacOSScreen('screen')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('permission')
      expect(r.detail).toContain('屏幕录制')
    }
  })

  it('授权后按 display.id 精确选源，返回 PNG 与 scaleFactor', async () => {
    state.sources = [
      { id: 'screen:99:0', display_id: '99', thumbnail: { toPNG: () => Buffer.from('other') } },
      { id: 'screen:42:0', display_id: '42', thumbnail: { toPNG: () => Buffer.from('right') } }
    ]
    const r = await grabMacOSScreen('screen')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.buffer.toString()).toBe('right')
      expect(r.scaleFactor).toBe(2)
      expect(r.width).toBe(2880)
      expect(r.height).toBe(1800)
    }
  })

  it('找不到对应源给 no-window；空缩略图给 empty', async () => {
    state.sources = []
    expect((await grabMacOSScreen('screen')).ok).toBe(false)
    state.sources = [{ id: 'screen:42:0', display_id: '42', thumbnail: { toPNG: () => Buffer.alloc(0) } }]
    const empty = await grabMacOSScreen('screen')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('empty')
  })
})
