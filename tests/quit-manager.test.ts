// quit-manager 退出流程测试
//
// 覆盖 src/main/quit-manager.ts：
// - isQuitting / requestQuit / beginQuit：标志位与 app.quit 触发
// - runCleanupChain：六步清理按序执行；各步抛错不中断后续
// - runFallbackCleanup：同步兜底全步骤（不含 stopAll）
//
// 策略：vi.mock electron app 与五个依赖，用 calls 数组记录调用顺序
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  isQuitting,
  requestQuit,
  beginQuit,
  runCleanupChain,
  runFallbackCleanup
} from '../src/main/quit-manager'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  stopAllError: null as Error | null,
  cleanupError: null as Error | null,
  closeError: null as Error | null,
  quitCalls: 0,
  reset() {
    this.calls = []
    this.stopAllError = null
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
  it('按序执行七步：abortPull → stopAll → cleanup → 两个 scheduler → killAllTerminals → close', async () => {
    await runCleanupChain()
    expect(mocks.calls).toEqual([
      'abortPull', 'stopAll', 'cleanup', 'stopBackupScheduler', 'stopTaskScheduler', 'killAllTerminals', 'close'
    ])
  })

  it('stopAll 抛错：中断该步但后续步骤照常执行，不传播', async () => {
    mocks.stopAllError = new Error('MCP 停止失败')
    await expect(runCleanupChain()).resolves.toBeUndefined()
    expect(mocks.calls).toEqual([
      'abortPull', 'stopAll', 'cleanup', 'stopBackupScheduler', 'stopTaskScheduler', 'killAllTerminals', 'close'
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
})

describe('runFallbackCleanup 同步兜底', () => {
  it('执行除 stopAll 外的全部步骤', () => {
    runFallbackCleanup()
    expect(mocks.calls).toEqual([
      'abortPull', 'cleanup', 'stopBackupScheduler', 'stopTaskScheduler', 'killAllTerminals', 'close'
    ])
  })

  it('cleanup / close 抛错：静默不传播', () => {
    mocks.cleanupError = new Error('x')
    mocks.closeError = new Error('y')
    expect(() => runFallbackCleanup()).not.toThrow()
  })
})
