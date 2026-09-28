// python-runtime 测试
//
// 覆盖 src/main/python-runtime.ts：
// - resolveUnder：路径越界防护（Zip Slip 同级）
// - verifyArchiveHash：SHA256 钉版校验（匹配/不匹配/平台缺失）
// - extractTarGz：tar 流式解压（文件+目录 / GNU 长名 / 符号链接绝对目标拒绝 /
//   符号链接 ../ 越界拒绝 / Zip Slip 拒绝）
// - detectSystemPython：候选探测与去重（posix / Windows / 全失败 / 无版本号）
// - listPythonRuntimes：便携优先 + 系统补充
// - getPortablePythonInfo：便携版存在性
// - downloadPortablePython：不支持平台快速失败
//
// 策略：vi.hoisted 集中 spawn/safeFetch impl；纯函数直接 import；
//      平台切换 Object.defineProperty + finally 还原；tar.gz 用 zlib 实时构造；
//      fs 用 vi.spyOn 按用例局部覆盖 existsSync

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  resolveUnder,
  verifyArchiveHash,
  extractTarGz,
  detectSystemPython,
  listPythonRuntimes,
  getPortablePythonInfo,
  downloadPortablePython
} from '../src/main/python-runtime'

const mocks = vi.hoisted(() => {
  let spawnImpl: ((cmd: string, args: string[]) => unknown) | null = null
  let fetchImpl: ((url: string, opts: unknown) => Promise<unknown>) | null = null
  return {
    getSpawn: () => spawnImpl,
    setSpawn: (fn: typeof spawnImpl) => { spawnImpl = fn },
    getFetch: () => fetchImpl,
    setFetch: (fn: typeof fetchImpl) => { fetchImpl = fn },
    reset: () => { spawnImpl = null; fetchImpl = null }
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/fake/exe',
    getAppPath: () => '/fake/app'
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    const impl = mocks.getSpawn()
    if (!impl) throw new Error('spawn impl 未设置')
    return impl(cmd, args)
  }
}))

vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: (url: string, opts: unknown) => {
    const impl = mocks.getFetch()
    if (!impl) throw new Error('fetch impl 未设置')
    return impl(url, opts)
  }
}))

beforeEach(() => mocks.reset())

// 辅助：构造一个返回 stdout/stderr/close 事件的假 ChildProcess
function makeFakeProc(opts: { stdout?: string; stderr?: string; code?: number | 'error' }) {
  const proc = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  Object.assign(proc, { stdout, stderr })
  process.nextTick(() => {
    if (opts.stdout) stdout.emit('data', Buffer.from(opts.stdout))
    if (opts.stderr) stderr.emit('data', Buffer.from(opts.stderr))
    if (opts.code === 'error') {
      proc.emit('error', new Error('spawn 失败'))
    } else {
      proc.emit('close', opts.code ?? 0)
    }
  })
  return proc
}

// 辅助：构造 512 字节 tar 头
function tarHeader(name: string, opts: { size?: number; type?: string; linkname?: string } = {}): Buffer {
  const buf = Buffer.alloc(512, 0)
  buf.write(name.slice(0, 100), 0, 100, 'utf8') // name
  buf.write('0000755', 100, 7, 'utf8') // mode
  buf.write('0000000', 108, 7, 'utf8') // uid
  buf.write('0000000', 116, 7, 'utf8') // gid
  const size = opts.size ?? 0
  buf.write(size.toString(8).padStart(11, '0'), 124, 11, 'utf8') // size (octal)
  buf.write('00000000000', 136, 11, 'utf8') // mtime
  buf.write(opts.type ?? '0', 156, 1, 'utf8') // typeflag
  if (opts.linkname) buf.write(opts.linkname.slice(0, 100), 157, 100, 'utf8') // linkname
  buf.write('ustar', 257, 5, 'utf8') // magic
  buf.write('00', 263, 2, 'utf8') // version
  // 校验和：先填 8 个空格，求和，写回
  for (let i = 148; i < 156; i++) buf[i] = 0x20
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]!
  buf.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8')
  buf[154] = 0 // NUL
  return buf
}

// 辅助：构造 tar.gz buffer
function makeTarGz(entries: Array<{ name: string; type?: string; content?: Buffer; linkname?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const content = e.content ?? Buffer.alloc(0)
    blocks.push(tarHeader(e.name, { size: content.length, type: e.type, linkname: e.linkname }))
    if (content.length > 0) {
      blocks.push(content)
      const pad = (512 - (content.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0))
    }
  }
  // 结束块：两个全零 512 块
  blocks.push(Buffer.alloc(1024, 0))
  return zlib.gzipSync(Buffer.concat(blocks))
}

