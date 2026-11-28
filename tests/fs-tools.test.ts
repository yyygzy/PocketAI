// fs-tools 工作目录路径安全测试
//
// 覆盖 src/main/tools/fs-tools.ts 的路径安全边界：
// - getWorkspaceDir / setWorkspaceDir：工作目录读写
// - resolveWorkspacePath：相对路径解析，拒绝 ../ 穿越 / NUL 注入 / 绝对路径越界
// - assertWithinWorkspaceByRealpath：符号链接逃逸防护（SEC-16-03 重写：逐段 lstat + readlink）
//
// 策略：vi.hoisted mock appConfigRepo(Map) 与 fs（existsSync/realpathSync/lstatSync/readlinkSync 可编程）。
// 工作目录固定为 Windows 风格 C:\\agent-workspace。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  // fs mock：existsMap 控制哪些路径存在，realpathMap 控制 realpath 结果；
  // lstatMap/readlinkMap 驱动 SEC-16-03 重写后的逐段符号链接解析
  const existsMap = new Map<string, boolean>()
  const realpathMap = new Map<string, string>()
  const lstatMap = new Map<string, { isSymbolicLink: boolean }>()
  const readlinkMap = new Map<string, string>()
  return {
    store,
    existsMap,
    realpathMap,
    lstatMap,
    readlinkMap,
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
      },
      lstatSync: (p: string) => {
        // 实现按 fs.Stats 调用 st.isSymbolicLink()（函数调用），mock 必须包成方法
        const entry = mocks.lstatMap.get(p)
        if (entry) return { isSymbolicLink: () => entry.isSymbolicLink }
        throw new Error(`ENOENT: no such file or directory, lstat '${p}'`)
      },
      readlinkSync: (p: string) => {
        if (mocks.readlinkMap.has(p)) return mocks.readlinkMap.get(p)!
        throw new Error(`EACCES: permission denied, readlink '${p}'`)
      }
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: mocks.appConfigRepo
}))

// V4-Iter-231 起 fs-tools 多了一条 import：agent/file-snapshots → portable（顶层算 APP_ROOT 要用 app.isPackaged）。
// 快照根目录是**产品事实**（写在应用数据目录下），所以不绕开这条依赖，只给 portable 需要的最小 `app` 桩。
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
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
  mocks.lstatMap.clear()
  mocks.readlinkMap.clear()
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

describe('assertWithinWorkspaceByRealpath — 符号链接逃逸防护（SEC-16-03 重写）', () => {
  it('路径上无任何存在节点 → 放行（无法构造 symlink 逃逸）', () => {
    // lstatMap 全空，整条路径待创建：逐段 lstat 全失败，回溯到根后放行
    const target = path.join(WS, 'new', 'dir', 'file.txt')
    mocks.realpathMap.set(WS, WS)
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('中间目录存在且非链接 → 放行（回溯到工作目录根即终止）', () => {
    const sub = path.join(WS, 'sub')
    mocks.lstatMap.set(sub, { isSymbolicLink: false })
    mocks.realpathMap.set(WS, WS)
    const target = path.join(sub, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('悬空链接（目标尚不存在）→ 抛错（SEC-16-03 修复的核心用例）', () => {
    // 旧实现 existsSync 对悬空链接返回 false → 回退到工作目录内父级 → 放行；
    // 新实现逐段 lstat 能看到链接本身，readlink 解析原始目标后拒绝
    const link = path.join(WS, 'dangling-link')
    mocks.lstatMap.set(link, { isSymbolicLink: true })
    mocks.readlinkMap.set(link, 'C:\\secret-data\\x.txt')
    mocks.realpathMap.set(WS, WS)
    const target = path.join(link, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).toThrow('符号链接逃逸')
  })

  it('已存在链接且目标逃逸 → 抛错', () => {
    const link = path.join(WS, 'evil-link')
    mocks.lstatMap.set(link, { isSymbolicLink: true })
    mocks.readlinkMap.set(link, 'C:\\secret-data')
    mocks.realpathMap.set(WS, WS)
    const target = path.join(link, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).toThrow('符号链接逃逸')
  })

  it('链接指向工作目录内 → 放行', () => {
    const link = path.join(WS, 'ok-link')
    const inner = path.join(WS, 'real-dir')
    mocks.lstatMap.set(link, { isSymbolicLink: true })
    mocks.readlinkMap.set(link, inner)
    mocks.realpathMap.set(WS, WS)
    const target = path.join(link, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('链式链接（link1 → link2 → 工作目录外）→ 抛错', () => {
    const link1 = path.join(WS, 'link1')
    const link2 = path.join(WS, 'link2')
    mocks.lstatMap.set(link1, { isSymbolicLink: true })
    mocks.readlinkMap.set(link1, link2)
    mocks.lstatMap.set(link2, { isSymbolicLink: true })
    mocks.readlinkMap.set(link2, 'C:\\escape')
    mocks.realpathMap.set(WS, WS)
    const target = path.join(link1, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).toThrow('符号链接逃逸')
  })

  it('工作目录本身是 symlink，链接解析回真实路径 → 放行', () => {
    const realWs = 'D:\\real-workspace'
    mocks.lstatMap.set(WS, { isSymbolicLink: true })
    mocks.readlinkMap.set(WS, realWs)
    const sub = path.join(WS, 'sub')
    mocks.lstatMap.set(sub, { isSymbolicLink: false })
    mocks.realpathMap.set(WS, realWs)
    const target = path.join(sub, 'file.txt')
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })

  it('readlink 自身失败（权限等）→ 保守拒绝（不知道链接指向哪里就不能放行）', () => {
    const sub = path.join(WS, 'sub')
    mocks.lstatMap.set(sub, { isSymbolicLink: true })
    // readlinkMap 不登记 sub → readlinkSync 抛 EACCES
    mocks.realpathMap.set(WS, WS)
    expect(() => assertWithinWorkspaceByRealpath(path.join(sub, 'f.txt'), WS)).toThrow('路径校验失败')
  })

  it('工作目录的祖先上有符号链接 → 不误报（回溯在工作目录根终止）', () => {
    // Windows 用户目录下的 junction 是合法的；守卫管辖范围是工作目录内部，
    // 向上回溯到工作目录根必须停（旧实现与新实现重写时都容易在这里产生误报回归）
    const parentOfWs = path.dirname(WS)
    mocks.lstatMap.set(parentOfWs, { isSymbolicLink: true })
    mocks.readlinkMap.set(parentOfWs, 'C:\\somewhere-else')
    mocks.realpathMap.set(WS, WS)
    const sub = path.join(WS, 'sub')
    mocks.lstatMap.set(sub, { isSymbolicLink: false })
    expect(() => assertWithinWorkspaceByRealpath(path.join(sub, 'f.txt'), WS)).not.toThrow()
  })

  it('工作目录/数据目录本身不存在 → 放行（无从构造链接，交给 fs 自然报 ENOENT）', () => {
    // files-service 的单测里 DATA_DIR 是被 mock 的假路径；此处保证守卫不会把
    // 「目录尚未创建」变成所有文件操作统一报「路径校验失败」
    const target = path.join(WS, 'sub', 'f.txt')
    mocks.realpathMap.delete(WS)
    expect(() => assertWithinWorkspaceByRealpath(target, WS)).not.toThrow()
  })
})
