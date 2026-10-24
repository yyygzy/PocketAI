// quit-manager 退出流程测试
//
// 覆盖 src/main/quit-manager.ts：
// - isQuitting / requestQuit / beginQuit：标志位与 app.quit 触发
// - runCleanupChain：六步清理按序执行；各步抛错不中断后续
// - runFallbackCleanup：同步兜底全步骤（197 起也试一次 stopAll）// - runFallbackCleanup：同步兜底全步骤（不含 stopAll）
// - runCleanupOnce：幂等 + 总时限（超时放行退出，不让清理把退出钉住）
//
// 策略：vi.mock electron app 与五个依赖，用 calls 数组记录调用顺序
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  isQuitting,
  requestQuit,
  beginQuit,
  runCleanupChain,
  isCleanupDone,
  runCleanupOnce,
  runFallbackCleanup
} from '../src/main/quit-manager'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  stopAllError: null as Error | null,
  stopAllHang: false,
  cleanupError: null as Error | null,
  closeError: null as Error | null,
  quitCalls: 0,
  reset() {
    this.calls = []
    this.stopAllError = null
    this.stopAllHang = false
    this.cleanupError = null
    this.closeError = null
    this.quitCalls = 0
  }
}))

vi.mock('electron', () => ({
  app: {
    quit: () => { mocks.quitCalls++ },
    isPackaged: false,
    getPath: () => '',
    getAppPath: () => process.cwd()
  }
}))

vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: {
    stopAll: async () => {
      mocks.calls.push('stopAll')
      if (mocks.stopAllHang) await new Promise(() => { /* 永不 resolve：模拟子进程不应答 */ })
      if (mocks.stopAllError) throw mocks.stopAllError
    }
  }
}))

vi.mock('../src/main/ollama/ollama-runtime', () => ({
  ollamaRuntime: {
    abortPull: () => { mocks.calls.push('abortPull') },
    cleanup: () => {
      mocks.calls.push('cleanup')
      if (mocks.cleanupError) throw mocks.cleanupError
    }
  }
}))

vi.mock('../src/main/backup/backup-scheduler', () => ({
  stopBackupScheduler: () => { mocks.calls.push('stopBackupScheduler') }
}))

vi.mock('../src/main/backup/task-scheduler', () => ({
  stopTaskScheduler: () => { mocks.calls.push('stopTaskScheduler') }
}))

vi.mock('../src/main/reminder/scheduler', () => ({
  stopReminderScheduler: () => { mocks.calls.push('stopReminderScheduler') }
}))

vi.mock('../src/main/update-manager', () => ({
  updateManager: { cancelStartupCheck: () => { mocks.calls.push('cancelStartupCheck') } }
}))

vi.mock('../src/main/tools/shell-tools', () => ({
  killInFlightShellJobs: () => { mocks.calls.push('killInFlightShellJobs'); return 0 }
}))

vi.mock('../src/main/channels/channel-service', () => ({
  channelService: { stopAll: () => { mocks.calls.push('stopChannels') } }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    close: () => {
      mocks.calls.push('close')
      if (mocks.closeError) throw mocks.closeError
    }
  }
}))

