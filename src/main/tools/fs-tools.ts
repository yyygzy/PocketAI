// Agent 安全目录文件读写工具（fs.list / fs.read / fs.write）
// 安全边界：所有路径必须落在用户授权的"工作目录"内（app_config: agent.workspace_dir）。
// 校验方式复用 files-service.toAbs 的模式：反斜杠归一 → posix.normalize → resolve → 前缀校验 + NUL 检查。
// 未设置工作目录时，三个工具不注册（不会出现在 {{tools}} 中，LLM 无从调用）。
import path from 'node:path'
import fs from 'node:fs'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import {
  captureSnapshot,
  defaultSnapshotRoot,
  readSnapshot,
  markConsumed,
  MAX_SNAPSHOT_BYTES
} from '../agent/file-snapshots'
import type { BuiltinTool } from './builtin'
import type { ApprovalPreviewField } from '../../shared/types'
import { buildFileDiff, diffToText } from '../../shared/fs-diff'
import { errMsg } from '../error'
import { OFFLOAD_PREFIX, defaultOffloadRoot, resolveOffloadPath } from '../agent/tool-output-offload'

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

/**
 * 规范化相对路径并校验落点，返回工作目录内的绝对路径。
 * 供 fs.* 与 shell_exec 共用（同一安全边界）。
 */
export function resolveWorkspacePath(relPath: string): string {
  const ws = getWorkspaceDir()
  if (!ws) throw new Error('未设置 Agent 工作目录，请先在 Agent 页选择工作目录')
  // `@outputs/` 是卸载引用的**保留前缀**，只有 fs_read 认它。
  // 不在这里挡掉的话：模型写出来的文件落在 `<工作目录>/@outputs/…`，而读的时候读的是应用数据目录里那一份
  // ——两条路各走各的，比直接拒绝难查得多。代价是工作目录里不能再用这个名字，注释与报错都要说清楚。
  if (relPath.startsWith(OFFLOAD_PREFIX)) throw new Error(`保留前缀 ${OFFLOAD_PREFIX} 只能用于 fs_read 回读工具输出`)
  const norm = path.posix
    .normalize((relPath ?? '').replace(/\\/g, '/'))
    .replace(/^\/+|\/+$/g, '')
  if (norm.includes('\0')) throw new Error('非法路径')
  const abs = path.resolve(ws, norm)
  // resolve 后必须仍落在工作目录内（防 ../、绝对路径、UNC 等穿越）
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error('路径超出工作目录范围')
  }
  // 符号链接逃逸防护：对目标路径上「最深存在的祖先节点」做 realpath，
  // 校验其真实路径仍落在工作目录的真实路径内。
  // 不存在的后缀（待新建的文件/目录）无法逃逸，因为它们会被创建为已校验目录的子节点。
  assertWithinWorkspaceByRealpath(abs, ws)
  return abs
}

/**
 * 校验目标路径经符号链接解析后仍落在工作目录内。
 * 策略：从目标向上找第一个存在的节点，realpath 它，与工作目录的 realpath 比较前缀。
 * 若目标路径上无任何存在节点（整条都是待创建的），则无法 follow symlink，放行。
 */
