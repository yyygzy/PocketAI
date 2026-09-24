// keep-awake 后台保活引用计数测试
//
// 覆盖 src/main/keep-awake.ts 的 acquireKeepAwake / releaseKeepAwake：
// powerSaveBlocker 引用计数——首次 acquire 启动，多次 acquire 不重复 start，
// release 递减，归零才真正 stop。
//
// 策略：mock electron powerSaveBlocker，捕获 start/stop 调用。
// 由于模块级状态（blockerId/refCount）跨用例持久，用 vi.resetModules + 动态 import 隔离。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const powerSaveBlocker = {
  start: vi.fn().mockReturnValue(42),
  stop: vi.fn()
}

vi.mock('electron', () => ({ powerSaveBlocker }))

beforeEach(() => {
  vi.resetModules()
  powerSaveBlocker.start.mockClear()
  powerSaveBlocker.stop.mockClear()
})

async function load() {
  const mod = await import('../src/main/keep-awake')
  return { acquire: mod.acquireKeepAwake, release: mod.releaseKeepAwake }
}

describe('keep-awake — powerSaveBlocker 引用计数', () => {
  it('首次 acquire → 调用 powerSaveBlocker.start', async () => {
    const { acquire } = await load()
    acquire()
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1)
  })

  it('连续多次 acquire → 只调用一次 start', async () => {
    const { acquire } = await load()
    acquire()
    acquire()
    acquire()
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1)
  })

  it('acquire 后 release → 不调用 stop（引用计数>0）', async () => {
    const { acquire, release } = await load()
    acquire()
    acquire()
    release()
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled()
  })

  it('release 到零 → 调用 stop', async () => {
    const { acquire, release } = await load()
    acquire()
    release()
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42)
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1)
  })

  it('多次 acquire 后全部 release → 归零才 stop 一次', async () => {
    const { acquire, release } = await load()
    acquire()
    acquire()
    acquire()
    release()
    release()
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled()
    release()
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1)
  })

  it('release 到零后再 acquire → 重新 start', async () => {
    const { acquire, release } = await load()
    acquire()
    release()
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1)
    acquire()
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2)
  })

  it('无 acquire 时 release → 不调用 stop', async () => {
    const { release } = await load()
    release()
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled()
  })

  it('过度 release（超过 acquire 次数）→ 不报错、不调用 stop', async () => {
    const { acquire, release } = await load()
    acquire()
    release()
    release()
    release()
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1)
  })
})
