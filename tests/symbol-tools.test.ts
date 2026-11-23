// @vitest-environment node
// 语义符号导航：真跑 TypeScript Language Service，不 mock 查询实现。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ ws: '' }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => (k === 'agent.workspace_dir' ? state.ws : null),
    set: () => {},
    delete: () => {}
  }
}))

import { getSymbolTools } from '../src/main/tools/symbol-tools'

let tools: ReturnType<typeof getSymbolTools> = []
let tool: ReturnType<typeof getSymbolTools>[number]

beforeAll(() => {
  state.ws = mkdtempSync(path.join(tmpdir(), 'pocketai-symbol-'))
  writeFileSync(path.join(state.ws, 'a.ts'),
    "export function greet(name: string): string {\n  return 'hi ' + name\n}\n", 'utf8')
  writeFileSync(path.join(state.ws, 'b.ts'),
    "import { greet } from './a'\nexport const message = greet('world')\n", 'utf8')
  writeFileSync(path.join(state.ws, 'iface.ts'),
    'export interface Speaker { speak(): string }\n', 'utf8')
  writeFileSync(path.join(state.ws, 'impl.ts'),
    "import type { Speaker } from './iface'\nexport class Dog implements Speaker { speak(): string { return 'woof' } }\n", 'utf8')
  mkdirSync(path.join(state.ws, 'node_modules', 'ghost'), { recursive: true })
  writeFileSync(path.join(state.ws, 'node_modules', 'ghost', 'index.ts'),
    'export function greet() { return 1 }\n', 'utf8')
  tools = getSymbolTools()
  tool = tools[0]!
})

afterAll(() => {
  if (state.ws) rmSync(state.ws, { recursive: true, force: true })
})

const run = (args: Record<string, unknown>) => tool.execute(args).then((raw) => JSON.parse(raw) as {
  operation: string
  count: number
  scannedFiles: number
  truncated: boolean
  symbols: Array<{ name: string; kind: string; file: string; line: number; character: number; preview: string; isDefinition?: boolean }>
})

describe('code.symbol 工具注册', () => {
  it('工作目录已设置时注册一枚 auto 只读工具', () => {
    expect(tools).toHaveLength(1)
    expect(tool.schema.id).toBe('code.symbol')
    expect(tool.schema.name).toBe('code_symbol')
    expect(tool.schema.permission).toBe('auto')
    expect(tool.schema.timeoutMs).toBe(60_000)
  })
})

describe('code.symbol 语义查询', () => {
  it('workspaceSymbol 按名字找到符号，且不扫 node_modules', async () => {
    const res = await run({ operation: 'workspaceSymbol', query: 'greet' })
    expect(res.count).toBeGreaterThan(0)
    expect(res.symbols.some((h) => h.name === 'greet' && h.file === 'a.ts')).toBe(true)
    expect(res.symbols.every((h) => !h.file.startsWith('node_modules/'))).toBe(true)
  })

  it('definition 从使用处跳到声明处', async () => {
    const res = await run({ operation: 'definition', file: 'b.ts', line: 2, character: 24 })
    expect(res.symbols.some((h) => h.file === 'a.ts' && h.line === 1)).toBe(true)
  })

  it('references 同时拿到声明与调用', async () => {
    const res = await run({ operation: 'references', file: 'b.ts', line: 2, character: 24 })
    const files = new Set(res.symbols.map((h) => h.file))
    expect(files.has('a.ts')).toBe(true)
    expect(files.has('b.ts')).toBe(true)
    expect(res.symbols.some((h) => h.isDefinition === true)).toBe(true)
  })

  it('implementation 找到 interface 的实现类', async () => {
    const res = await run({ operation: 'implementation', file: 'iface.ts', line: 1, character: 18 })
    expect(res.symbols.some((h) => h.file === 'impl.ts' && h.preview.includes('Dog'))).toBe(true)
  })

  it('maxResults 被夹到 1-100', async () => {
    const res = await run({ operation: 'workspaceSymbol', query: 'greet', maxResults: 0 })
    expect(res.symbols.length).toBeGreaterThan(0)
    expect(res.symbols.length).toBeLessThanOrEqual(100)
    expect(res.truncated).toBe(false)
  })
})

describe('code.symbol 参数守卫', () => {
  it('未知 operation 直接拒绝', async () => {
    await expect(tool.execute({ operation: 'bogus' })).rejects.toThrow('operation 必须是')
  })

  it('没有 file 也没有 query 时拒绝', async () => {
    await expect(tool.execute({ operation: 'definition' })).rejects.toThrow('必须提供 query')
  })

  it('file 穿越工作目录时拒绝', async () => {
    await expect(tool.execute({ operation: 'definition', file: '../outside.ts', line: 1, character: 1 }))
      .rejects.toThrow()
  })

  it('CRLF 文件的行列定位不偏移', async () => {
    writeFileSync(path.join(state.ws, 'crlf.ts'), 'export const alpha = 1\r\nexport const beta = alpha\r\n', 'utf8')
    const res = await run({ operation: 'definition', file: 'crlf.ts', line: 2, character: 21 })
    expect(res.symbols.some((h) => h.file === 'crlf.ts' && h.line === 1)).toBe(true)
  })
})
