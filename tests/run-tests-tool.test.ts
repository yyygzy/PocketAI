// run_tests 工具回归：命令拼装、路径守卫、摘要解析、超时/错误。
// SEC-16-01 起：不再经 cmd.exe / npx 执行，改为 process.execPath 直跑 vitest.mjs
// （ELECTRON_RUN_AS_NODE=1），files 作为独立 argv 传递，元字符永远 inert。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const spawns: Array<{
    cmd: string
    args: string[]
    opts: { cwd?: string; env?: Record<string, string | undefined> }
  }> = []
  const existsMap = new Map<string, boolean>()
  const cp = { impl: null as null | ((...a: unknown[]) => unknown) }
  return {
    store,
    spawns,
    existsMap,
    cp,
    appConfigRepo: {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => { store.set(k, v) },
      delete: (k: string) => { store.delete(k) }
    },
    fs: {
      // run-tests 只用 existsSync 探测 vitest.mjs；realpathSync/lstatSync/readlinkSync
      // 供 resolveWorkspacePath 的符号链接守卫用（realpath 失败 → 守卫放行，与真机一致）
      existsSync: (p: string) => mocks.existsMap.get(p) ?? true,
      realpathSync: (p: string) => {
        throw new Error(`ENOENT: no such file or directory, realpath '${p}'`)
      },
      lstatSync: (p: string) => {
        throw new Error(`ENOENT: no such file or directory, lstat '${p}'`)
      },
      readlinkSync: (p: string) => {
        throw new Error(`EACCES: permission denied, readlink '${p}'`)
      }
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('node:fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))
vi.mock('node:child_process', () => ({
  spawn: (...a: unknown[]) => mocks.cp.impl ? mocks.cp.impl(...a) : null
}))

const WS = 'C:\\proj'
const vitestEntry = path.join(WS, 'node_modules', 'vitest', 'vitest.mjs')

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
  mocks.existsMap.clear()
  mocks.store.set('agent.workspace_dir', WS)
  mocks.cp.impl = (...a: unknown[]) => {
    const [cmd, args, opts] = a as [string, string[], { cwd?: string; env?: Record<string, string | undefined> }]
    mocks.spawns.push({ cmd, args, opts: opts ?? {} })
    return fakeChild({ stdout: 'Test Files  1 passed (1)\nTests  7 passed (7)\n', exitCode: 0 })
  }
})

import { getRunTestsTools } from '../src/main/tools/run-tests'

const tool = () => getRunTestsTools()[0]!

describe('run_tests 工具', () => {
  it('默认跑全部：process.execPath 直跑 vitest.mjs，ELECTRON_RUN_AS_NODE=1（SEC-16-01）', async () => {
    const out = await tool().execute({})
    expect(mocks.spawns).toHaveLength(1)
    const s = mocks.spawns[0]!
    expect(s.cmd).toBe(process.execPath)
    expect(s.args).toEqual([vitestEntry, 'run', '--reporter=dot'])
    expect(s.opts.cwd).toBe(WS)
    expect(s.opts.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    const r = JSON.parse(out)
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.files).toContain('1 passed')
    expect(r.tests).toContain('7 passed')
    expect(r.failed).toBe(false)
  })

  it('指定文件：作为独立 argv 传递（不经 shell 拼接）', async () => {
    await tool().execute({ files: ['tests/foo.test.ts', 'tests/bar.spec.ts'] })
    expect(mocks.spawns).toHaveLength(1)
    expect(mocks.spawns[0]!.args).toEqual([
      vitestEntry, 'run', 'tests/foo.test.ts', 'tests/bar.spec.ts', '--reporter=dot'
    ])
  })

  it('穿越 / 绝对路径 / 空路径 / 元字符 / 非测试后缀 → 拒绝，不 spawn', async () => {
    for (const bad of [
      ['../x.test.ts'],
      ['C:\\x.test.ts'],
      ['/abs/test.ts'],
      [''],
      ['tests/foo & bar.test.ts'],
      ['tests/a|b.test.ts'],
      ['tests/foo.ts']
    ]) {
      await expect(tool().execute({ files: bad })).rejects.toThrow()
    }
    expect(mocks.spawns).toHaveLength(0)
  })

  it('工作区未安装 vitest → 返回 ok=false 错误说明，不 spawn', async () => {
    mocks.existsMap.set(vitestEntry, false)
    const r = JSON.parse(await tool().execute({}))
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('vitest')
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