// ============ resolveUnder ============
describe('resolveUnder 路径越界防护', () => {
  const base = path.join(os.tmpdir(), 'py-runtime-resolve-' + process.pid)

  it('普通子路径：返回 base 内绝对路径', () => {
    const r = resolveUnder(base, 'foo/bar.txt')
    expect(r).toBe(path.join(base, 'foo', 'bar.txt'))
  })

  it('base 自身：返回 base', () => {
    const r = resolveUnder(base, '.')
    expect(r).toBe(base)
  })

  it('父目录逃逸：抛错', () => {
    expect(() => resolveUnder(base, '../escape.txt')).toThrow('tar 条目路径越界')
  })

  it('绝对路径：抛错', () => {
    expect(() => resolveUnder(base, '/etc/passwd')).toThrow('tar 条目路径越界')
  })
})

// ============ verifyArchiveHash ============
describe('verifyArchiveHash SHA256 钉版校验', () => {
  const tmpFile = path.join(os.tmpdir(), 'py-runtime-hash-' + process.pid + '.bin')
  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })

  it('哈希匹配：不抛错', () => {
    const content = Buffer.from('hello python')
    fs.writeFileSync(tmpFile, content)
    const hash = createHash('sha256').update(content).digest('hex')
    expect(() => verifyArchiveHash(tmpFile, hash)).not.toThrow()
  })

  it('哈希不匹配：抛「校验和不匹配」', () => {
    fs.writeFileSync(tmpFile, Buffer.from('tampered'))
    const wrongHash = '0'.repeat(64)
    expect(() => verifyArchiveHash(tmpFile, wrongHash)).toThrow('校验和不匹配')
  })

  it('平台缺失钉版哈希：抛「缺少钉版 SHA256」', () => {
    fs.writeFileSync(tmpFile, Buffer.from('x'))
    const orig = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'mythical', configurable: true })
      expect(() => verifyArchiveHash(tmpFile)).toThrow('缺少钉版 SHA256')
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })
})

// ============ extractTarGz ============
describe('extractTarGz 流式解压', () => {
  let destDir: string
  beforeEach(() => {
    destDir = path.join(os.tmpdir(), 'py-runtime-extract-' + process.pid + '-' + Math.random().toString(36).slice(2))
    fs.mkdirSync(destDir, { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true })
  })

  it('普通文件 + 目录：正确写入', async () => {
    const content = Buffer.from('hello world')
    const tgz = makeTarGz([
      { name: 'mydir', type: '5' },
      { name: 'mydir/file.txt', type: '0', content }
    ])
    const tgzPath = path.join(destDir, 'test.tar.gz')
    fs.writeFileSync(tgzPath, tgz)

    await extractTarGz(tgzPath, destDir)

    const written = path.join(destDir, 'mydir', 'file.txt')
    expect(fs.existsSync(written)).toBe(true)
    expect(fs.readFileSync(written)).toEqual(content)
  })

  it('GNU 长名（L typeflag）：使用扩展路径写入', async () => {
    const longName = 'a/'.repeat(60) + 'file.txt' // > 100 chars
    const nameBuf = Buffer.from(longName + '\0')
    const content = Buffer.from('long content')
    const tgz = makeTarGz([
      { name: './@LongLink', type: 'L', content: nameBuf },
      { name: 'truncated', type: '0', content }
    ])
    const tgzPath = path.join(destDir, 'test.tar.gz')
    fs.writeFileSync(tgzPath, tgz)

    await extractTarGz(tgzPath, destDir)

    const expected = path.join(destDir, ...longName.split('/'))
    expect(fs.existsSync(expected)).toBe(true)
    expect(fs.readFileSync(expected)).toEqual(content)
  })

  it('符号链接绝对目标：拒绝', async () => {
    const tgz = makeTarGz([
      { name: 'evil.txt', type: '2', linkname: '/etc/passwd' }
    ])
    const tgzPath = path.join(destDir, 'test.tar.gz')
    fs.writeFileSync(tgzPath, tgz)

    await expect(extractTarGz(tgzPath, destDir)).rejects.toThrow('符号链接指向绝对路径')
  })

  it('符号链接 ../ 目标越界：拒绝', async () => {
    const tgz = makeTarGz([
      { name: 'evil.txt', type: '2', linkname: '../escape.txt' }
    ])
    const tgzPath = path.join(destDir, 'test.tar.gz')
    fs.writeFileSync(tgzPath, tgz)

    await expect(extractTarGz(tgzPath, destDir)).rejects.toThrow('符号链接目标越界')
  })

  it('Zip Slip 父目录逃逸：拒绝', async () => {
    const tgz = makeTarGz([
      { name: '../escape.txt', type: '0', content: Buffer.from('x') }
    ])
    const tgzPath = path.join(destDir, 'test.tar.gz')
    fs.writeFileSync(tgzPath, tgz)

    await expect(extractTarGz(tgzPath, destDir)).rejects.toThrow('tar 条目路径越界')
  })
})

