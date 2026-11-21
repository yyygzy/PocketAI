// @vitest-environment node
// P3 共享数据根锁：同一时间只允许一个客户端写 data/；陈旧锁可接管；释放后可再拿。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = vi.hoisted(() => ({ tmp: '' }))
const savedEnv = process.env.POCKETAI_DATA_DIR
let mod: typeof import('../src/main/data-lock')

beforeEach(async () => {
  roots.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moxia-lock-'))
  process.env.POCKETAI_DATA_DIR = path.join(roots.tmp, 'data')
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getAppPath: () => roots.tmp,
      getPath: () => roots.tmp,
      getVersion: () => '1.3.0'
    }
  }))
  mod = await import('../src/main/data-lock')
})

afterEach(() => {
  fs.rmSync(roots.tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.POCKETAI_DATA_DIR
  else process.env.POCKETAI_DATA_DIR = savedEnv
})

describe('共享数据目录锁（P3）', () => {
  it('并发获取时第二个实例被拒绝，释放后可以再拿', () => {
    const first = mod.acquireDataLock()
    expect(first).not.toBeNull()
    expect(mod.acquireDataLock()).toBeNull()
    first!.release()
    const third = mod.acquireDataLock()
    expect(third).not.toBeNull()
    third!.release()
  })

  it('锁文件带平台/主机名/PID/心跳', () => {
    const lock = mod.acquireDataLock()!
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.POCKETAI_DATA_DIR!, '.lock'), 'utf8')) as Record<string, unknown>
    expect(raw.platform).toBe(process.platform)
    expect(typeof raw.hostname).toBe('string')
    expect(raw.pid).toBe(process.pid)
    expect(typeof raw.heartbeatAt).toBe('number')
    lock.release()
  })

  it('心跳超时的陈旧锁会被接管', () => {
    fs.mkdirSync(process.env.POCKETAI_DATA_DIR!, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.POCKETAI_DATA_DIR!, '.lock'),
      JSON.stringify({ platform: 'linux', hostname: 'old-machine', pid: 99999, startedAt: 1, heartbeatAt: Date.now() - 120_000 }),
      'utf8'
    )
    const lock = mod.acquireDataLock()
    expect(lock).not.toBeNull()
    lock!.release()
  })
})
