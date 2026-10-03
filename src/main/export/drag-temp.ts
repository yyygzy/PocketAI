// 导出拖拽临时文件管理（纯 node：fs/os/path，不含 electron，可单测）
// 渲染端 onPointerDown 预调 prepare-drag 写临时文件 → onDragStart 同步 send start-drag。
// startDrag 的 file 参数必须已存在于磁盘，因此需要预生成 + 路径归属校验 + 过期清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeFileName } from '../../shared/export-markdown'

/** 拖拽临时文件目录：os.tmpdir()/pocketai-export */
export function dragTempDir(): string {
  return path.join(os.tmpdir(), 'pocketai-export')
}

/** 拖拽文件最大内容（10 MB，与多选导出上限同量级；防灌爆临时目录） */
export const DRAG_CONTENT_MAX_CHARS = 10 * 1024 * 1024

/** 过期阈值：24h */
export const DRAG_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 路径归属校验：filePath 必须直接位于拖拽临时目录内（不允许子目录/目录穿越）。
 * 用于 start-drag send 通道的主进程侧防护（渲染端传什么路径都拖出去 = 任意文件泄露）。
 */
export function isDragTempPath(filePath: string, dir: string = dragTempDir()): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  const resolved = path.resolve(filePath)
  const resolvedDir = path.resolve(dir)
  // 必须直接位于目录内：dirname 相等即一级子文件（拒绝嵌套子目录与 ../ 穿越）
  return path.dirname(resolved) === resolvedDir
}

/** 清理过期拖拽临时文件（>24h）；目录不存在/单文件失败均静默（下次启动再清） */
export function cleanupDragTempDir(now: number = Date.now(), dir: string = dragTempDir()): number {
  let removed = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isFile() && now - st.mtimeMs > DRAG_TEMP_MAX_AGE_MS) {
        fs.unlinkSync(p)
        removed++
      }
    } catch { /* 单文件失败不阻断其余清理 */ }
  }
  return removed
}

/**
 * 写入拖拽临时文件：目录惰性创建 + 文件名安全化 + 内容长度上限。
 * 返回写入的完整路径；同日同名文件追加随机后缀防互相覆盖（连续多次拖拽同名导出）。
 */
export function writeDragTempFile(
  defaultName: string,
  ext: 'md' | 'png',
  content: string,
  now: number = Date.now(),
  dir: string = dragTempDir()
): string {
  if (!content || content.length > DRAG_CONTENT_MAX_CHARS) {
    throw new Error('导出内容为空或超出上限')
  }
  fs.mkdirSync(dir, { recursive: true })
  const base = safeFileName(defaultName.replace(/\.(md|png)$/i, '') || 'export')
  const suffix = Math.random().toString(36).slice(2, 8)
  const filePath = path.join(dir, `${base}-${now}-${suffix}.${ext}`)
  fs.writeFileSync(filePath, content, ext === 'md' ? 'utf8' : 'base64')
  return filePath
}
