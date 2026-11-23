// 语义符号导航：用 TypeScript Language Service 在工作目录里做 workspace symbol /
// definition / references / implementation，不依赖外部 LSP 服务器，也不需要联网。
//
// 为什么不用文本搜索：本地模型最缺的是"这个函数在哪定义、谁在调用、接口有哪些实现"，
// grep 只能命中字面量，遇到别名、重导出、类型收窄就会漏。Language Service 走真实 AST，
// 能让模型把 编辑 → 查引用 → apply_patch → run_tests 串成闭环。
//
// 边界：
//  - 只读；权限 auto，不弹审批；
//  - 只扫工作目录，复用 resolveWorkspacePath 的穿越/realpath 守卫；
//  - 单次调用重建服务（无跨调用缓存），避免项目文件变化后读到旧快照；
//  - 最多 2000 个源码文件、单文件 1MB、最多返回 100 条，防止把上下文撑爆。
import ts from 'typescript'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BuiltinTool } from './builtin'
import { resolveWorkspacePath } from './fs-tools'

type Operation = 'workspaceSymbol' | 'definition' | 'references' | 'implementation'

const OPERATIONS: ReadonlySet<string> = new Set<Operation>([
  'workspaceSymbol', 'definition', 'references', 'implementation'
])
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', 'release',
  'data', '.cache', '.vscode', 'vendor'
])
const MAX_FILES = 2000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_RESULTS = 100
const DEFAULT_RESULTS = 20
const PREVIEW_CHARS = 180
const TIMEOUT_MS = 60_000

interface SymbolArgs {
  operation?: unknown
  query?: unknown
  file?: unknown
  line?: unknown
  character?: unknown
  maxResults?: unknown
}

interface Target {
  fileName: string
  position: number
}

interface Hit {
  name: string
  kind: string
  containerName?: string
  file: string
  line: number
  character: number
  preview: string
  isDefinition?: boolean
}

function assertAlive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('符号导航已中止')
}

function parseOperation(raw: unknown): Operation {
  const op = String(raw ?? '').trim()
  if (!OPERATIONS.has(op)) {
    throw new Error(`operation 必须是 ${[...OPERATIONS].join(' / ')} 之一`)
  }
  return op as Operation
}

function parseMaxResults(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RESULTS
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error('maxResults 必须是数字')
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)))
}

