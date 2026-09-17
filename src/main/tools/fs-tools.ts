// Agent 安全目录文件读写工具（fs.list / fs.read / fs.write）
// 安全边界：所有路径必须落在用户授权的"工作目录"内（app_config: agent.workspace_dir）。
// 校验方式复用 files-service.toAbs 的模式：反斜杠归一 → posix.normalize → resolve → 前缀校验 + NUL 检查。
// 未设置工作目录时，三个工具不注册（不会出现在 {{tools}} 中，LLM 无从调用）。
import path from 'node:path'
import fs from 'node:fs'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { BuiltinTool } from './builtin'

const WORKSPACE_KEY = 'agent.workspace_dir'
const READ_LIMIT_BYTES = 256 * 1024 // 文本读取上限，超出截断
const BINARY_PROBE_BYTES = 8192 // 前 8KB 含 NUL 视为二进制
const LIST_LIMIT = 500 // 目录列表条目上限

export function getWorkspaceDir(): string {
  return appConfigRepo.get(WORKSPACE_KEY) ?? ''
}

export function setWorkspaceDir(dir: string): void {
  if (dir) appConfigRepo.set(WORKSPACE_KEY, dir)
  else appConfigRepo.delete(WORKSPACE_KEY)
}

/** 规范化相对路径并校验落点，返回工作目录内的绝对路径 */
function toWorkspaceAbs(relPath: string): string {
  const ws = getWorkspaceDir()
  if (!ws) throw new Error('未设置 Agent 工作目录，请先在 Agent 页选择工作目录')
  const norm = path.posix
    .normalize((relPath ?? '').replace(/\\/g, '/'))
    .replace(/^\/+|\/+$/g, '')
  if (norm.includes('\0')) throw new Error('非法路径')
  const abs = path.resolve(ws, norm)
  // resolve 后必须仍落在工作目录内（防 ../、绝对路径、UNC 等穿越）
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error('路径超出工作目录范围')
  }
  return abs
}

const fsListTool: BuiltinTool = {
  schema: {
    id: 'fs.list',
    name: 'fs_list',
    description:
      '列出 Agent 工作目录下某个子目录的内容（名称、类型、大小、修改时间）。参数：path (string, 可选, 默认工作目录根)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的路径，默认 "."（根目录）' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args) {
    const rel = String(args?.path ?? '.')
    const abs = toWorkspaceAbs(rel)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`目录不存在: ${rel}`)
    }
    const names = fs.readdirSync(abs)
    const entries: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = []
    let truncated = false
    for (const name of names) {
      if (entries.length >= LIST_LIMIT) {
        truncated = true
        break
      }
      try {
        const s = fs.statSync(path.join(abs, name))
        entries.push({
          name,
          isDir: s.isDirectory(),
          size: s.isDirectory() ? 0 : s.size,
          mtime: s.mtimeMs
        })
      } catch {
        // 单个条目 stat 失败（占用/权限）跳过
      }
    }
    entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
    return JSON.stringify({ path: rel, entryCount: entries.length, truncated, entries })
  }
}

const fsReadTool: BuiltinTool = {
  schema: {
    id: 'fs.read',
    name: 'fs_read',
    description:
      '读取 Agent 工作目录下的文本文件（UTF-8，最大 256KB，超出截断；二进制文件会被拒绝）。参数：path (string)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' }
      },
      required: ['path'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args) {
    const rel = String(args?.path ?? '')
    if (!rel) throw new Error('path 不能为空')
    const abs = toWorkspaceAbs(rel)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`文件不存在: ${rel}`)
    }
    const size = fs.statSync(abs).size
    const fh = fs.openSync(abs, 'r')
    let text = ''
    let truncated = false
    try {
      const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, size))
      fs.readSync(fh, probe, 0, probe.length, 0)
      if (probe.includes(0)) throw new Error('疑似二进制文件，不支持按文本读取')
      const len = Math.min(size, READ_LIMIT_BYTES)
      const buf = Buffer.alloc(len)
      fs.readSync(fh, buf, 0, len, 0)
      text = buf.toString('utf-8')
      truncated = size > len
    } finally {
      fs.closeSync(fh)
    }
    return JSON.stringify({ path: rel, size, truncated, content: text })
  }
}

const fsWriteTool: BuiltinTool = {
  schema: {
    id: 'fs.write',
    name: 'fs_write',
    description:
      '在 Agent 工作目录内写入/覆盖文本文件（UTF-8，父目录不存在时自动创建）。参数：path (string)，content (string)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        content: { type: 'string', description: '要写入的文本内容' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args) {
    const rel = String(args?.path ?? '')
    if (!rel) throw new Error('path 不能为空')
    const content = typeof args?.content === 'string' ? args.content : ''
    const abs = toWorkspaceAbs(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const existed = fs.existsSync(abs) && fs.statSync(abs).isFile()
    fs.writeFileSync(abs, content, 'utf-8')
    return JSON.stringify({
      path: rel,
      bytes: Buffer.byteLength(content, 'utf-8'),
      created: !existed
    })
  }
}

/** 未设置工作目录时返回空数组（工具不注册） */
export function getFsTools(): BuiltinTool[] {
  return getWorkspaceDir() ? [fsListTool, fsReadTool, fsWriteTool] : []
}
