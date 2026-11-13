// 项目目标目录（用户工作目录侧）的解析与守卫（v71 提案）。
//
// 只接受「工作目录内的相对路径」：绝对路径 / 盘符 / UNC / `..` / 保留名 /
// 尾随点空格 / NTFS 备用数据流一律拒绝。落点校验**复用 fs-tools 那套**
// （resolve 后前缀校验 + 最深已存在祖先 realpath），不另写一份"什么算工作目录内"。
//
// 为什么不复用 `normalizeProjectPath`：那管的是**项目内部**的相对路径（index.html），
// 它会把 `app/../x` 当成合法路径；目标目录要的是"从工作目录出发的落点"，判据不同。
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspaceDir, assertWithinWorkspaceByRealpath } from '../tools/fs-tools'

/** target 字符上限（比项目内路径宽松：允许几层目录） */
export const MAX_PROJECT_TARGET_CHARS = 400
const MAX_PROJECT_NAME_CHARS = 80

/** Windows 保留设备名（含带扩展名的形式，如 CON.txt） */
export const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** 非法路径字符（含 `:`，用于挡 NTFS 备用数据流 `file:stream`） */
export const ILLEGAL_PATH_CHARS = /[<>:"|?*\x00-\x1f\x7f]/

export type ProjectTargetReason = 'PROJECT_TARGET_NO_WORKSPACE' | 'PROJECT_TARGET_INVALID'

export type ProjectTargetResult =
  | { ok: true; abs: string; rel: string }
  | { ok: false; reason: ProjectTargetReason; message: string }

const invalid = (message: string): ProjectTargetResult => ({
  ok: false,
  reason: 'PROJECT_TARGET_INVALID',
  message
})

/**
 * 解析并校验 project.create 的 `target`（工作目录内的父目录）。
 * 不抛错：classify / 审批预览 / 执行三处都要一份"能看的结果"。
 * `target` 为 `.` 表示工作目录根。
 */
export function resolveProjectTarget(raw: unknown): ProjectTargetResult {
  const ws = getWorkspaceDir()
  if (!ws) {
    return {
      ok: false,
      reason: 'PROJECT_TARGET_NO_WORKSPACE',
      message: '未设置 Agent 工作目录，无法写入工作目录目标'
    }
  }
  if (typeof raw !== 'string') return invalid('target 必须是字符串')
  // 统一按 Windows 语义把反斜杠当分隔符：用户/模型写 `a\b` 不该被当成一个含反斜杠的目录名。
  // 不做 trim：尾随空格是 Windows 上会被静默去掉的形态（`foo ` 与 `foo` 落到同一目录），
  // 这里必须显式拒绝，而不是悄悄改成另一个路径。
  const input = raw.replace(/\\/g, '/')
  if (!input) return invalid('target 不能为空')
  if (Array.from(input).length > MAX_PROJECT_TARGET_CHARS) {
    return invalid(`target 过长（上限 ${MAX_PROJECT_TARGET_CHARS} 字符）`)
  }
  // 绝对路径 / 盘符 / UNC / 根路径：`C:foo` 是盘符相对（resolve 后可能落到工作目录外），也要挡
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    return invalid('target 必须是工作目录内的相对路径（不接受绝对路径、盘符或 UNC）')
  }
  if (input.includes('\0')) return invalid('target 含非法字符')

  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return invalid('target 不能包含 ..')
    if (/[. ]$/.test(seg)) return invalid(`target 目录名不能以点或空格结尾：${seg}`)
    if (WINDOWS_RESERVED.test(seg)) return invalid(`target 命中 Windows 保留名：${seg}`)
    if (ILLEGAL_PATH_CHARS.test(seg)) return invalid(`target 含非法字符：${seg}`)
  }

  const norm = path.posix.normalize(input).replace(/^\/+|\/+$/g, '')
  if (norm === '..' || norm.startsWith('../')) return invalid('target 超出工作目录范围')
  // `@outputs/` 是卸载引用的保留前缀（见 fs-tools.resolveWorkspacePath）
  if (norm === '@outputs' || norm.startsWith('@outputs/')) {
    return invalid('target 不能使用保留前缀 @outputs')
  }

  const abs = path.resolve(ws, norm || '.')
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return invalid('target 超出工作目录范围')
  // 路径上只要经过符号链接/junction 就拒绝：realpath 只能校验"存在的节点"，
  // 而 Windows 上悬空/无权限的链接会让 existsSync 直接为 false（守卫被绕过）。
  // 项目落点必须在工作目录的真实子目录里，不让链接决定最终去向。
  const linkAt = findSymlinkPrefix(abs, ws)
  if (linkAt) {
    return invalid(`target 路径经过符号链接或 junction（${linkAt}），请直接使用真实目录`)
  }
  try {
    // 符号链接/junction 逃逸：对最深已存在祖先做 realpath 后再比一次
    assertWithinWorkspaceByRealpath(abs, ws)
  } catch (e) {
    return invalid(e instanceof Error && e.message ? e.message : 'target 路径校验失败')
  }
  try {
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      return invalid('target 不是目录')
    }
  } catch {
    return invalid('target 无法访问')
  }
  return { ok: true, abs, rel: norm || '.' }
}

