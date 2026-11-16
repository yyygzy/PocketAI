// 可移植性：路径锚定
// 数据默认跟着应用本体走；安装版（NSIS/dmg/deb）的安装目录会被覆盖安装整目录重建，
// 因此安装版的数据落到系统 appData 下，并在首次启动时从旧位置迁移过来。
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { AppPaths } from '../shared/types'
import { createLogger } from './logger'
import { errMsg } from './error'

const log = createLogger('portable')

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

/**
 * 旧版数据目录（≤1.2.8）：永远在应用本体旁边。
 *
 * NSIS 安装版的「安装目录」在覆盖安装时会被整个目录重建（electron-builder
 * 卸载段 `RMDir /r $INSTDIR`），所以安装目录里的数据不能当作长期落点，
 * 只能作为迁移来源。见 migrateInstalledDataDir()。
 */
export const LEGACY_DATA_DIR = path.join(APP_ROOT, 'data')

/** 安装版的数据根目录名（app.getPath('appData') 下的子目录） */
const INSTALLED_DATA_ROOT_NAME = 'Moxia'

/**
 * 数据目录落点：
 *   1. POCKETAI_APP_ROOT（测试隔离）→ APP_ROOT/data，保持旧语义、不迁移
 *   2. 开发态                       → 仓库根/data
 *   3. 便携形态（portable / AppImage）→ APP_ROOT/data（跟着应用本体，允许整体搬走）
 *   4. 安装版（NSIS / dmg / deb）    → appData/Moxia/data（脱离安装目录，覆盖安装不受影响）
 */
function resolveDataDir(): string {
  if (process.env.POCKETAI_APP_ROOT) return LEGACY_DATA_DIR
  if (!app.isPackaged) return LEGACY_DATA_DIR
  if (isPortableRuntime()) return LEGACY_DATA_DIR
  return path.join(app.getPath('appData'), INSTALLED_DATA_ROOT_NAME, 'data')
}

export const DATA_DIR = resolveDataDir()
export const DB_PATH = path.join(DATA_DIR, 'app.db')
// 向量索引没有独立文件：kb_vec_map 与按维度建的 kb_vec_<dim> 虚表都在 app.db 里
//（见 db/repositories/kb-vec.repo.ts）。这里曾有个 VECTOR_DB_PATH 常量，全仓无人使用，
// 却支撑着数据健康的「向量库」体积桶 ⇒ 那张卡片恒为空，已按真实指标改写（V4-Iter-107）。
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments')
/**
 * 内置数据（assistants/skills）目录：打包后跟随 asar 走（只读），
 * 不能用 APP_ROOT（exe 同级目录在 asar 外，找不到内置数据）。
 * dev 时 app.getAppPath() = cwd（仓库根）；prod 时 = resources/app.asar。
 * 注意：此目录只读，**不可**用于存放 MCP 服务器/venv 等可写数据。
 */
export const EXTENSIONS_DIR = path.join(app.getAppPath(), 'extensions')
/**
 * 用户可写扩展目录（MCP 服务器 + Python venv）。
 * 必须放在 DATA_DIR 下，跟随便携数据目录走；
 * 不能用 EXTENSIONS_DIR（asar 只读，便携模式下解压到 %Temp% 会被清理）。
 */
