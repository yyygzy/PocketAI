// 系统通知的锁屏闸门（V4-Iter-198）：通知面自己判锁 ＋ 全项目通知点扫描
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { notificationCtorMock, notificationShowMock, winShowMock, logInfoMock } =
  vi.hoisted(() => ({
    notificationCtorMock: vi.fn(),
    notificationShowMock: vi.fn(),
    winShowMock: vi.fn(),
    logInfoMock: vi.fn()
  }))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    constructor(opts: unknown) {
      notificationCtorMock(opts)
    }
    on(): void {}
    show(): void {
      notificationShowMock()
    }
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [{ isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: winShowMock, focus: vi.fn(), __pocketaiMainWindow: true }]
    }
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => '1', set: vi.fn() }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: logInfoMock, warn: vi.fn(), error: vi.fn() })
}))

import { showReplyNotification } from '../src/main/notify/reply-notify'
import { shouldSuppressNotification } from '../src/main/notify/lock-quiet'
import { lockService } from '../src/main/lock/lock'

beforeEach(() => {
  lockService.unlock()
  notificationCtorMock.mockClear()
  notificationShowMock.mockClear()
  winShowMock.mockClear()
  logInfoMock.mockClear()
})

afterEach(() => {
  lockService.unlock()
})

describe('回复完成通知的锁屏闸门', () => {
  it('解锁：标题与正文原样交给 OS 通知面', () => {
    showReplyNotification('翻译', '正文摘要')
    expect(notificationCtorMock).toHaveBeenCalledWith({ title: '翻译', body: '正文摘要' })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(logInfoMock).not.toHaveBeenCalled()
  })

  it('锁屏：一个 Notification 都不构造（内容不出门，而不是构造了不 show）', () => {
    lockService.lock('manual')
    showReplyNotification('翻译', '正文摘要')
    expect(notificationCtorMock).not.toHaveBeenCalled()
    expect(notificationShowMock).not.toHaveBeenCalled()
    expect(logInfoMock).toHaveBeenCalledWith('锁屏期间未弹回复通知')
  })

  it('锁屏丢掉的那条不在解锁后补发（回复本来就在会话里，通知只是"叫你回来"）', () => {
    lockService.lock('manual')
    showReplyNotification('翻译', 'a')
    lockService.unlock()
    showReplyNotification('翻译', 'b')
    expect(notificationCtorMock.mock.calls.map((c) => (c[0] as { body: string }).body)).toEqual(['b'])
  })

  it('提醒正文同样的道理：调度器的锁屏判据取自同一个函数，不各写一份', () => {
    expect(shouldSuppressNotification()).toBe(false)
    lockService.lock('auto-timeout')
    expect(shouldSuppressNotification()).toBe(true)
    lockService.unlock()
    expect(shouldSuppressNotification()).toBe(false)
  })
})

describe('全项目 OS 通知点扫描（形状扫描）', () => {
  const srcMain = path.resolve(__dirname, '../src/main')

  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return tsFiles(p)
      return e.isFile() && p.endsWith('.ts') ? [p] : []
    })
  }

  // 只扫代码行：判据关心的是"谁真的构造了通知"，注释里提到这个词不该算一个通知点
  function codeOnly(file: string): string {
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
  }

  const sites = tsFiles(srcMain)
    .filter((f) => codeOnly(f).includes('new Notification('))
    .map((f) => path.relative(srcMain, f).split(path.sep).join('/'))
    .sort()

  it('构造系统通知的文件只有这两个（新增第三个通知点要先过锁屏判据）', () => {
    expect(sites).toEqual(['notify/reply-notify.ts', 'reminder/scheduler.ts'])
  })

  it('每个通知点都自己引用锁屏判据，不依赖调用方替它挡', () => {
    for (const rel of sites) {
      expect(fs.readFileSync(path.join(srcMain, rel), 'utf-8')).toContain('lock-quiet')
    }
  })
})
