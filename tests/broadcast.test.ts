// broadcast 广播函数测试
//
// 覆盖 src/main/ipc/broadcast.ts：
// 向所有存活窗口广播、过滤已销毁窗口/已销毁 webContents/缺失 webContents、
// 单窗口 send 异常不中断其它窗口且不向调用方冒泡。
//
// 策略：mock electron 的 BrowserWindow.getAllWindows；broadcast 无模块级状态，
// 用 vi.hoisted 持有窗口数组，每用例重置。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ windows: [] as unknown[] }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))
// broadcast 依赖 logger（创建文件日志句柄），测试环境 mock 掉
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { broadcast } from '../src/main/ipc/broadcast'

interface MockWin {
  isDestroyed: () => boolean
  webContents?: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
}

function makeWin(
  opts: { destroyed?: boolean; noWC?: boolean; wcDestroyed?: boolean; sendThrows?: boolean } = {}
): MockWin {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: opts.noWC
      ? undefined
      : {
          isDestroyed: () => opts.wcDestroyed ?? false,
          send: opts.sendThrows
            ? vi.fn(() => {
                throw new Error('send boom')
              })
            : vi.fn()
        }
  }
}

beforeEach(() => {
  mocks.windows.length = 0
})

describe('broadcast — 向存活窗口广播', () => {
  it('无窗口时不抛错、零 send', () => {
    expect(() => broadcast('evt', { a: 1 })).not.toThrow()
  })

  it('单窗口存活 → send 收到正确的 channel 与 data', () => {
    const win = makeWin()
    mocks.windows.push(win)
    broadcast('state:updated', { count: 3 })
    expect(win.webContents!.send).toHaveBeenCalledExactlyOnceWith('state:updated', { count: 3 })
  })

  it('多窗口 → 全部收到广播', () => {
    const w1 = makeWin()
    const w2 = makeWin()
    mocks.windows.push(w1, w2)
    broadcast('evt', 'x')
    expect(w1.webContents!.send).toHaveBeenCalledExactlyOnceWith('evt', 'x')
    expect(w2.webContents!.send).toHaveBeenCalledExactlyOnceWith('evt', 'x')
  })

  it('已销毁窗口（isDestroyed）被跳过', () => {
    const dead = makeWin({ destroyed: true })
    const alive = makeWin()
    mocks.windows.push(dead, alive)
    broadcast('evt', 1)
    expect(alive.webContents!.send).toHaveBeenCalledOnce()
    // 死窗口根本不该碰 webContents.send
    expect(dead.webContents!.send).not.toHaveBeenCalled()
  })

  it('webContents 已销毁的窗口被跳过', () => {
    const win = makeWin({ wcDestroyed: true })
    mocks.windows.push(win)
    broadcast('evt', 1)
    expect(win.webContents!.send).not.toHaveBeenCalled()
  })

  it('webContents 缺失（undefined）的窗口被跳过', () => {
    const win = makeWin({ noWC: true })
    mocks.windows.push(win)
    expect(() => broadcast('evt', 1)).not.toThrow()
  })

  it('单窗口 send 抛错（销毁竞态）→ 其它窗口仍收到，且不向调用方冒泡', () => {
    const bad = makeWin({ sendThrows: true })
    const good = makeWin()
    mocks.windows.push(bad, good)
    expect(() => broadcast('evt', 1)).not.toThrow()
    expect(bad.webContents!.send).toHaveBeenCalledOnce()
    expect(good.webContents!.send).toHaveBeenCalledOnce()
  })

  it('全部窗口 send 都抛错也不冒泡', () => {
    mocks.windows.push(makeWin({ sendThrows: true }), makeWin({ sendThrows: true }))
    expect(() => broadcast('evt', 1)).not.toThrow()
  })
})
