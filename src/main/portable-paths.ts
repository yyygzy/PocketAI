// 跨平台共享数据的路径序列化（P1）
//
// 目标：数据库/config.json 里不再写死盘符。可移植根下的路径写成
//   ${DATA_DIR}/attachments/a.pdf 或 ${APP_ROOT}/runtime/x
// 运行时按当前平台/当前数据根解析。旧版本留下的绝对路径在读时按历史根映射回新 DATA_DIR。
//
// 注意：URL、裸命令（node/npx/-m）、普通相对路径（server.js）必须原样保留，
// 否则 MCP args 会被错误地锚到数据目录。
import path from 'node:path'
import * as electron from 'electron'

const DATA_TOKEN = '${DATA_DIR}'
const APP_TOKEN = '${APP_ROOT}'

// 不顶层 import portable.ts：很多纯函数测试会 mock electron 为路径字符串，
// 顶层加载 portable 会在 app.isPackaged 处崩。真实 app 加载 portable 后会写 globalThis，
// 这里惰性读取；缺失时退回环境变量/cwd，保证纯函数测试可用。
function globalRoot(key: string, fallback: () => string): string {
  const value = (globalThis as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : fallback()
}

function currentDataDir(): string {
  return globalRoot('__POCKETAI_DATA_DIR__', () => {
    if (process.env.POCKETAI_DATA_DIR) return path.resolve(process.env.POCKETAI_DATA_DIR)
    if (process.env.POCKETAI_APP_ROOT) return path.join(process.env.POCKETAI_APP_ROOT, 'data')
    return path.join(process.cwd(), 'data')
  })
}

function currentAppRoot(): string {
  return globalRoot('__POCKETAI_APP_ROOT__', () => process.env.POCKETAI_APP_ROOT ?? path.dirname(process.execPath))
}

function currentLegacyDataDir(): string {
  return globalRoot('__POCKETAI_LEGACY_DATA_DIR__', () => path.join(currentAppRoot(), 'data'))
}

function looksAbsolute(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  )
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

function safeRelative(root: string, target: string): string | null {
  if (!isInside(root, target)) return null
  return toPosix(path.relative(path.resolve(root), path.resolve(target)))
}

function legacyDataRoots(): string[] {
  const roots = [currentDataDir(), currentLegacyDataDir()]
  try {
    const e = electron as unknown as { app?: { getPath?: (name: string) => string } }
    const appData = e.app?.getPath?.('appData')
    if (appData) roots.push(path.join(appData, 'Moxia', 'data'))
  } catch {
    // 测试环境可能没有真实 electron app；保留前两个根即可
  }
  return [...new Set(roots.map((r) => path.resolve(r)))]
}

/** 旧绝对路径 → 相对 data/ 的后缀；映射不了返回 null */
function legacySuffix(value: string): string | null {
  const normalized = toPosix(value)
  for (const root of legacyDataRoots()) {
    const prefix = toPosix(path.resolve(root)).replace(/\/+$/, '') + '/'
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  }
  // 跨系统迁移后旧根可能属于另一台机器/另一个用户：只要能看到 Moxia/data 段就按它重绑定。
  const marker = /(?:^|\/)Moxia\/data\/(.+)$/i.exec(normalized)
  return marker?.[1] ?? null
}

/** 写库前：把可移植根下的绝对路径转成 token；其余值原样返回 */
export function serializeSharedPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value)
  if (raw === '') return ''

  if (raw === DATA_TOKEN || raw === APP_TOKEN) return raw
  if (raw.startsWith(DATA_TOKEN + '/') || raw.startsWith(DATA_TOKEN + '\\')) {
    const rel = path.posix.normalize(toPosix(raw.slice(DATA_TOKEN.length).replace(/^[\\/]+/, '')))
    return rel === '.' || rel.startsWith('..') ? DATA_TOKEN : `${DATA_TOKEN}/${rel}`
  }
  if (raw.startsWith(APP_TOKEN + '/') || raw.startsWith(APP_TOKEN + '\\')) {
    const rel = path.posix.normalize(toPosix(raw.slice(APP_TOKEN.length).replace(/^[\\/]+/, '')))
    return rel === '.' || rel.startsWith('..') ? APP_TOKEN : `${APP_TOKEN}/${rel}`
  }

  if (!looksAbsolute(raw)) return raw
  const dataRel = safeRelative(currentDataDir(), raw)
  if (dataRel !== null) return dataRel === '.' ? DATA_TOKEN : `${DATA_TOKEN}/${dataRel}`
  const appRel = safeRelative(currentAppRoot(), raw)
  if (appRel !== null) return appRel === '.' ? APP_TOKEN : `${APP_TOKEN}/${appRel}`
  return raw
}

/** 读库后：把 token / 旧绝对路径解析成当前平台可用的绝对路径 */
export function resolveSharedPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value)
  if (raw === '') return ''

  const dataDir = currentDataDir()
  const appRoot = currentAppRoot()
  if (raw === DATA_TOKEN) return path.resolve(dataDir)
  if (raw === APP_TOKEN) return path.resolve(appRoot)
  if (raw.startsWith(DATA_TOKEN + '/') || raw.startsWith(DATA_TOKEN + '\\')) {
    const rel = toPosix(raw.slice(DATA_TOKEN.length).replace(/^[\\/]+/, ''))
    const resolved = path.resolve(dataDir, rel)
    return isInside(dataDir, resolved) ? resolved : path.resolve(dataDir)
  }
  if (raw.startsWith(APP_TOKEN + '/') || raw.startsWith(APP_TOKEN + '\\')) {
    const rel = toPosix(raw.slice(APP_TOKEN.length).replace(/^[\\/]+/, ''))
    const resolved = path.resolve(appRoot, rel)
    return isInside(appRoot, resolved) ? resolved : path.resolve(appRoot)
  }

  if (!looksAbsolute(raw)) return raw
  const suffix = legacySuffix(raw)
  if (suffix) return path.join(dataDir, ...suffix.split('/').filter(Boolean))
  return raw
}

export function serializeSharedPathList(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return []
  return values.map((v) => serializeSharedPath(v) ?? String(v))
}

export function resolveSharedPathList(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return []
  return values.map((v) => resolveSharedPath(v) ?? String(v))
}