function parsePositiveInt(raw: unknown, label: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} 必须是 >= 1 的整数`)
  return n
}

function collectFiles(root: string, signal?: AbortSignal): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0 && out.length < MAX_FILES) {
    assertAlive(signal)
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        try {
          if (statSync(full).size <= MAX_FILE_BYTES) out.push(full)
        } catch {
          // 文件在扫描期间消失，跳过即可
        }
      }
    }
  }
  return out
}

function compilerOptions(root: string): ts.CompilerOptions {
  const configPath = path.join(root, 'tsconfig.json')
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    skipLibCheck: true
  }
  if (existsSync(configPath)) {
    try {
      const read = ts.readConfigFile(configPath, ts.sys.readFile)
      if (!read.error && read.config) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath)
        options = { ...options, ...parsed.options }
      }
    } catch {
      // tsconfig 坏了就退回内置选项，不让符号导航整体失效
    }
  }
  return { ...options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true }
}

function createService(
  root: string,
  files: string[],
  texts: Map<string, string>,
  signal?: AbortSignal
): ts.LanguageService {
  const versions = new Map<string, string>()
  for (const file of files) versions.set(file, '1')
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (file) => versions.get(file) ?? '1',
    getScriptSnapshot: (file) => {
      assertAlive(signal)
      let text = texts.get(file)
      if (text === undefined) {
        try {
          text = readFileSync(file, 'utf8')
          texts.set(file, text)
        } catch {
          return undefined
        }
      }
      return ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => compilerOptions(root),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => files.includes(file) || existsSync(file),
    readFile: (file) => {
      const cached = texts.get(file)
      if (cached !== undefined) return cached
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    },
    directoryExists: (dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    },
    useCaseSensitiveFileNames: () => process.platform !== 'win32'
  }
  return ts.createLanguageService(host, ts.createDocumentRegistry())
}

function lineCharAt(text: string, position: number): { line: number; character: number } {
  const before = text.slice(0, position)
  const line = before.split(/\r?\n/).length
  const lastNewline = before.lastIndexOf('\n')
  return { line, character: position - lastNewline }
}

function positionAt(text: string, line: number, character: number): number {
  const breaks = [...text.matchAll(/\r?\n/g)]
  if (line > breaks.length + 1) {
    throw new Error(`行号 ${line} 超出文件范围（共 ${breaks.length + 1} 行）`)
  }
  const start = line === 1 ? 0 : (breaks[line - 2]?.index ?? 0) + (breaks[line - 2]?.[0].length ?? 0)
  const end = breaks[line - 1]?.index ?? text.length
  const maxCharacter = end - start + 1
  if (character > maxCharacter) {
    throw new Error(`列号 ${character} 超出第 ${line} 行范围（共 ${maxCharacter} 个位置）`)
  }
  return start + character - 1
}

function previewAt(text: string, position: number): string {
  const { line } = lineCharAt(text, position)
  const lineText = text.split(/\r?\n/)[line - 1] ?? ''
  return lineText.trim().slice(0, PREVIEW_CHARS)
}

function resolveTarget(args: SymbolArgs, service: ts.LanguageService, texts: Map<string, string>): Target {
  if (args.file !== undefined && args.file !== null && String(args.file).trim() !== '') {
    const fileName = resolveWorkspacePath(String(args.file))
    let text = texts.get(fileName)
    if (text === undefined) {
      text = readFileSync(fileName, 'utf8')
      texts.set(fileName, text)
    }
    const query = args.query === undefined || args.query === null ? '' : String(args.query).trim()
    if (args.line !== undefined || args.character !== undefined) {
      const line = parsePositiveInt(args.line, 'line')
      const character = parsePositiveInt(args.character, 'character')
      return { fileName, position: positionAt(text, line, character) }
    }
    if (query) {
      const found = text.indexOf(query)
      if (found < 0) throw new Error(`在 ${args.file} 中找不到 query：${query}`)
      return { fileName, position: found }
    }
    throw new Error('传了 file 时还需要 line + character，或提供 query 用于定位')
  }

  const query = args.query === undefined || args.query === null ? '' : String(args.query).trim()
  if (!query) throw new Error('未提供 file，必须提供 query 用于定位符号')
  const items = service.getNavigateToItems(query, 1, undefined, true)
  const first = items[0]
  if (!first) throw new Error(`工作目录里找不到符号：${query}`)
  let text = texts.get(first.fileName)
  if (text === undefined) {
    text = readFileSync(first.fileName, 'utf8')
    texts.set(first.fileName, text)
  }
  return { fileName: first.fileName, position: first.textSpan.start }
}

function toHit(
  fileName: string,
  textSpan: ts.TextSpan,
  root: string,
  texts: Map<string, string>,
  extra: { name?: string; kind?: string; containerName?: string; isDefinition?: boolean } = {}
): Hit {
  let text = texts.get(fileName)
  if (text === undefined) {
    try {
      text = readFileSync(fileName, 'utf8')
      texts.set(fileName, text)
    } catch {
      text = ''
    }
  }
  const loc = lineCharAt(text, textSpan.start)
  return {
    name: extra.name ?? text.substr(textSpan.start, textSpan.length),
    kind: extra.kind ?? 'symbol',
    ...(extra.containerName ? { containerName: extra.containerName } : {}),
    file: path.relative(root, fileName).replace(/\\/g, '/'),
    line: loc.line,
    character: loc.character,
    preview: previewAt(text, textSpan.start),
    ...(extra.isDefinition === undefined ? {} : { isDefinition: extra.isDefinition })
  }
}

const symbolTool: BuiltinTool = {
  schema: {
    id: 'code.symbol',
    name: 'code_symbol',
    description:
      '在工作目录内做语义符号导航（只读，基于 TypeScript Language Service）。operation 取 workspaceSymbol / definition / references / implementation。查全仓库符号只需 query；查定义/引用/实现需 query（按名字定位）或 file + line + character（两者均从 1 开始）。可选 maxResults（1-100，默认 20）。返回相对路径、行列与代码预览。',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...OPERATIONS] },
        query: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        maxResults: { type: 'number' }
      },
      required: ['operation'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: TIMEOUT_MS
  },
  async execute(args, ctx) {
    const a = args as SymbolArgs
    const operation = parseOperation(a.operation)
    const maxResults = parseMaxResults(a.maxResults)
    const root = resolveWorkspacePath('.')
    assertAlive(ctx?.signal)

    const files = collectFiles(root, ctx?.signal)
    if (a.file !== undefined && a.file !== null && String(a.file).trim() !== '') {
      const targetFile = resolveWorkspacePath(String(a.file))
      if (!files.includes(targetFile)) files.push(targetFile)
    }
    const texts = new Map<string, string>()
    for (const file of files) {
      assertAlive(ctx?.signal)
      try {
        texts.set(file, readFileSync(file, 'utf8'))
      } catch {
        // 读不到的文件不进服务
      }
    }
    const service = createService(root, files, texts, ctx?.signal)
    assertAlive(ctx?.signal)

    let hits: Hit[] = []
    let rawCount = 0
    if (operation === 'workspaceSymbol') {
      const query = a.query === undefined || a.query === null ? '' : String(a.query).trim()
      if (!query) throw new Error('workspaceSymbol 必须提供 query')
      // 多取一条用于判断截断，不要靠 hits.length >= maxResults 猜（正好取满时会误报）
      const items = service.getNavigateToItems(query, maxResults + 1, undefined, true)
      rawCount = items.length
      hits = items.slice(0, maxResults).map((item) => toHit(
        item.fileName,
        item.textSpan,
        root,
        texts,
        {
          name: item.name,
          kind: String(item.kind),
          ...(item.containerName ? { containerName: item.containerName } : {})
        }
      ))
    } else {
      const target = resolveTarget(a, service, texts)
      if (operation === 'definition') {
        const defs = service.getDefinitionAtPosition(target.fileName, target.position) ?? []
        rawCount = defs.length
        hits = defs.slice(0, maxResults).map((d) => toHit(
          d.fileName, d.textSpan, root, texts,
          { name: d.name, kind: String(d.kind), containerName: d.containerName }
        ))
      } else if (operation === 'references') {
        const refs = (service.findReferences(target.fileName, target.position) ?? [])
          .flatMap((symbol) => symbol.references.map((r) => ({
            ...r,
            isDefinition: r.isDefinition
              ?? (r.fileName === symbol.definition.fileName
                && r.textSpan.start === symbol.definition.textSpan.start)
          })))
        rawCount = refs.length
        hits = refs.slice(0, maxResults).map((r) => toHit(
          r.fileName, r.textSpan, root, texts, { isDefinition: r.isDefinition }
        ))
      } else {
        const impls = service.getImplementationAtPosition(target.fileName, target.position) ?? []
        rawCount = impls.length
        hits = impls.slice(0, maxResults).map((i) => toHit(
          i.fileName, i.textSpan, root, texts, { kind: String(i.kind) }
        ))
      }
    }
    service.dispose()
    return JSON.stringify({
      operation,
      count: hits.length,
      scannedFiles: files.length,
      truncated: rawCount > maxResults,
      symbols: hits
    })
  }
}

/** 未设置工作目录时不注册（与 fs/shell/run_tests 工具同口径） */
export function getSymbolTools(): BuiltinTool[] {
  try {
    resolveWorkspacePath('.')
  } catch {
    return []
  }
  return [symbolTool]
}
