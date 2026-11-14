// P1-4 截图修复回归（缺陷 A：浮窗隐藏与截图竞态 + 黑帧识别）
//
// 真机定位（2026-11-14，Windows 11 / 250% 缩放）：
//  - 浮窗可见时按热键/点 📷，截到的是一张 1100×1500 的**全黑**图（正好是被隐藏的浮窗尺寸）。
//  - 外部探针连续采样证明：`win.hide()` 之后 GetForegroundWindow 一直返回**已隐藏**的浮窗
//    （IsWindowVisible=False，2s 内不变）——所以"隐藏后等前台换人再截"这条路在 Windows 上不成立。
// 修法：把浮窗 HWND 交给捕获脚本，脚本发现"前台仍是浮窗"就用命中测试取浮窗正下方的窗口；
//       并对 PrintWindow 的黑帧做识别，黑图不再当成功。
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => require('node:os').tmpdir(),
    getAppPath: () => process.cwd()
  },
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => (globalThis as { __shotSize?: { width: number; height: number } }).__shotSize ?? { width: 4, height: 4 },
      toBitmap: () => (globalThis as { __shotBitmap?: Buffer }).__shotBitmap ?? Buffer.alloc(0),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
      toJPEG: () => Buffer.from('fakejpeg')
    })
  }
}))

import { buildScript, encodeCapture, isNearBlackImage, popupHwndString } from '../src/main/screenshot'

type ShotGlobal = { __shotBitmap?: Buffer; __shotSize?: { width: number; height: number } }

/** 纯黑 BGRA（alpha=255）：隐藏/受保护窗口经 PrintWindow 的典型输出 */
function blackBitmap(w = 64, h = 64): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) buf[i * 4 + 3] = 255
  return buf
}

function normalBitmap(w = 64, h = 64): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = 180
    buf[i * 4 + 1] = 180
    buf[i * 4 + 2] = 180
    buf[i * 4 + 3] = 255
  }
  return buf
}

describe('A：浮窗可见时的捕获不再产出黑帧', () => {
  it('纯黑位图按失败上报（code=black），不再当成功附件', () => {
    ;(globalThis as ShotGlobal).__shotSize = { width: 64, height: 64 }
    ;(globalThis as ShotGlobal).__shotBitmap = blackBitmap()
    const r = encodeCapture('window', Buffer.from('png'), new Date())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('black')
  })

  it('正常画面仍按成功返回（黑帧识别不误伤）', () => {
    ;(globalThis as ShotGlobal).__shotSize = { width: 64, height: 64 }
    ;(globalThis as ShotGlobal).__shotBitmap = normalBitmap()
    const r = encodeCapture('window', Buffer.from('png'), new Date())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.attachment.name).toMatch(/^moxia-window-\d{8}-\d{6}\.png$/)
      expect(r.width).toBe(64)
    }
  })

  it('采样点里只要有一个非黑像素就不算黑帧（深色主题不误判）', () => {
    ;(globalThis as ShotGlobal).__shotSize = { width: 64, height: 64 }
    const bmp = blackBitmap()
    bmp[0] = 250
    bmp[1] = 250
    bmp[2] = 250
    expect(isNearBlackImage({ getSize: () => ({ width: 64, height: 64 }), toBitmap: () => bmp } as never)).toBe(false)
    expect(isNearBlackImage({ getSize: () => ({ width: 64, height: 64 }), toBitmap: () => blackBitmap() } as never)).toBe(true)
  })

  it('抓图脚本按浮窗句柄做命中测试（不是"等前台变化"）', () => {
    const script = buildScript('window', 'C:\\tmp\\moxia-shot.png', '4242')
    expect(script).toContain("$popupArg = '4242'")
    expect(script).toContain('WindowFromPoint')
    expect(script).toContain('GetAncestor')
    expect(script).toContain('IsWindowVisible')
    // 桌面/任务栏不算窗口
    expect(script).toContain('Shell_TrayWnd')
    expect(script).not.toContain('Start-Sleep -Milliseconds 200')
  })

  it('没有浮窗句柄时保持原行为（前台窗口）', () => {
    const script = buildScript('window', 'C:\\tmp\\moxia-shot.png')
    expect(script).toContain("$popupArg = ''")
  })

  it('浮窗 HWND 取十进制字符串；已销毁/空窗口返回 undefined', () => {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(4242n, 0)
    expect(popupHwndString({ isDestroyed: () => false, getNativeWindowHandle: () => buf })).toBe('4242')
    expect(popupHwndString({ isDestroyed: () => true, getNativeWindowHandle: () => buf })).toBeUndefined()
    expect(popupHwndString(null)).toBeUndefined()
  })
})
