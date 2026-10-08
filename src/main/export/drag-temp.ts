// 导出拖拽临时文件管理（纯 node：fs/os/path，不含 electron，可单测）
// 渲染端 onPointerDown 预调 prepare-drag 写临时文件 → onDragStart 同步 send start-drag。
// startDrag 的 file 参数必须已存在于磁盘，因此需要预生成 + 路径归属校验 + 过期清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
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
 * 路径归属校验：filePath 必须是**已存在的普通文件**且直接位于拖拽临时目录内。
 * 用于 start-drag send 通道的主进程侧防护（渲染端传什么路径都拖出去 = 任意文件泄露）。
 *
 * 为什么要走 realpath（SEC-15）：只比 dirname 的话，目录里放一个指向外部的符号链接
 * 就能把「目录内一级子文件」的判定变成任意文件泄露；Windows/exFAT 便携盘上同样可造
 * junction。解析后要求真实父目录仍是本目录，且本身不是链接。
 */
export function isDragTempPath(filePath: string, dir: string = dragTempDir()): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  const resolved = path.resolve(filePath)
  const resolvedDir = path.resolve(dir)
  // 快速拒绝：一级目录不符 / 嵌套子目录 / 目录穿越
  if (path.dirname(resolved) !== resolvedDir) return false
  try {
    const realFile = fs.realpathSync(resolved)
    const realDir = fs.realpathSync(resolvedDir)
    if (path.dirname(realFile) !== realDir) return false
    return fs.lstatSync(realFile).isFile()
  } catch {
    // 路径不存在 / 链接断裂 / 无权解析：一律不认（start-drag 要求文件已在磁盘上）
    return false
  }
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const base = safeFileName(defaultName.replace(/\.(md|png)$/i, '') || 'export')
  // 独占创建（wx）+ 0600：SEC-15——可预测文件名 + 无 O_EXCL 时，本机其他用户可抢先
  // 建链接让本进程覆写任意文件，或把已存在的链接文件拖出来泄露内容。
  // 随机后缀用 crypto 而非 Math.random，重试 3 次仍冲突则报错（正常情况下不会发生）。
  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = randomBytes(3).toString('hex')
    const filePath = path.join(dir, `${base}-${now}-${suffix}.${ext}`)
    try {
      const fd = fs.openSync(filePath, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, content, ext === 'md' ? 'utf8' : 'base64')
      } finally {
        fs.closeSync(fd)
      }
      return filePath
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('无法在临时目录创建独占导出文件')
}
