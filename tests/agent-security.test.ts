// Agent 安全关键路径单元测试（项 12）
// 覆盖：shell 命令分类、MCP 工具权限、defaultParams 白名单、路径穿越/symlink、计算器沙箱
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// mock electron + database（被 fs-tools / builtin / mcp-manager / engine 的依赖链触发）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
vi.mock('../src/main/db/database', () => {
  const store = new Map<string, string>()
  const makeStmt = (sql: string) => ({
    get(...args: unknown[]) {
      if (sql.startsWith('SELECT')) {
        const v = store.get(String(args[0]))
        return v === undefined ? undefined : { value: v }
      }
      return undefined
    },
    run(...args: unknown[]) {
      if (sql.startsWith('INSERT')) store.set(String(args[0]), String(args[1]))
      else if (sql.startsWith('DELETE')) store.delete(String(args[0]))
      return { changes: 1, lastInsertRowid: 0 }
    }
  })
  return {
    LATEST_SCHEMA_VERSION: 0,
    DatabaseService: class {},
    dbService: { getHandle: () => ({ prepare: (sql: string) => makeStmt(sql) }) }
  }
})

import { classifyCommand } from '../src/main/tools/shell-tools'
import { classifyMcpToolPermission } from '../src/main/mcp/manager'
import { pickSafeParams } from '../src/main/agent/engine'
import { setWorkspaceDir, resolveWorkspacePath } from '../src/main/tools/fs-tools'
import { safeMathEval } from '../src/main/tools/builtin'

const WS = '/tmp/fake-workspace'

describe('classifyCommand — shell 命令安全分类', () => {
  it('空命令 → deny BAD_ARGS', () => {
    expect(classifyCommand('', WS).decision).toBe('deny')
  })

  it('黑名单命令 → deny', () => {
    for (const cmd of ['format c:', 'del c:\\windows', 'rm -rf /', 'shutdown /s', ':(){ :|:& };:']) {
      expect(classifyCommand(cmd, WS).decision, `${cmd} 应 deny`).toBe('deny')
    }
  })

  it('路径穿越 → 非 allow（命中 DANGEROUS_ 原因）', () => {
    const r = classifyCommand('cat ../../etc/passwd', WS)
    expect(r.decision).not.toBe('allow')
    expect(r.reason?.startsWith('DANGEROUS_')).toBe(true)
  })

  it('环境变量绕过 → deny（%SystemRoot% 等）', () => {
    expect(classifyCommand('del %SystemRoot%\\system32', WS).decision).toBe('deny')
  })

  it('^ 转义绕过 → deny（format c^:）', () => {
    expect(classifyCommand('format c^:', WS).decision).toBe('deny')
  })

  it('普通安全命令 → allow', () => {
    expect(classifyCommand('echo hello', WS).decision).toBe('allow')
    expect(classifyCommand('dir', WS).decision).toBe('allow')
    expect(classifyCommand('node --version', WS).decision).toBe('allow')
  })

  it('危险但非黑名单 → confirm（含 DANGEROUS_ 原因）', () => {
    const r = classifyCommand('chmod 777 /etc/passwd', WS)
    expect(r.decision).toBe('confirm')
    expect(r.reason?.startsWith('DANGEROUS_')).toBe(true)
  })
})

describe('classifyMcpToolPermission — MCP 工具权限分级', () => {
  it('危险关键词 → confirm', () => {
    expect(classifyMcpToolPermission('delete_file')).toBe('confirm')
    expect(classifyMcpToolPermission('exec_command')).toBe('confirm')
    expect(classifyMcpToolPermission('write_config')).toBe('confirm')
  })

  it('只读前缀 → auto', () => {
    expect(classifyMcpToolPermission('get_user')).toBe('auto')
    expect(classifyMcpToolPermission('list_files')).toBe('auto')
    expect(classifyMcpToolPermission('search_web')).toBe('auto')
  })

  it('未知语义 → confirm', () => {
    expect(classifyMcpToolPermission('do_thing')).toBe('confirm')
    expect(classifyMcpToolPermission('process_data')).toBe('confirm')
  })

  it('只读前缀含危险词 → confirm（危险优先）', () => {
    expect(classifyMcpToolPermission('get_delete_log')).toBe('confirm')
  })
})

describe('pickSafeParams — defaultParams 白名单', () => {
  it('仅保留白名单字段', () => {
    const out = pickSafeParams({
      temperature: 0.3,
      maxTokens: 8192,
      tools: [],
      toolChoice: 'none',
      stream: false,
      model: 'evil',
      signal: 'x',
      messages: []
    } as Record<string, unknown>)
    expect(out).toEqual({ temperature: 0.3, maxTokens: 8192 })
  })

  it('null → {}', () => {
    expect(pickSafeParams(null)).toEqual({})
  })
})

describe('resolveWorkspacePath — 路径穿越 + symlink 逃逸', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fstest-'))
  const wsDir = path.join(tmpRoot, 'ws')
  const outsideDir = path.join(tmpRoot, 'outside')

  beforeAll(() => {
    fs.mkdirSync(wsDir)
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'x')
    setWorkspaceDir(wsDir)
  })
  afterAll(() => {
    setWorkspaceDir('')
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('../ 穿越被拒', () => {
    expect(() => resolveWorkspacePath('../outside/secret.txt')).toThrow(/超出工作目录/)
  })

  it('绝对路径被拒', () => {
    expect(() => resolveWorkspacePath('C:/Windows')).toThrow()
  })

  it('NUL 字节被拒', () => {
    expect(() => resolveWorkspacePath('a\u0000b')).toThrow(/非法路径/)
  })

  it('junction 指向工作区外被拒', () => {
    const link = path.join(wsDir, 'evil')
    try {
      fs.symlinkSync(outsideDir, link, 'junction')
    } catch {
      return // 无 symlink 权限时跳过
    }
    expect(() => resolveWorkspacePath('evil/secret.txt')).toThrow(/超出工作目录/)
  })
})

describe('safeMathEval — 计算器沙箱', () => {
  it('正常算术', () => {
    expect(safeMathEval('1+2*3')).toBe(7)
    expect(safeMathEval('(1+2)*3')).toBe(9)
    expect(safeMathEval('sqrt(16)')).toBe(4)
  })

  it('非法字符抛错', () => {
    expect(() => safeMathEval('require("fs")')).toThrow()
    expect(() => safeMathEval('process.exit()')).toThrow()
    expect(() => safeMathEval('1;2')).toThrow()
  })

  it('表达式过长抛错', () => {
    expect(() => safeMathEval('1+'.repeat(300))).toThrow(/过长/)
  })
})
