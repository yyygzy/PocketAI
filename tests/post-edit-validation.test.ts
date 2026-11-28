// @vitest-environment node
// 编辑后自动验证：偏好默认关 + 路径提取 + 命令摘要，不真跑 typecheck/vitest。
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  ws: ''
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => state.store.get(k) ?? null,
    set: (k: string, v: string) => { state.store.set(k, v) },
    delete: (k: string) => { state.store.delete(k) }
  }
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

import { spawn } from 'node:child_process'
import {
  isPostEditValidationEnabled,
  setPostEditValidationEnabled,
  getPostEditValidationPrefs
} from '../src/main/agent/post-edit-validation-prefs'
import {
  collectEditedPaths,
  runPostEditValidation
} from '../src/main/agent/post-edit-validation'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

const spawnMock = vi.mocked(spawn)

beforeAll(() => {
  state.ws = mkdtempSync(path.join(tmpdir(), 'pocketai-auto-verify-'))
  // SEC-16-01 起 vitest 改为直跑工作区的 vitest.mjs：摆一个入口文件供 existsSync 探测
  mkdirSync(path.join(state.ws, 'node_modules', 'vitest'), { recursive: true })
  writeFileSync(path.join(state.ws, 'node_modules', 'vitest', 'vitest.mjs'), '')
})

beforeEach(() => {
  state.store.set('agent.workspace_dir', state.ws)
})

afterEach(() => {
  state.store.clear()
  spawnMock.mockReset()
})

describe('post-edit validation 偏好', () => {
  it('缺省关；只有显式 1 才开', () => {
    expect(isPostEditValidationEnabled()).toBe(false)
    expect(getPostEditValidationPrefs()).toEqual({ enabled: false })
    expect(setPostEditValidationEnabled(true)).toBe(true)
    expect(isPostEditValidationEnabled()).toBe(true)
    expect(setPostEditValidationEnabled(false)).toBe(true)
    expect(isPostEditValidationEnabled()).toBe(false)
  })
})

describe('collectEditedPaths 路径提取', () => {
  it('fs_write 取 path', () => {
    expect(collectEditedPaths('fs_write', JSON.stringify({ path: 'src/a.ts', bytes: 3 }))).toEqual(['src/a.ts'])
  })

  it('fs_apply_patch 取 files[].path', () => {
    const content = JSON.stringify({ count: 2, files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] })
    expect(collectEditedPaths('fs_apply_patch', content)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('非编辑工具或穿越路径一律不识别', () => {
    expect(collectEditedPaths('run_tests', '{"path":"src/a.ts"}')).toEqual([])
    expect(collectEditedPaths('fs_write', '{"path":"../secret.ts"}')).toEqual([])
    expect(collectEditedPaths('fs_write', 'not json')).toEqual([])
  })
})

describe('runPostEditValidation 命令摘要', () => {
  it('依次跑 typecheck 与 vitest related，并输出两段摘要', async () => {
    spawnMock.mockImplementation(((_cmd: string, args: readonly string[] | undefined) => {
      const child = new FakeChild()
      const list = (args ?? []).map(String)
      setImmediate(() => {
        const out = list.includes('typecheck')
          ? '> tsc --noEmit\n'
          : 'Test Files  1 passed (1)\nTests  3 passed (3)\n'
        child.stdout.emit('data', Buffer.from(out))
        child.emit('close', 0)
      })
      return child as unknown as ChildProcess
    }) as never)

    const note = await runPostEditValidation(['src/a.ts', 'src/a.ts', '../bad.ts'])
    expect(note).toContain('[自动验证]')
    expect(note).toContain('typecheck：通过')
    expect(note).toContain('相关测试：通过')
    expect(note).toContain('Tests  3 passed (3)')
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const relatedCall = spawnMock.mock.calls[1] as unknown as [string, string[]]
    expect(relatedCall[1]).toContain('related')
    expect(relatedCall[1]).toContain('src/a.ts')
    expect(relatedCall[1]).not.toContain('../bad.ts')
  })

  it('没有可验证路径时直接跳过，不启动进程', async () => {
    const note = await runPostEditValidation(['../bad.ts'])
    expect(note).toContain('未识别到改动文件')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
