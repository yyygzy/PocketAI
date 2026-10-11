// win-shim 纯函数：命令该不该走 cmd.exe 垫片 + 命令行构造的转义口径
//
// 这一层的正确性不是"能跑就行"：构造错了要么起不来（ENOENT/EINVAL），
// 要么把用户/导入配置里的参数变成 cmd 命令（注入）。所以每条转义规则都单独钉住。
import { describe, it, expect } from 'vitest'
import {
  buildCmdShimLine,
  classifyCommandName,
  findCommandInPath,
  needsCmdShim
} from '../src/main/mcp/win-shim'

const existsIn = (files: string[]) => (p: string): boolean => files.includes(p)

describe('classifyCommandName', () => {
  it('bare / pe / batch 三类', () => {
    expect(classifyCommandName('npx')).toBe('bare')
    expect(classifyCommandName('node.exe')).toBe('pe')
    expect(classifyCommandName('C:\\Program Files\\nodejs\\npx.cmd')).toBe('batch')
    expect(classifyCommandName('/usr/bin/python3')).toBe('bare')
  })
})

describe('findCommandInPath', () => {
  it('PATH 里先找 .exe：找到就不需要垫片（node 是 node.exe）', () => {
    expect(
      findCommandInPath('node', ['C:\\nodejs'], existsIn(['C:\\nodejs\\node.exe']))
    ).toBe('exe')
  })

  it('只有 .cmd 的是批处理垫片 → 需要走 cmd.exe（npx 的真实形态）', () => {
    expect(
      findCommandInPath('npx', ['C:\\nodejs'], existsIn(['C:\\nodejs\\npx.cmd']))
    ).toBe('batch')
  })

  it('.bat 同样算垫片', () => {
    expect(
      findCommandInPath('tool', ['D:\\bin'], existsIn(['D:\\bin\\tool.bat']))
    ).toBe('batch')
  })

  it('PATH 里两个都没有 → unknown（原样 spawn 让 ENOENT 如实冒出来，不做猜测兜底）', () => {
    expect(findCommandInPath('npx', ['C:\\nodejs'], existsIn([]))).toBe('unknown')
  })

  it('带目录的命令不查 PATH，只看扩展名', () => {
    expect(findCommandInPath('C:\\a\\b\\x.cmd', [], existsIn([]))).toBe('batch')
    expect(findCommandInPath('C:\\a\\b\\x.exe', [], existsIn([]))).toBe('exe')
    expect(findCommandInPath('C:\\a\\b\\x', [], existsIn(['C:\\a\\b\\x']))).toBe('unknown')
  })

  it('调用方已写扩展名时以扩展名为准（不去 PATH 找同名 .exe）', () => {
    expect(findCommandInPath('npx.cmd', ['C:\\nodejs'], existsIn(['C:\\nodejs\\npx.exe']))).toBe('batch')
  })
})

describe('needsCmdShim', () => {
  it('非 win32 恒 false（mac/linux 上 npm 的 npx 是真符号链接）', () => {
    expect(needsCmdShim('npx', 'darwin', '/usr/bin')).toBe(false)
    expect(needsCmdShim('npx', 'linux', '/usr/bin')).toBe(false)
  })

  it('win32 真机口径：node 直起、npx 走垫片、查无此命令不猜', () => {
    // node.exe 存在（非 win32 走平台闸也是 false），npm 装的 npx 只有 .cmd 垫片
    expect(needsCmdShim('node')).toBe(false)
    expect(needsCmdShim('npx', 'darwin')).toBe(false)
    if (process.platform === 'win32') {
      expect(needsCmdShim('npx')).toBe(true)
      expect(needsCmdShim('definitely-not-installed-xyz')).toBe(false)
    }
  })
})

describe('buildCmdShimLine', () => {
  it('参数一律加引号，命令名不加（实测：命令名加引号会把 npx.cmd 的参数打成位置参数）', () => {
    expect(buildCmdShimLine('npx', ['-y', '@modelcontextprotocol/server-memory'])).toBe(
      'npx "-y" "@modelcontextprotocol/server-memory"'
    )
  })

  it('命令名含空格时才加引号（带空格的安装路径）', () => {
    expect(buildCmdShimLine('C:\\Program Files\\nodejs\\npx.cmd', ['--version'])).toBe(
      '"C:\\Program Files\\nodejs\\npx.cmd" "--version"'
    )
  })

  it('内嵌双引号翻倍：cmd 里 "" 才是字面量引号，参数不会被 & 逃逸', () => {
    expect(buildCmdShimLine('echo', ['x"&whoami'])).toBe('echo "x""&whoami"')
    expect(buildCmdShimLine('echo', ['a b'])).toBe('echo "a b"')
  })

  it('% 与换行直接拒绝（% 在引号内也会被 cmd 展开，换行会截断命令行）', () => {
    expect(() => buildCmdShimLine('echo', ['%PATH%'])).toThrow(/无法安全转义/)
    expect(() => buildCmdShimLine('echo', ['a\nb'])).toThrow(/无法安全转义/)
    expect(() => buildCmdShimLine('ec%ho', [])).toThrow(/无法安全转义/)
  })

  it('空参数数组只出命令名；参数是空串仍出成对引号（不能被 cmd 丢掉位置）', () => {
    expect(buildCmdShimLine('npx', [])).toBe('npx')
    expect(buildCmdShimLine('npx', [''])).toBe('npx ""')
  })
})