export function assertWithinWorkspaceByRealpath(targetAbs: string, wsAbs: string): void {
  let current = targetAbs
  let existing: string | null = null
  // 向上找第一个存在的节点（目录或文件）
  while (true) {
    if (fs.existsSync(current)) {
      existing = current
      break
    }
    const parent = path.dirname(current)
    if (parent === current) break // 已到文件系统根，仍不存在
    current = parent
  }
  if (!existing) return // 路径上无存在节点，无法构造 symlink 逃逸，放行

  let realWs: string
  try {
    realWs = fs.realpathSync(wsAbs)
  } catch {
    // 工作目录/数据目录本身尚不存在：路径上没有任何既存节点可用来构造逃逸，
    // 让后续 fs 操作以 ENOENT 自然失败比在这里硬报错更可诊断
    return
  }
  try {
    const realExisting = fs.realpathSync(existing)
    if (realExisting !== realWs && !realExisting.startsWith(realWs + path.sep)) {
      throw new Error('路径超出工作目录范围（符号链接逃逸）')
    }
  } catch (e) {
    // realpath 自身失败（权限/循环等）按越权处理，保守拒绝
    if (errMsg(e).includes('超出工作目录')) throw e
    throw new Error('路径校验失败')
  }
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
    const abs = resolveWorkspacePath(rel)
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
      '读取文本文件（UTF-8，最大 256KB，超出截断；二进制文件会被拒绝）。两种路径：相对 Agent 工作目录的路径；' +
      '或以 `@outputs/` 开头的**工具输出引用**（别的工具返回太长时系统会把全文存到那里，并在返回里给出这个引用）。' +
      '参数：path (string)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径，或 @outputs/... 形式的工具输出引用' }
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
    // §232：`@outputs/…` 是**卸载引用**（工具返回太长时落进应用数据目录的那份全文）。
    // 只有 fs_read 认这个前缀——fs_write/fs_list 不认，所以模型写不进这一层、也看不见别人的输出目录，
    // 它只是"这一段我留了一份可以回读"的那个回读口。
    const abs = rel.startsWith(OFFLOAD_PREFIX)
      ? resolveOffloadPath(defaultOffloadRoot(), rel)
      : resolveWorkspacePath(rel)
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
      '在 Agent 工作目录内写入/覆盖文本文件（UTF-8，父目录不存在时自动创建）。**会先请你确认改动内容**。参数：path (string)，content (string)。',
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
    // §231：从 auto 升成 confirm。理由不是"更安全"一句话——同一工具面里 shell_exec 早就要人批，
    // 而覆盖用户磁盘上的文件反倒不批，这是不对称。子 run（无人值守）会因此**拿不到 fs_write**
    // （`childToolSurface` 摘 confirm 类），这条后果记在台账 V4-Iter-231。
    permission: 'confirm'
  },
  async execute(args) {
    const rel = String(args?.path ?? '')
    if (!rel) throw new Error('path 不能为空')
    const content = typeof args?.content === 'string' ? args.content : ''
    const abs = resolveWorkspacePath(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const prev = readPrevText(abs)
    const created = prev === null
    // 旧内容不是可显示的文本（过大或含 NUL）时**干脆不留快照**：
    // 存一份空串再"还原"，等于把用户的二进制文件清成空——那比不能还原糟得多。
    const snap =
      prev === TOO_LARGE_OR_BINARY
        ? null
        : captureSnapshot(defaultSnapshotRoot(), {
            relPath: relativeWorkspacePath(abs),
            prevExists: !created,
            prevContent: typeof prev === 'string' ? prev : '',
            wroteContent: content
          })
    fs.writeFileSync(abs, content, 'utf-8')
    return JSON.stringify({
      path: rel,
      bytes: Buffer.byteLength(content, 'utf-8'),
      created,
      // 拿不到快照时如实说"这一笔不可还原"，界面就不出现「还原」按钮
      snapshotId: snap?.id ?? null,
      notRestorable: snap ? undefined : 'PREV_NOT_TEXT'
    })
  }
}

/** 快照读不到旧内容时用的哨兵（区分"文件不存在"与"太大/二进制所以没留"） */
const TOO_LARGE_OR_BINARY = Symbol('too-large-or-binary')
/**
 * 读旧内容用于快照：仅文本、仅 `MAX_SNAPSHOT_BYTES` 以内。
 * 返回 null=文件不存在；返回哨兵=存在但不肯存（二进制或过大），调用方据此报告"不可还原"。
 */
function readPrevText(abs: string): string | typeof TOO_LARGE_OR_BINARY | null {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  const size = fs.statSync(abs).size
  if (size > MAX_SNAPSHOT_BYTES) return TOO_LARGE_OR_BINARY
  const buf = fs.readFileSync(abs)
  if (buf.includes(0)) return TOO_LARGE_OR_BINARY
  return buf.toString('utf-8')
}

/** 存进快照的相对路径：由绝对路径反推，保证还原时按当时的工作目录再解析一次能指回同一文件 */
function relativeWorkspacePath(abs: string): string {
  const ws = getWorkspaceDir()
  const rel = path.relative(ws, abs).replace(/\\/g, '/')
  return rel === '' ? '.' : rel
}

export interface FileWriteRestoreResult {
  path: string
  bytes: number
  /** true=这一笔原本是在新建文件，还原即删除 */
  removed: boolean
}

