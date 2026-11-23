// run_tests 工具回归：命令拼装、路径守卫、摘要解析、超时/错误。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const spawns: Array<{ cmd: string; args: string[]; cwd: string }> = []
  const cp = { impl: null as null | ((...a: unknown[]) => unknown) }
  return {
    store, spawns, cp,
    appConfigRepo: {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => { store.set(k, v) },
      delete: (k: string) => { store.delete(k) }
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('node:child_process', () => ({
  spawn: (...a: unknown[]) => mocks.cp.impl ? mocks.cp.impl(...a) : null
}))

function fakeChild(opts: { exitCode?: number; stdout?: string; error?: string; emitClose?: boolean } = {}) {
  const c = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter }
  c.pid = 12345
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  setTimeout(() => {
    if (opts.error) c.emit('error', new Error(opts.error))
    else {
      if (opts.stdout) c.stdout.emit('data', Buffer.from(opts.stdout))
      if (opts.emitClose !== false) c.emit('close', opts.exitCode ?? 0)
    }
  }, 0)
  return c
}

beforeEach(() => {
  mocks.store.clear()
  mocks.spawns.length = 0
  mocks.store.set('agent.workspace_dir', 'C:\\proj')
  mocks.cp.impl = (...a: unknown[]) => {
    const cmd = String(a[0])
    const args = (a[1] as string[]) ?? []
    mocks.spawns.push({ cmd, args, cwd: 'C:\\proj' })
    return fakeChild({ stdout: 'Test Files  1 passed (1)\nTests  7 passed (7)\n', exitCode: 0 })
  }
})

import { getRunTestsTools } from '../src/main/tools/run-tests'

const tool = () => getRunTestsTools()[0]!

describe('run_tests 工具', () => {
  it('默认跑全部：npx vitest run --reporter=dot，cwd 为工作目录', async () => {
    const out = await tool().execute({})
    expect(mocks.spawns).toHaveLength(1)
    const tail = process.platform === 'win32' ? mocks.spawns[0]!.args.slice(4) : mocks.spawns[0]!.args
    expect(tail).toEqual(['vitest', 'run', '--reporter=dot'])
    const r = JSON.parse(out)
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.files).toContain('1 passed')
    expect(r.tests).toContain('7 passed')
    expect(r.failed).toBe(false)
  })

  it('指定文件：按给定相对路径拼到命令里', async () => {
    await tool().execute({ files: ['tests/foo.test.ts', 'tests/bar.test.ts'] })
    const tail = process.platform === 'win32' ? mocks.spawns[0]!.args.slice(4) : mocks.spawns[0]!.args
    expect(tail).toEqual([
      'vitest', 'run', 'tests/foo.test.ts', 'tests/bar.test.ts', '--reporter=dot'
    ])
  })

  it('路径穿越 / 绝对路径 / 空路径 → 拒绝，不 spawn', async () => {
    for (const bad of [['../x.test.ts'], ['C:\\x.test.ts'], ['/abs/test.ts'], ['']]) {
      await expect(tool().execute({ files: bad })).rejects.toThrow()
    }
    expect(mocks.spawns).toHaveLength(0)
  })

  it('退出码非 0 → ok=false，failed 依据摘要', async () => {
    mocks.cp.impl = () => fakeChild({
      exitCode: 1,
      stdout: 'Test Files  1 failed (1)\nTests  2 failed | 5 passed (7)\n'
    })
    const r = JSON.parse(await tool().execute({}))
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(r.failed).toBe(true)
  })

  it('权限 auto、无需审批；未设工作目录时不注册', () => {
    expect(tool().schema.permission).toBe('auto')
    mocks.store.delete('agent.workspace_dir')
    expect(getRunTestsTools()).toHaveLength(0)
  })
})
