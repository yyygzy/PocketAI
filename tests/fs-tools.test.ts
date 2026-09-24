// fs-tools 工作目录路径安全测试
//
// 覆盖 src/main/tools/fs-tools.ts 的路径安全边界：
// - getWorkspaceDir / setWorkspaceDir：工作目录读写
// - resolveWorkspacePath：相对路径解析，拒绝 ../ 穿越 / NUL 注入 / 绝对路径越界
// - assertWithinWorkspaceByRealpath：符号链接逃逸防护（realpath 校验最深存在祖先）
//
// 策略：vi.hoisted mock appConfigRepo(Map) 与 fs（existsSync/realpathSync 可编程）。
// 工作目录固定为 Windows 风格 C:\\agent-workspace。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  // fs mock：existsMap 控制哪些路径存在，realpathMap 控制 realpath 结果
  const existsMap = new Map<string, boolean>()
  const realpathMap = new Map<string, string>()
  return {
    store,
    existsMap,
    realpathMap,
    appConfigRepo: {
      get: (k: string) => (store.has(k) ? store.get(k)! : null),
      set: (k: string, v: string) => store.set(k, v),
      delete: (k: string) => store.delete(k)
    },
    fs: {
      existsSync: (p: string) => mocks.existsMap.get(p) ?? false,
      realpathSync: (p: string) => {
        if (mocks.realpathMap.has(p)) return mocks.realpathMap.get(p)!
        throw new Error(`ENOENT: no such file or directory, realpath '${p}'`)
      }
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: mocks.appConfigRepo
}))

vi.mock('node:fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

import path from 'node:path'
import {
  getWorkspaceDir,
  setWorkspaceDir,
  resolveWorkspacePath,
  assertWithinWorkspaceByRealpath
} from '../src/main/tools/fs-tools'

const WS = path.join('C:', 'agent-workspace')

beforeEach(() => {
  mocks.store.clear()
  mocks.existsMap.clear()
  mocks.realpathMap.clear()
})

describe('getWorkspaceDir / setWorkspaceDir', () => {
  it('未设置 → 空串', () => {
    expect(getWorkspaceDir()).toBe('')
  })

  it('设置后读取', () => {
    setWorkspaceDir(WS)
    expect(getWorkspaceDir()).toBe(WS)
  })

  it('空串 → 删除', () => {
    setWorkspaceDir(WS)
    setWorkspaceDir('')
    expect(mocks.store.has('agent.workspace_dir')).toBe(false)
    expect(getWorkspaceDir()).toBe('')
  })
})

describe('resolveWorkspacePath — 路径穿越防护', () => {
  beforeEach(() => setWorkspaceDir(WS))

  it('未设置工作目录 → 抛错', () => {
    mocks.store.clear()
    expect(() => resolveWorkspacePath('foo')).toThrow('未设置 Agent 工作目录')
  })

  it('正常相对路径 → 工作目录内绝对路径', () => {
    expect(resolveWorkspacePath('sub/file.txt')).toBe(path.join(WS, 'sub', 'file.txt'))
  })

  it('点号 → 工作目录根', () => {
    expect(resolveWorkspacePath('.')).toBe(WS)
  })

  it('反斜杠自动转正', () => {
    expect(resolveWorkspacePath('sub\\file.txt')).toBe(path.join(WS, 'sub', 'file.txt'))
  })

  it('.. 穿越 → 抛错', () => {
    expect(() => resolveWorkspacePath('../etc/passwd')).toThrow('路径超出工作目录范围')
    expect(() => resolveWorkspacePath('sub/../../secret')).toThrow('路径超出工作目录范围')
  })

  it('NUL 注入 → 抛错', () => {
    expect(() => resolveWorkspacePath('foo\0bar')).toThrow('非法路径')
  })

  it('绝对路径越界 → 抛错', () => {
    expect(() => resolveWorkspacePath('C:/Windows/system32')).toThrow('路径超出工作目录范围')
  })

  it('绝对路径刚好在工作目录内 → 合法', () => {
    // 绝对路径会被 normalize 去掉前导 /，最终仍 resolve 到工作目录内
    expect(resolveWorkspacePath('/sub/file.txt')).toBe(path.join(WS, 'sub', 'file.txt'))
  })
})

describe('assertWithinWorkspaceByRealpath — 符号链接逃逸防护', () => {
  it('路径上无任何存在节点 → 放行（无法构造 symlink 逃逸）', () => {
    // existsMap 全空，整条路径待创建
    const target = path.join(WS, 'new', 'dir', 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('存在节点 realpath 仍在工作目录内 → 放行', () => {
    const sub = path.join(WS, 'sub')
    mocks.existsMap.set(sub, true)
    mocks.realpathMap.set(sub, sub) // 无符号链接，realpath 不变
    mocks.realpathMap.set(WS, WS)
    const target = path.join(sub, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('存在节点是符号链接，realpath 逃逸出工作目录 → 抛错', () => {
    const link = path.join(WS, 'evil-link')
    mocks.existsMap.set(link, true)
    // 符号链接指向工作目录外
    mocks.realpathMap.set(link, 'C:\\secret-data')
    mocks.realpathMap.set(WS, WS)
    const target = path.join(link, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).toThrow('符号链接逃逸')
  })

  it('最深存在祖先逃逸 → 抛错（目标本身不存在，但父目录是逃逸 symlink）', () => {
    const parent = path.join(WS, 'bad-parent')
    mocks.existsMap.set(parent, true)
    mocks.realpathMap.set(parent, 'C:\\escape')
    mocks.realpathMap.set(WS, WS)
    // target 是 parent 下的不存在文件，向上找到 parent 存在
    const target = path.join(parent, 'nonexistent.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).toThrow('符号链接逃逸')
  })

  it('工作目录本身是 symlink，realpath 后目标仍在其真实路径内 → 放行', () => {
    const realWs = 'D:\\real-workspace'
    mocks.existsMap.set(WS, true)
    mocks.realpathMap.set(WS, realWs)
    const sub = path.join(WS, 'sub')
    mocks.existsMap.set(sub, true)
    mocks.realpathMap.set(sub, path.join(realWs, 'sub'))
    const target = path.join(sub, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('realpath 自身失败（非越界错误）→ 保守拒绝', () => {
    const sub = path.join(WS, 'sub')
    mocks.existsMap.set(sub, true)
    // realpathMap 不设 sub，realpathSync 抛 ENOENT
    mocks.realpathMap.set(WS, WS)
    expect(() => assertWithinWorkspaceByRealpath(path.join(sub, 'f.txt'), WS)).toThrow('路径校验失败')
  })
})