vi.mock('../src/main/terminal/terminal-service', () => ({
  killAllTerminals: () => { mocks.calls.push('killAllTerminals') }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

beforeEach(() => mocks.reset())

describe('退出标志', () => {
  it('初始未退出：isQuitting 为 false', () => {
    expect(isQuitting()).toBe(false)
  })

  it('requestQuit：设标志并调 app.quit', () => {
    requestQuit()
    expect(isQuitting()).toBe(true)
    expect(mocks.quitCalls).toBe(1)
  })

  it('beginQuit：同样设标志并调 app.quit', () => {
    beginQuit()
    expect(isQuitting()).toBe(true)
    expect(mocks.quitCalls).toBe(1)
  })
})

describe('runCleanupChain 异步清理链', () => {
  it('按序执行十一步：abortPull → stopAll → cleanup → 撤更新器延迟检查 → 三个 scheduler → 终端与在途 shell → 停渠道网关 → close', async () => {
    await runCleanupChain()
    expect(mocks.calls).toEqual([
      'abortPull', 'stopAll', 'cleanup', 'cancelStartupCheck', 'stopBackupScheduler', 'stopTaskScheduler', 'stopReminderScheduler', 'killAllTerminals', 'killInFlightShellJobs', 'stopChannels', 'close'
    ])
  })

  it('stopAll 抛错：中断该步但后续步骤照常执行，不传播', async () => {
    mocks.stopAllError = new Error('MCP 停止失败')
    await expect(runCleanupChain()).resolves.toBeUndefined()
    expect(mocks.calls).toEqual([
      'abortPull', 'stopAll', 'cleanup', 'cancelStartupCheck', 'stopBackupScheduler', 'stopTaskScheduler', 'stopReminderScheduler', 'killAllTerminals', 'killInFlightShellJobs', 'stopChannels', 'close'
    ])
  })

  it('cleanup 抛错：后续仍执行', async () => {
    mocks.cleanupError = new Error('kill 树失败')
    await expect(runCleanupChain()).resolves.toBeUndefined()
    expect(mocks.calls[mocks.calls.length - 1]).toBe('close')
  })

  it('close 抛错：静默收尾，不传播', async () => {
    mocks.closeError = new Error('DB 关闭失败')
    await expect(runCleanupChain()).resolves.toBeUndefined()
    expect(mocks.calls).toContain('close')
  })

  it('三个 scheduler、在途 shell 的杀与停渠道网关都排在 close 之前（199/202/283：它们的清理都要读库、动进程表或断 socket）', async () => {
    await runCleanupChain()
    const closeAt = mocks.calls.indexOf('close')
    for (const s of ['stopBackupScheduler', 'stopTaskScheduler', 'stopReminderScheduler', 'killInFlightShellJobs', 'stopChannels']) {
      expect(mocks.calls.indexOf(s)).toBeGreaterThanOrEqual(0)
      expect(mocks.calls.indexOf(s)).toBeLessThan(closeAt)
    }
  })
})

describe('runFallbackCleanup 同步兜底', () => {
  it('兜底也试一次停 MCP（197）＋停渠道网关（283：别让 abort 不掉的自动重连留在退出半程）', () => {
    runFallbackCleanup()
    expect(mocks.calls).toEqual([
      'abortPull', 'cleanup', 'cancelStartupCheck', 'stopBackupScheduler', 'stopTaskScheduler', 'stopReminderScheduler', 'killAllTerminals', 'killInFlightShellJobs', 'stopAll', 'stopChannels', 'close'
    ])
  })

  it('cleanup / close 抛错：静默不传播', () => {
    mocks.cleanupError = new Error('x')
    mocks.closeError = new Error('y')
    expect(() => runFallbackCleanup()).not.toThrow()
  })
})

describe('runCleanupOnce（197：幂等 ＋ 总时限）', () => {
  it('跑完整条链后置位 isCleanupDone，第二次调用不再跑', async () => {
    expect(await runCleanupOnce(2000)).toBe('done')
    expect(isCleanupDone()).toBe(true)
    expect(mocks.calls).toEqual([
      'abortPull', 'stopAll', 'cleanup', 'cancelStartupCheck', 'stopBackupScheduler', 'stopTaskScheduler', 'stopReminderScheduler', 'killAllTerminals', 'killInFlightShellJobs', 'stopChannels', 'close'
    ])
    const n = mocks.calls.length
    expect(await runCleanupOnce(2000)).toBe('done')
    expect(mocks.calls.length).toBe(n)
  })

  it('stopAll 永不应答 ⇒ 超时返回 timeout，退出流程不被清理链钉住', async () => {
    vi.resetModules()
    mocks.reset()
    mocks.stopAllHang = true
    const mod = await import('../src/main/quit-manager')
    expect(await mod.runCleanupOnce(30)).toBe('timeout')
    expect(mod.isCleanupDone()).toBe(false)
    expect(mocks.calls).toContain('stopAll')
  })
})
