// 文件模块服务：数据目录（DATA_DIR）文件管理器
// 安全边界：所有路径必须落在 DATA_DIR 内（resolve 后前缀校验，防路径穿越）
import { dialog, shell, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_DIR } from '../portable'
import type { FileEntry, FileReadResult, FileOpResult } from '../../shared/types'
import { errMsg } from '../error'
import { safeRelPath, safeRelDir, safeFileName, base64Content } from '../../shared/schemas/files'

const TEXT_READ_LIMIT = 256 * 1024 // 文本预览最大 256KB，超出截断
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const BINARY_EXTS = new Set([
  '.db', '.sqlite', '.exe', '.dll', '.zip', '.7z', '.gz', '.tar', '.rar',
  '.pdf', '.docx', '.xlsx', '.pptx', '.woff', '.woff2', '.ttf', '.otf',
  '.bin', '.dat', '.lic', '.so', '.dylib', '.node'
])

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

/** 规范化 relPath（'/' 或 '\' 分隔、去首尾），拒绝穿越，返回绝对路径 */
export function toAbs(relPath: string): string {
  const norm = path.posix.normalize((relPath ?? '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '')
  if (norm === '..' || norm.startsWith('../') || norm.includes('\0')) {
    throw new Error('非法路径')
  }
  const abs = path.resolve(DATA_DIR, norm)
  if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + path.sep)) {
    throw new Error('路径超出数据目录范围')
  }
  return abs
}

/** 清洗文件/文件夹名：禁路径分隔符与特殊字符 */
export function sanitizeName(name: string): string {
  const cleaned = (name ?? '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..' || /[\\/:*?"<>|\0]/.test(cleaned)) {
    throw new Error('非法文件名')
  }
  return cleaned
}

function list(relDir: string): FileEntry[] {
  const absDir = toAbs(relDir)
  if (!fs.existsSync(absDir)) return []
  const stat = fs.statSync(absDir)
  if (!stat.isDirectory()) return []
  const names = fs.readdirSync(absDir)
  const entries: FileEntry[] = []
  for (const name of names) {
    try {
      const abs = path.join(absDir, name)
      const s = fs.statSync(abs)
      entries.push({
        name,
        relPath: path.relative(DATA_DIR, abs).replace(/\\/g, '/'),
        isDir: s.isDirectory(),
        size: s.isDirectory() ? 0 : s.size,
        mtime: s.mtimeMs
      })
    } catch {
      // 单个条目 stat 失败（占用/权限）跳过，不影响整体
    }
  }
  // 目录在前，各自按名称排序（win 下跳过 localeCompare 大小写差异用本地感知）
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })
  return entries
}

function read(relPath: string): FileReadResult {
  try {
    const abs = toAbs(relPath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, kind: 'binary', content: null, size: 0, truncated: false }
    }
    const stat = fs.statSync(abs)
    const ext = path.extname(abs).toLowerCase()

    // 图片 → base64 data URL（上限 8MB，防内存爆）
    if (IMAGE_EXTS.has(ext) && stat.size <= 8 * 1024 * 1024) {
      const buf = fs.readFileSync(abs)
      return {
        ok: true,
        kind: 'image',
        content: `data:${MIME_MAP[ext] ?? 'application/octet-stream'};base64,${buf.toString('base64')}`,
        size: stat.size,
        truncated: false,
        mime: MIME_MAP[ext]
      }
    }
    // 已知二进制扩展名 → 不预览
    if (BINARY_EXTS.has(ext)) {
      return { ok: true, kind: 'binary', content: null, size: stat.size, truncated: false }
    }
    // 文本预读：先看头部是否含 NUL（二进制嗅探）
    const fd = fs.openSync(abs, 'r')
    try {
      const sniffLen = Math.min(stat.size, TEXT_READ_LIMIT)
      const buf = Buffer.alloc(sniffLen)
      fs.readSync(fd, buf, 0, sniffLen, 0)
      if (buf.subarray(0, Math.min(1024, buf.length)).includes(0)) {
        return { ok: true, kind: 'binary', content: null, size: stat.size, truncated: false }
      }
      const text = buf.toString('utf8')
      return {
        ok: true,
        kind: 'text',
        content: text,
        size: stat.size,
        truncated: stat.size > TEXT_READ_LIMIT
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return { ok: false, kind: 'binary', content: null, size: 0, truncated: false, mime: errMsg(e) }
  }
}

function upload(relDir: string, name: string, base64: string): FileOpResult {
  try {
    safeRelDir.parse(relDir)
    safeFileName.parse(name)
    base64Content.parse(base64)
    const absDir = toAbs(relDir)
    const abs = path.join(absDir, sanitizeName(name))
    if (!abs.startsWith(DATA_DIR + path.sep) && abs !== DATA_DIR) {
      return { ok: false, error: '路径超出数据目录范围' }
    }
    const buf = Buffer.from(base64, 'base64')
    if (buf.length > 100 * 1024 * 1024) return { ok: false, error: '文件超过 100MB 上限' }
    fs.mkdirSync(absDir, { recursive: true })
    // 同名自动加后缀
    let target = abs
    if (fs.existsSync(target)) {
      const ext = path.extname(abs)
      const stem = abs.slice(0, abs.length - ext.length)
      let i = 1
      do {
        target = `${stem} (${i})${ext}`
        i++
      } while (fs.existsSync(target))
    }
    fs.writeFileSync(target, buf)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

function mkdir(relDir: string, name: string): FileOpResult {
  try {
    safeRelDir.parse(relDir)
    safeFileName.parse(name)
    const absDir = toAbs(relDir)
    const abs = path.join(absDir, sanitizeName(name))
    fs.mkdirSync(abs, { recursive: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** data 根目录下的运行时关键条目：禁止删除（子内容仍可管理） */
const PROTECTED_ROOT_ENTRIES = new Set([
  'app.db', 'app.db-wal', 'app.db-shm',
  'config.json', 'vectors.db', 'attachments'
])

function remove(relPath: string): FileOpResult {
  try {
    safeRelPath.parse(relPath)
    const abs = toAbs(relPath)
    if (abs === DATA_DIR) return { ok: false, error: '不能删除数据目录本身' }
    const rel = path.relative(DATA_DIR, abs).replace(/\\/g, '/')
    if (PROTECTED_ROOT_ENTRIES.has(rel)) {
      return { ok: false, error: '系统关键文件受保护，不能删除' }
    }
    if (!fs.existsSync(abs)) return { ok: false, error: '目标不存在' }
    fs.rmSync(abs, { recursive: true, force: false })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 另存为：弹出系统保存对话框，将数据目录内文件复制到用户选择的位置 */
async function saveAs(relPath: string): Promise<FileOpResult> {
  try {
    safeRelPath.parse(relPath)
    const abs = toAbs(relPath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, error: '目标不是文件' }
    }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: path.basename(abs)
    })
    if (canceled || !filePath) return { ok: true } // 用户取消不算错误
    fs.copyFileSync(abs, filePath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

function openLocation(relPath: string): FileOpResult {
  try {
    safeRelDir.parse(relPath)
    const abs = toAbs(relPath)
    if (!fs.existsSync(abs)) return { ok: false, error: '目标不存在' }
    shell.showItemInFolder(abs)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

async function openExternal(relPath: string): Promise<FileOpResult> {
  try {
    safeRelPath.parse(relPath)
    const abs = toAbs(relPath)
    if (!fs.existsSync(abs)) return { ok: false, error: '目标不存在' }
    await shell.openPath(abs)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

export const filesService = {
  list,
  read,
  upload,
  mkdir,
  remove,
  saveAs,
  openLocation,
  openExternal
}
