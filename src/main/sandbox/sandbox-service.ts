// 沙箱产物服务（V2 批次八 / 九）
//
// HTML 产物落盘 data/sandbox/{uuid}.html，元数据入 sandbox_files 表（v14/v15）。
// 安全：路径守卫（DATA_DIR 前缀 + NUL，防库被篡改后穿越）、单文件 256KB 上限、名称清洗。
// 渲染侧的安全（iframe sandbox + CSP 注入）在 SandboxModule.tsx，此处只管存储。
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from '../portable'
import { sandboxRepo } from '../db/repositories/sandbox.repo'
import type { SandboxFileMeta } from '../../shared/types'

const SANDBOX_DIR_NAME = 'sandbox'
export const MAX_HTML_BYTES = 256 * 1024
const MAX_NAME_CHARS = 60
const MAX_DESC_CHARS = 200
const DEFAULT_ICON = '📦'

/** 把 DB 存的相对路径解析到 DATA_DIR 内的绝对路径（防库被篡改后穿越） */
function resolveDataPath(rel: string): string {
  const norm = path.posix.normalize((rel ?? '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '')
  if (norm.includes('\0')) throw new Error('非法路径')
  const abs = path.resolve(DATA_DIR, norm)
  if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + path.sep)) {
    throw new Error('路径超出数据目录范围')
  }
  return abs
}

/** 清洗名称：控制符 → 空格，trim，截断 60 字符，空值给默认名 */
function cleanName(name: string, fallback = '未命名'): string {
  return (
    String(name ?? '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, MAX_NAME_CHARS) || fallback
  )
}

/** 清洗图标：取首个 emoji/可见字符，空值给默认 */
function cleanIcon(icon: string): string {
  const s = String(icon ?? '').trim()
  if (!s) return DEFAULT_ICON
  // 取第一个 grapheme（粗略：取首字符即可，emoji 通常占 1-2 个码元）
  return Array.from(s)[0] ?? DEFAULT_ICON
}

/** 清洗描述：控制符清除，截断 200 字符 */
function cleanDescription(desc: string): string {
  return String(desc ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_DESC_CHARS)
}

export function listSandboxFiles(): SandboxFileMeta[] {
  return sandboxRepo.list()
}

export interface CreateSandboxOptions {
  icon?: string
  description?: string
  isApp?: boolean
}

export function createSandboxFile(
  name: string,
  html: string,
  opts: CreateSandboxOptions = {}
): SandboxFileMeta {
  const content = String(html ?? '')
  if (!content.trim()) throw new Error('HTML 内容不能为空')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_HTML_BYTES) {
    throw new Error(`HTML 内容超过 ${Math.floor(MAX_HTML_BYTES / 1024)}KB 上限`)
  }
  const id = randomUUID()
  const fileName = `${id}.html`
  fs.mkdirSync(sandboxDir(), { recursive: true })
  fs.writeFileSync(resolveDataPath(`${SANDBOX_DIR_NAME}/${fileName}`), content, 'utf8')
  const meta: SandboxFileMeta = {
    id,
    name: cleanName(name),
    size: bytes,
    createdAt: Date.now(),
    icon: cleanIcon(opts.icon ?? ''),
    description: cleanDescription(opts.description ?? ''),
    isApp: !!opts.isApp
  }
  sandboxRepo.insert(meta, fileName)
  return meta
}

export function getSandboxFile(id: string): { meta: SandboxFileMeta; html: string } | null {
  const row = sandboxRepo.get(String(id ?? ''))
  if (!row) return null
  const abs = resolveDataPath(`${SANDBOX_DIR_NAME}/${row.fileName}`)
  if (!fs.existsSync(abs)) return null
  const html = fs.readFileSync(abs, 'utf8')
  return {
    meta: {
      id: row.id,
      name: row.name,
      size: row.size,
      createdAt: row.createdAt,
      icon: row.icon,
      description: row.description,
      isApp: row.isApp
    },
    html
  }
}

/** 更新产物元数据（字段白名单 + 清洗） */
export function updateSandboxMeta(
  id: string,
  patch: { name?: string; icon?: string; description?: string; isApp?: boolean }
): SandboxFileMeta | null {
  const row = sandboxRepo.get(String(id ?? ''))
  if (!row) return null
  const cleanPatch: { name?: string; icon?: string; description?: string; isApp?: boolean } = {}
  if (patch.name !== undefined) cleanPatch.name = cleanName(patch.name, row.name)
  if (patch.icon !== undefined) cleanPatch.icon = cleanIcon(patch.icon)
  if (patch.description !== undefined) cleanPatch.description = cleanDescription(patch.description)
  if (patch.isApp !== undefined) cleanPatch.isApp = !!patch.isApp
  sandboxRepo.updateMeta(id, cleanPatch)
  const updated = sandboxRepo.get(id)
  if (!updated) return null
  const { fileName, ...meta } = updated
  return meta
}

export function deleteSandboxFile(id: string): void {
  const row = sandboxRepo.get(String(id ?? ''))
  if (!row) return
  sandboxRepo.delete(row.id)
  try {
    fs.rmSync(resolveDataPath(`${SANDBOX_DIR_NAME}/${row.fileName}`), { force: true })
  } catch {
    // 文件已不在磁盘时忽略；元数据已删除即视为成功
  }
}

function sandboxDir(): string {
  return path.join(DATA_DIR, SANDBOX_DIR_NAME)
}