/**
 * 「还原到写入前」。三条拒绝都是**必须**的，不是防御性编程：
 *  · 快照已被用过 ⇒ 再点一次会把内容倒回去造成来回跳，直接拒；
 *  · 当前内容与"我们写进去的那份"不一致 ⇒ 说明写入之后**别人（或你）又改过**，
 *    这时候还原等于吞掉那一段改动，必须让人看见而不是替你做决定；
 *  · 路径落不回当前工作目录 ⇒ 工作目录被换过，绝对路径不作数（快照只存相对路径）。
 */
export function restoreFileWrite(id: string): FileWriteRestoreResult {
  const root = defaultSnapshotRoot()
  const snap = readSnapshot(root, id)
  if (!snap) throw new Error('SNAPSHOT_NOT_FOUND:找不到这一笔写入的快照')
  if (snap.consumedAt !== null) throw new Error('SNAPSHOT_CONSUMED:这份快照已经用过了')
  const abs = resolveWorkspacePath(snap.relPath)
  const current = readPrevText(abs)
  if (typeof current === 'symbol') throw new Error('CURRENT_NOT_TEXT:当前内容不是可读文本（过大或二进制）')
  if (current !== snap.wroteContent) throw new Error('SNAPSHOT_DIVERGED:这笔写入之后文件又被改过')
  if (!snap.prevExists) {
    fs.rmSync(abs)
    markConsumed(root, id)
    return { path: snap.relPath, bytes: 0, removed: true }
  }
  fs.writeFileSync(abs, snap.prevContent, 'utf-8')
  markConsumed(root, id)
  return { path: snap.relPath, bytes: Buffer.byteLength(snap.prevContent, 'utf-8'), removed: false }
}

/** 审批弹窗上「这一笔会把什么改成什么」的预览（V4-Iter-231）；reason 一律回码，文案在四语字典 */
export interface FsWritePreview {
  fields: ApprovalPreviewField[]
  reason: string
  abs: string | null
}

/**
 * 路径守卫**在这里也走一次**：审批弹窗拿到的绝对路径必须是解析过的，
 * 不能把模型写的原始 `path` 直接显示成"要去这里改"——`../` 与绝对路径都在 `resolveWorkspacePath` 里判。
 * 这一函数不许抛：弹窗正在等一份能看的东西，判不出来就退回"路径可疑"那一档。
 */
export function buildFsWritePreview(relPath: string, content: string): FsWritePreview {
  let abs: string | null = null
  try {
    abs = resolveWorkspacePath(relPath)
  } catch {
    return {
      abs: null,
      reason: 'FS_WRITE_PATH_OUTSIDE',
      fields: [{ key: 'fs_write_path', value: relPath || '(empty)' }]
    }
  }
  const prev = readPrevText(abs)
  if (prev === TOO_LARGE_OR_BINARY) {
    // 旧内容不是可显示的文本（>2 MiB 或含 NUL）：只报新增规模，不假装做过 diff
    return {
      abs,
      reason: 'FS_WRITE_OVERWRITE_UNREADABLE',
      fields: [
        { key: 'fs_write_path', value: relPath },
        { key: 'fs_write_abs', value: abs },
        { key: 'fs_write_stats', value: `+${content.split('\n').length}` }
      ]
    }
  }
  const diff = buildFileDiff(prev, content)
  const flags = `${diff.coarse ? ' ~' : ''}${diff.truncated ? ' ⋯' : ''}`
  const body = diffToText(diff.rows) + (diff.truncated ? `\n⋯ ${diff.rows.length}/${diff.totalRows}` : '')
  return {
    abs,
    reason: diff.prevExists ? 'FS_WRITE_OVERWRITE' : 'FS_WRITE_NEW',
    fields: [
      { key: 'fs_write_path', value: relPath },
      { key: 'fs_write_abs', value: abs },
      { key: 'fs_write_stats', value: `+${diff.added} -${diff.removed}${flags}` },
      { key: 'fs_write_diff', value: body, mono: true }
    ]
  }
}

/** 未设置工作目录时返回空数组（工具不注册） */
export function getFsTools(): BuiltinTool[] {
  return getWorkspaceDir() ? [fsListTool, fsReadTool, fsWriteTool] : []
}