export const USER_EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions')
export const MCP_EXTENSIONS_DIR = path.join(USER_EXTENSIONS_DIR, 'mcp')
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
    extensionsDir: USER_EXTENSIONS_DIR
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
  const dirs = [DATA_DIR, ATTACHMENTS_DIR, LOGS_DIR, RUNTIME_DIR, USER_EXTENSIONS_DIR, MCP_EXTENSIONS_DIR]
  for (const dir of dirs) {
    try {
      const st = fs.statSync(dir)
      if (!st.isDirectory()) {
        log.warn(`路径存在但非目录，删除重建: ${dir}`)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // 路径不存在 → mkdirSync(recursive) 会创建
    }
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 迁移历史 MCP 扩展目录：旧版本把 MCP 服务器/venv 放在 EXTENSIONS_DIR/mcp
 * （asar 解压目录，便携模式下为 %Temp%），现迁移到 USER_EXTENSIONS_DIR/mcp
 * （DATA_DIR 下，跟随便携数据目录）。幂等。
 */
export function migrateMcpExtensionsDir(): void {
  const oldDir = path.join(EXTENSIONS_DIR, 'mcp')
  if (oldDir === MCP_EXTENSIONS_DIR) return
  try {
    if (!fs.existsSync(oldDir)) return
    const entries = fs.readdirSync(oldDir)
    if (entries.length === 0) return
    fs.mkdirSync(MCP_EXTENSIONS_DIR, { recursive: true })
    for (const name of entries) {
      const src = path.join(oldDir, name)
      const dst = path.join(MCP_EXTENSIONS_DIR, name)
      if (fs.existsSync(dst)) continue // 目标已存在，跳过（不覆盖）
      try {
        fs.renameSync(src, dst)
      } catch {
        // rename 跨卷失败（如 Temp 在 C:，DATA_DIR 在 E:）→ 复制后删除
        fs.cpSync(src, dst, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
    }
    log.info(`MCP 扩展目录已迁移: ${oldDir} → ${MCP_EXTENSIONS_DIR}`)
  } catch (e) {
    log.warn('MCP 扩展目录迁移失败（不阻塞启动）:', errMsg(e))
  }
}

// ─── 安装版数据目录迁移（≤1.2.8 的安装目录 data/ → appData/Moxia/data） ─────

/** 迁移完成标记：存在即代表新位置是迁移产物（不再看 app.db 猜） */
const MIGRATION_MARKER = 'migrated-from.json'
/** 复制中的哨兵：存在即代表新位置是半成品，下次启动先清掉重来 */
const MIGRATING_SENTINEL = '.migrating'

export interface DataMigrationResult {
  from: string
  to: string
  files: number
  bytes: number
  removedLegacy: boolean
}

function listFiles(root: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.isFile()) out.set(path.relative(root, abs), fs.statSync(abs).size)
    }
  }
  walk(root)
  return out
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 旧位置是否真的有用户数据（没有就不迁，避免搬一个空目录） */
function hasLegacyUserData(): boolean {
  return fs.existsSync(path.join(LEGACY_DATA_DIR, 'app.db'))
    || fs.existsSync(path.join(LEGACY_DATA_DIR, 'config.json'))
}

/**
 * 安装版首次启动时把安装目录里的旧数据搬到新位置。
 *
 * 语义（必须早于 ensureDirs / 开库）：
 *  - 只对「非便携的打包安装版」生效；便携版与开发态什么都不做；
 *  - 先整目录复制，再逐文件比对相对路径与字节数，并对 app.db / config.json 做
 *    SHA-256 比对，确认新位置可读后才清理旧副本；
 *  - 任一步失败：删掉新位置的半成品（原数据完整留在旧位置）并抛错，由调用方
 *    弹窗告知并退出——不能带着空库继续启动，把「丢数据」演成「全新安装」；
 *  - 成功写 migrated-from.json 作为幂等标记；旧目录删不掉只告警（数据已在新位置）。
 */
export function migrateInstalledDataDir(): DataMigrationResult | null {
  if (DATA_DIR === LEGACY_DATA_DIR) return null
  if (!fs.existsSync(LEGACY_DATA_DIR)) return null

  // 上次复制中途退出（进程被杀/断电）：新位置只是半成品，清掉重来
  if (fs.existsSync(path.join(DATA_DIR, MIGRATING_SENTINEL)) && hasLegacyUserData()) {
    log.warn(`检测到未完成的数据迁移，清理半成品后重试: ${DATA_DIR}`)
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  }

  const newHasDb = fs.existsSync(path.join(DATA_DIR, 'app.db'))
  const newHasMarker = fs.existsSync(path.join(DATA_DIR, MIGRATION_MARKER))
  if (newHasDb || newHasMarker) {
    // 新位置已有数据（例如用户先装过 1.3.0）：保留新位置，不动旧目录，只记一笔
    if (!newHasMarker && hasLegacyUserData()) {
      log.warn(`新旧两处都有数据，保留新位置并跳过迁移；旧数据仍在 ${LEGACY_DATA_DIR}`)
    }
    return null
  }
  if (!hasLegacyUserData()) return null

  const startedAt = Date.now()
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, MIGRATING_SENTINEL), JSON.stringify({ at: new Date().toISOString() }), 'utf8')
    fs.cpSync(LEGACY_DATA_DIR, DATA_DIR, { recursive: true })

    // 校验：文件集合与大小逐项一致
    const src = listFiles(LEGACY_DATA_DIR)
    const dst = listFiles(DATA_DIR)
    dst.delete(MIGRATING_SENTINEL)
    if (src.size !== dst.size) {
      throw new Error(`复制后文件数不一致：源 ${src.size}，目标 ${dst.size}`)
    }
    for (const [rel, size] of src) {
      const got = dst.get(rel)
      if (got === undefined) throw new Error(`目标缺少文件：${rel}`)
      if (got !== size) throw new Error(`文件大小不一致：${rel}（源 ${size}，目标 ${got}）`)
    }
    // 强校验：库与配置做 SHA-256 比对（这两份坏了就等于数据丢了）
    for (const name of ['app.db', 'config.json']) {
      const from = path.join(LEGACY_DATA_DIR, name)
      if (!fs.existsSync(from)) continue
      if (sha256File(from) !== sha256File(path.join(DATA_DIR, name))) {
        throw new Error(`校验和不一致：${name}`)
      }
    }
    // 确认新库可读（能打开并读出开头字节）
    const fd = fs.openSync(path.join(DATA_DIR, 'app.db'), 'r')
    try {
      const buf = Buffer.alloc(16)
      fs.readSync(fd, buf, 0, 16, 0)
    } finally {
      fs.closeSync(fd)
    }

    const marker = {
      from: LEGACY_DATA_DIR,
      to: DATA_DIR,
      at: new Date().toISOString(),
      files: src.size,
      bytes: [...src.values()].reduce((a, b) => a + b, 0),
      elapsedMs: Date.now() - startedAt
    }
    fs.writeFileSync(path.join(DATA_DIR, MIGRATION_MARKER), JSON.stringify(marker, null, 2), 'utf8')
    fs.rmSync(path.join(DATA_DIR, MIGRATING_SENTINEL), { force: true })

    let removedLegacy = false
    try {
      fs.rmSync(LEGACY_DATA_DIR, { recursive: true, force: true })
      removedLegacy = true
    } catch (e) {
      log.warn(`旧数据目录清理失败（新位置已可用，旧副本保留）: ${LEGACY_DATA_DIR}: ${errMsg(e)}`)
    }
    log.info(`安装版数据目录已迁移：${LEGACY_DATA_DIR} → ${DATA_DIR}（${marker.files} 个文件 / ${marker.bytes} 字节）`)
    return { from: marker.from, to: marker.to, files: marker.files, bytes: marker.bytes, removedLegacy }
  } catch (e) {
    // 半成品不能留：否则下次启动会把不完整的新位置当成正式数据
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true })
    } catch (cleanupErr) {
      log.error(`半成品数据目录清理失败: ${DATA_DIR}: ${errMsg(cleanupErr)}`)
    }
    throw new Error(`数据迁移失败（原数据仍在 ${LEGACY_DATA_DIR}）：${errMsg(e)}`)
  }
}