/**
 * 从工作目录往下逐段 lstat，返回第一个符号链接/junction 的路径；没有就返回 null。
 * 不存在（待创建）的后缀直接停：它们会作为已校验目录的子节点被创建，无法预先指到别处。
 */
function findSymlinkPrefix(abs: string, ws: string): string | null {
  const rel = path.relative(ws, abs)
  if (!rel) return null
  let cur = ws
  for (const seg of rel.split(path.sep)) {
    if (!seg || seg === '.') continue
    cur = path.join(cur, seg)
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return cur
    } catch {
      break
    }
  }
  return null
}

/**
 * 校验渲染层送来的**绝对路径**是否落在工作目录内（打开所在目录 / 导出 ZIP 用）。
 * 与 `resolveProjectTarget` 的区别：这里不解析相对路径、不允许不存在，只做"这个绝对路径能不能碰"。
 * 拒绝形态：未设置工作目录、空串、非绝对路径、工作目录外、经过符号链接/junction、已消失、不是目录。
 */
export type WorkspaceAbsDirResult =
  | { ok: true; abs: string; name: string }
  | {
      ok: false
      code: 'PROJECT_TARGET_NO_WORKSPACE' | 'PROJECT_OPEN_DIR_DENIED' | 'PROJECT_DIR_MISSING'
      message: string
    }

const deniedDir = (message: string): WorkspaceAbsDirResult => ({
  ok: false,
  code: 'PROJECT_OPEN_DIR_DENIED',
  message
})

export function resolveWorkspaceAbsDir(raw: unknown): WorkspaceAbsDirResult {
  const ws = getWorkspaceDir()
  if (!ws) {
    return {
      ok: false,
      code: 'PROJECT_TARGET_NO_WORKSPACE',
      message: '未设置 Agent 工作目录'
    }
  }
  if (typeof raw !== 'string' || !raw.trim()) return deniedDir('路径为空')
  const input = raw.trim()
  if (input.includes('\0')) return deniedDir('路径含非法字符')
  if (!path.isAbsolute(input)) return deniedDir('只接受绝对路径')
  const abs = path.resolve(input)
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return deniedDir('路径不在工作目录内')
  const linkAt = findSymlinkPrefix(abs, ws)
  if (linkAt) return deniedDir(`路径经过符号链接或 junction（${linkAt}）`)
  try {
    assertWithinWorkspaceByRealpath(abs, ws)
  } catch (e) {
    return deniedDir(e instanceof Error && e.message ? e.message : '路径校验失败')
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return {
      ok: false,
      code: 'PROJECT_DIR_MISSING',
      message: '目录已不在磁盘上（可能已被移动或删除）'
    }
  }
  if (!stat.isDirectory()) return deniedDir('路径不是目录')
  return { ok: true, abs, name: path.basename(abs) }
}

/**
 * 在父目录里按**不区分大小写**找同名条目。
 * Windows 上 `existsSync` 本身就不区分大小写；这里额外扫一遍是为了让
 * POSIX（CI/Linux）也保持同一语义，避免同一个项目在大小写不同的两套目录里各写一份。
 */
export function findCaseInsensitiveEntry(parentAbs: string, name: string): string | null {
  try {
    if (!fs.existsSync(parentAbs)) return null
    if (!fs.statSync(parentAbs).isDirectory()) return null
    const want = name.toLowerCase()
    for (const ent of fs.readdirSync(parentAbs, { withFileTypes: true })) {
      if (ent.name.toLowerCase() === want) return ent.name
    }
    return null
  } catch {
    // 读不到就当"没有"：后续 rename 会在同一位置再失败一次，错误面更准确
    return null
  }
}

/** 清洗项目名成为可用的目录名（与 v70 口径一致），并入到目标目录一侧供预览复用 */
export function cleanProjectName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const clipped = Array.from(s).slice(0, MAX_PROJECT_NAME_CHARS).join('')
  if (!clipped) return '未命名项目'
  return WINDOWS_RESERVED.test(clipped) || clipped.startsWith('.') ? `_${clipped}` : clipped
}
