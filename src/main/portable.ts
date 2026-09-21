// 可移植性：路径锚定
// 所有数据路径以「可执行文件所在目录」为基准，不依赖 cwd、不依赖系统目录
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { AppPaths } from '../shared/types'

/**
 * 可执行文件所在目录（打包后）或项目根（开发时）。
 *
 * 优先级：
 *   1. POCKETAI_APP_ROOT 环境变量（测试覆盖）
 *   2. APPIMAGE（Linux AppImage 便携版运行时注入，指向 AppImage 文件自身路径；
 *      挂载点 /tmp/.mount_* 只读，数据必须落在 AppImage 文件旁边）
 *   3. PORTABLE_EXECUTABLE_DIR（electron-builder portable 单文件自解压运行时注入，
 *      指向原 portable exe 所在目录；若锚定 app.getPath('exe') 会落到 %TEMP% 自解压
 *      目录，USB 拔出即丢、便携性破坏）
 *   4. app.isPackaged 时锚定 exe 所在目录（NSIS 安装版：exe 在真实安装目录）
 *   5. process.cwd()（开发环境）
 */
export const APP_ROOT = process.env.POCKETAI_APP_ROOT
  ?? (app.isPackaged
    ? (process.env.APPIMAGE
        ? path.dirname(process.env.APPIMAGE)
        : process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')))
    : process.cwd())

/** 数据目录 = APP_ROOT/data（永远跟着应用走） */
export const DATA_DIR = path.join(APP_ROOT, 'data')
export const DB_PATH = path.join(DATA_DIR, 'app.db')
export const VECTOR_DB_PATH = path.join(DATA_DIR, 'vectors.db')
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments')
/**
 * 内置数据（assistants/skills）目录：打包后跟随 asar 走（只读），
 * 不能用 APP_ROOT（exe 同级目录在 asar 外，找不到内置数据）。
 * dev 时 app.getAppPath() = cwd（仓库根）；prod 时 = resources/app.asar。
 */
export const EXTENSIONS_DIR = path.join(app.getAppPath(), 'extensions')
export const LOGS_DIR = path.join(DATA_DIR, 'logs')
/** 运行时目录（存放便携 Python 等第三方运行时） */
export const RUNTIME_DIR = path.join(APP_ROOT, 'runtime')

/**
 * 当前是否为便携运行形态（数据跟随应用本体）：
 * Windows portable 单文件 exe / Linux AppImage。
 */
export function isPortableRuntime(): boolean {
  if (process.platform === 'win32') return !!process.env.PORTABLE_EXECUTABLE_DIR
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

export function getPaths(): AppPaths {
  return {
    appRoot: APP_ROOT,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    configPath: CONFIG_PATH,
    attachmentsDir: ATTACHMENTS_DIR,
    extensionsDir: EXTENSIONS_DIR
  }
}

/**
 * 确保所有**可写数据目录**存在。
 * 防御：若路径存在但不是目录（同名文件/快捷方式/损坏的符号链接），
 * 先删除再创建——旧版本可能误把文件留在此处。
 *
 * 注意：EXTENSIONS_DIR（打包进 asar 的只读内置数据）**不纳入**这里，
 * asar 是单文件，对 `resources/app.asar/extensions` 做 mkdirSync/rmSync
 * 会触发 ENOTDIR。
 */
export function ensureDirs(): void {
  const dirs = [DATA_DIR, ATTACHMENTS_DIR, LOGS_DIR, RUNTIME_DIR]
  for (const dir of dirs) {
    try {
      const st = fs.statSync(dir)
      if (!st.isDirectory()) {
        console.warn(`[portable] 路径存在但非目录，删除重建: ${dir}`)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // 路径不存在 → mkdirSync(recursive) 会创建
    }
    fs.mkdirSync(dir, { recursive: true })
  }
}