// ============ detectSystemPython ============
describe('detectSystemPython 候选探测', () => {
  let origPlatform: string
  beforeEach(() => { origPlatform = process.platform })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('posix：python3 找到，python 同路径去重', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mocks.setSpawn((cmd, args) => {
      if (args[0] === '--version' && (cmd === 'python3' || cmd === 'python')) {
        return makeFakeProc({ stdout: 'Python 3.11.0\n' })
      }
      if (cmd === 'which') return makeFakeProc({ stdout: '/usr/bin/python3\n' })
      return makeFakeProc({ code: 1 })
    })
    const list = await detectSystemPython()
    expect(list).toHaveLength(1)
    expect(list[0]!.version).toBe('3.11.0')
    expect(list[0]!.source).toBe('system')
    expect(list[0]!.path).toBe('/usr/bin/python3')
  })

  it('Windows：py -3 找到', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.setSpawn((cmd, args) => {
      if (cmd === 'py' && args.includes('-3') && args.includes('--version')) {
        return makeFakeProc({ stdout: 'Python 3.12.0\n' })
      }
      if (cmd === 'where') return makeFakeProc({ stdout: 'C:\\Python312\\py.exe\n' })
      return makeFakeProc({ code: 1 })
    })
    const list = await detectSystemPython()
    expect(list).toHaveLength(1)
    expect(list[0]!.version).toBe('3.12.0')
    expect(list[0]!.path).toBe('C:\\Python312\\py.exe')
  })

  it('全部候选失败：返回空数组', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mocks.setSpawn(() => makeFakeProc({ code: 1 }))
    const list = await detectSystemPython()
    expect(list).toEqual([])
  })

  it('输出无 Python 版本号：候选被跳过', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mocks.setSpawn((_cmd, args) => {
      if (args[0] === '--version') return makeFakeProc({ stdout: 'no python here\n' })
      return makeFakeProc({ code: 1 })
    })
    const list = await detectSystemPython()
    expect(list).toEqual([])
  })
})

// ============ listPythonRuntimes ============
describe('listPythonRuntimes 便携优先 + 系统补充', () => {
  let origPlatform: string
  beforeEach(() => { origPlatform = process.platform })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    vi.restoreAllMocks()
  })

  it('便携版存在：置顶便携，后跟系统', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    mocks.setSpawn((cmd, args) => {
      // probe 便携：cmd 是绝对路径
      if (path.isAbsolute(cmd as string) && args[0] === '--version') {
        return makeFakeProc({ stdout: 'Python 3.12.0\n' })
      }
      if (cmd === 'which') return makeFakeProc({ stdout: '/opt/app/python3\n' })
      // detectSystemPython 候选都失败
      return makeFakeProc({ code: 1 })
    })
    const list = await listPythonRuntimes()
    expect(list).toHaveLength(1)
    expect(list[0]!.source).toBe('portable')
    expect(list[0]!.version).toBe('3.12.0')
  })

  it('便携版缺失：仅系统 Python', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    mocks.setSpawn((cmd, args) => {
      if (cmd === 'python3' && args[0] === '--version') {
        return makeFakeProc({ stdout: 'Python 3.10.0\n' })
      }
      if (cmd === 'which') return makeFakeProc({ stdout: '/usr/bin/python3\n' })
      return makeFakeProc({ code: 1 })
    })
    const list = await listPythonRuntimes()
    expect(list).toHaveLength(1)
    expect(list[0]!.source).toBe('system')
    expect(list[0]!.version).toBe('3.10.0')
  })
})

// ============ getPortablePythonInfo ============
describe('getPortablePythonInfo 便携版存在性', () => {
  afterEach(() => vi.restoreAllMocks())

  it('便携版已下载：返回 exists=true', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const info = getPortablePythonInfo()
    expect(info.exists).toBe(true)
    expect(info.path).toBeTruthy()
  })

  it('便携版未下载：返回 exists=false', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const info = getPortablePythonInfo()
    expect(info.exists).toBe(false)
    expect(info.path).toBeTruthy()
  })
})

// ============ downloadPortablePython ============
describe('downloadPortablePython 不支持平台快速失败', () => {
  let origPlatform: string
  beforeEach(() => { origPlatform = process.platform })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('平台无 triple：抛「不支持的平台」', async () => {
    Object.defineProperty(process, 'platform', { value: 'mythical', configurable: true })
    await expect(downloadPortablePython()).rejects.toThrow('不支持的平台')
  })
})
