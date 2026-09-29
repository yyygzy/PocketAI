// 文件夹批量导入：递归扫描目录，按扩展名过滤出知识库支持的文档路径。
// 安全边界：跳过隐藏目录/文件（. 开头）、node_modules、符号链接（防循环），
// 单文件大小与单次导入数量有硬上限，防止误选超大目录拖垮入库队列。
import fs from 'node:fs'
import path from 'node:path'

/** 与 KB_DOC_ADD_FILE 文件对话框 filters 对齐的可导入扩展名 */
export const KB_IMPORT_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.xls', '.html', '.htm',
  '.txt', '.md', '.markdown', '.csv', '.json',
  '.png', '.jpg', '.jpeg', '.webp', '.gif'
])

/** 图片扩展名子集：仅 KB 配置了 OCR 视觉模型时才导入，否则扫描时跳过 */
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** 单文件上限：解析器会把整个文件读进内存（pdf-parse/XLSX.readFile），50MB 已覆盖常规文档 */
export const KB_MAX_FILE_BYTES = 50 * 1024 * 1024
/** 单次导入文件数上限：入库为顺序队列，超量会被截断并在结果中标记 */
export const KB_MAX_FILES_PER_IMPORT = 500

/** 显式排除的目录名（隐藏项已按 . 前缀统一排除，此处补充常见大目录） */
const IGNORED_DIRS = new Set(['node_modules', '__pycache__', 'target', 'dist', 'out'])

export interface FolderScanResult {
  /** 命中的可导入文件绝对路径 */
  files: string[]
  /** 因扩展名/大小/上限被跳过的文件数（仅统计文件，不含目录） */
  skippedCount: number
  /** files 达到上限被截断时为 true */
  truncated: boolean
}

/**
 * 递归扫描目录下可导入的文档（同步 fs，目录遍历开销远小于后续入库）。
 * @param includeImages 是否收图片文件（KB 已配置 OCR 视觉模型时为 true；
 *                      false 时图片计入 skippedCount，避免批量入库全部报错）
 * 目录不存在/不可读时抛错由调用方处理；空目录返回空结果。
 */
export function scanFolderFiles(dir: string, includeImages: boolean): FolderScanResult {
  const files: string[] = []
  let skippedCount = 0
  let truncated = false

  const walk = (current: string): void => {
    if (truncated) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      // 无权限等读取失败的子目录直接跳过
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue // 防符号链接循环
      const name = entry.name
      if (name.startsWith('.')) continue // 隐藏文件/目录
      const full = path.join(current, name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(name).toLowerCase()
      if (!KB_IMPORT_EXTS.has(ext)) {
        skippedCount++
        continue
      }
      // 图片仅在 KB 配置了 OCR 时收，否则视为跳过
      if (IMAGE_EXTS.has(ext) && !includeImages) {
        skippedCount++
        continue
      }
      try {
        if (fs.statSync(full).size > KB_MAX_FILE_BYTES) {
          skippedCount++
          continue
        }
      } catch {
        skippedCount++
        continue
      }
      if (files.length >= KB_MAX_FILES_PER_IMPORT) {
        truncated = true
        return
      }
      files.push(full)
    }
  }

  walk(dir)
  return { files, skippedCount, truncated }
}
