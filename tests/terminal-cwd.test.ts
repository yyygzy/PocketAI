// 终端工作目录的落点（V4-Iter：终端不再继承进程启动目录）
//
// 改前 `spawn` 写的是 `cwd: undefined`，注释却声称「便携包根目录」——实际落点取决于
// 从哪启动（快捷方式/命令行/开发态各不同），而且与 Agent 工作目录 `agent.workspace_dir` 脱节。
// 这里把四档优先级逐档钉住，并验证它真的传给了 spawn、真的回给了渲染端。
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'

const { spawnMock, workspace, packaged } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  workspace: { value: '' },
  packaged: { value: false }
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return packaged.value }, getPath: () => '', getAppPath: () => process.cwd() }
}))
// APP_ROOT 用项目根（确实存在）；工作目录/tmpdir 是另一颗可区分的落点
vi.mock('../src/main/portable', () => ({ APP_ROOT: process.cwd() }))
vi.mock('../src/main/tools/fs-tools', () => ({ getWorkspaceDir: () => workspace.value }))
vi.mock('../src/main/tools/shell-tools', () => ({ classifyDenyOnly: () => null }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

import {
  resolveTerminalCwd,
  startTerminal,
  killAllTerminals
} from '../src/main/terminal/terminal-service'

const APP_ROOT = process.cwd()
const TMP = os.tmpdir()
const HOME = os.homedir()
const MISSING = path.join(TMP, 'pocketai-terminal-cwd-not-exists-xyz')

const mkWc = (id: number): WebContents =>
  ({ id, isDestroyed: () => false, send: () => {} }) as unknown as WebContents

const fakeProc = (): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { destroyed: boolean; write: () => void }
  kill: ReturnType<typeof vi.fn>
} => {
  const p = new EventEmitter() as ReturnType<typeof fakeProc>
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.stdin = { destroyed: false, write: () => {} }
  p.kill = vi.fn()
  return p
}

beforeEach(() => {
  workspace.value = ''
  packaged.value = false
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.APPIMAGE
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => fakeProc())
})

afterEach(() => {
  killAllTerminals()
})

describe('resolveTerminalCwd：四档优先级逐档钉住', () => {
  it('① 显式传入的目录优先于工作目录与 APP_ROOT', () => {
    workspace.value = TMP
    expect(resolveTerminalCwd(APP_ROOT)).toBe(APP_ROOT)
  })

  it('② 没显式传入 ⇒ 用设置里选定的 Agent 工作目录（与 shell_exec 同一份）', () => {
    workspace.value = TMP
    expect(resolveTerminalCwd()).toBe(TMP)
  })

  it('③ 工作目录没配置 + 开发态/便携版/AppImage ⇒ 用 APP_ROOT（exe 旁边或项目根）', () => {
    expect(resolveTerminalCwd()).toBe(APP_ROOT) // 开发态
    packaged.value = true
    process.env.PORTABLE_EXECUTABLE_DIR = 'C:/portable'
    expect(resolveTerminalCwd()).toBe(APP_ROOT) // 便携版：即使 packaged 也用 exe 旁
    delete process.env.PORTABLE_EXECUTABLE_DIR
    process.env.APPIMAGE = '/opt/moxia/Moxia.AppImage'
    expect(resolveTerminalCwd()).toBe(APP_ROOT) // AppImage：AppImage 文件所在目录
  })

  it('④ 安装版且没有工作目录 ⇒ 用用户主目录，不拿 Program Files 当落点', () => {
    packaged.value = true
    expect(resolveTerminalCwd()).toBe(HOME)
  })

  it('显式目录不存在 ⇒ 退到工作目录，不把一个坏路径交给 spawn', () => {
    workspace.value = TMP
    expect(resolveTerminalCwd(MISSING)).toBe(TMP)
  })

  it('显式目录是个文件（不是目录）⇒ 同样退档', () => {
    workspace.value = TMP
    expect(resolveTerminalCwd(path.join(APP_ROOT, 'package.json'))).toBe(TMP)
  })
})

describe('startTerminal：解析结果真的落到 spawn 与回包', () => {
  it('spawn 收到显式 cwd，回包里带着同一个目录', () => {
    workspace.value = TMP
    const r = startTerminal(mkWc(71), APP_ROOT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cwd).toBe(APP_ROOT)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const opts = spawnMock.mock.calls[0]![2] as { cwd?: string }
    expect(opts.cwd).toBe(APP_ROOT)
  })

  it('无显式 cwd 时按优先级落点，绝不再是 undefined（旧写法）', () => {
    workspace.value = TMP
    const r = startTerminal(mkWc(72))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cwd).toBe(TMP)
    const opts = spawnMock.mock.calls[0]![2] as { cwd?: string }
    expect(opts.cwd).toBe(TMP)
  })
})
