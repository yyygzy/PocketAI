// P1-3d：续跑前的工作目录内容指纹（纯文件系统，不依赖 DB/Electron）。
//
// v73 只比了工作目录**路径**；这一层补上"起点以来受控文件内容是否变了"：
//  · 每个文件存 size + sha256，必须比内容，mtime/size 变化只作为调度提示，不作为证据；
//  · 复用 dir-walk / sha256Hex / CHANGE_SET_LIMITS，不新写第三套遍历；
//  · 任一闸门超限或读失败 ⇒ degraded，绝不把半份扫描结果当"没变"。
import fs from 'node:fs'
import path from 'node:path'
import { walkEntries } from '../fs/dir-walk'
import { sha256Hex } from '../fs/hash'
import { CHANGE_SET_LIMITS, CHANGE_SET_SKIP_DIRS, type ChangeSetLimits } from './workspace-changes'

export type WorkspaceFingerprintDegradedReason =
  | 'bad-root'
  | 'too-many-files'
  | 'timeout'
  | 'too-many-bytes'
  | 'unreadable'

export interface WorkspaceFingerprintFile {
  size: number
  sha256: string
}

export type WorkspaceFingerprint =
  | {
      v: 1
      status: 'ok'
      root: string
      files: Record<string, WorkspaceFingerprintFile>
    }
  | {
      v: 1
      status: 'degraded'
      root: string
      reason: WorkspaceFingerprintDegradedReason
      files: Record<string, WorkspaceFingerprintFile>
    }

function normalizeRoot(root: string): string {
  return path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function degraded(
  root: string,
  reason: WorkspaceFingerprintDegradedReason
): WorkspaceFingerprint {
  return { v: 1, status: 'degraded', root: normalizeRoot(root), reason, files: {} }
}

/** 采集当前内容指纹；任何读不完整都返回 degraded，调用方必须 fail-closed。 */
export function createWorkspaceFingerprint(
  root: string | null | undefined,
  limits: ChangeSetLimits = CHANGE_SET_LIMITS
): WorkspaceFingerprint | null {
  const dir = String(root ?? '').trim()
  if (!dir) return null
  const abs = path.resolve(dir)
  const t0 = Date.now()
  try {
    if (!fs.statSync(abs).isDirectory()) return degraded(abs, 'bad-root')
  } catch {
    return degraded(abs, 'bad-root')
  }

  const entries: Array<{ rel: string; bytes: number; mtimeMs: number }> = []
  const status = walkEntries(abs, abs, entries, 'all', {
    maxFiles: limits.maxScanFiles,
    deadlineMs: t0 + limits.scanBudgetMs,
    skipDirNames: CHANGE_SET_SKIP_DIRS
  })
  if (status === 'too-many-files') return degraded(abs, 'too-many-files')
  if (status === 'deadline') return degraded(abs, 'timeout')

  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const files: Record<string, WorkspaceFingerprintFile> = Object.create(null) as Record<
    string,
    WorkspaceFingerprintFile
  >
  let hashedBytes = 0
  for (const e of entries) {
    if (Date.now() - t0 > limits.scanBudgetMs) return degraded(abs, 'timeout')
    if (e.bytes > limits.maxHashFileBytes) return degraded(abs, 'too-many-bytes')
    hashedBytes += e.bytes
    if (hashedBytes > limits.maxHashTotalBytes) return degraded(abs, 'too-many-bytes')
    try {
      const buf = fs.readFileSync(path.join(abs, e.rel))
      files[e.rel] = { size: e.bytes, sha256: sha256Hex(buf) }
    } catch {
      return degraded(abs, 'unreadable')
    }
  }
  return { v: 1, status: 'ok', root: normalizeRoot(abs), files }
}

/** 严格读回；坏数据一律 null，由续跑准入 fail-closed。 */
export function parseWorkspaceFingerprint(raw: string | null | undefined): WorkspaceFingerprint | null {
  if (!raw || typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.v !== 1 || (obj.status !== 'ok' && obj.status !== 'degraded')) return null
  if (typeof obj.root !== 'string') return null
  if (!obj.files || typeof obj.files !== 'object') return null
  const files = obj.files as Record<string, unknown>
  for (const [rel, value] of Object.entries(files)) {
    if (!rel || !value || typeof value !== 'object') return null
    const f = value as Record<string, unknown>
    if (typeof f.size !== 'number' || !Number.isFinite(f.size) || f.size < 0) return null
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) return null
  }
  if (obj.status === 'degraded') {
    if (typeof obj.reason !== 'string' || Object.keys(files).length > 0) return null
    return obj as unknown as WorkspaceFingerprint
  }
  return obj as unknown as WorkspaceFingerprint
}

function canonicalFiles(fp: WorkspaceFingerprint): string {
  const keys = Object.keys(fp.files).sort()
  const out: Record<string, WorkspaceFingerprintFile> = {}
  for (const k of keys) out[k] = fp.files[k]!
  return JSON.stringify(out)
}

/** unchanged / changed / unavailable；unavailable 覆盖 stored 坏、stored 降级、当前扫描降级。 */
export function compareWorkspaceFingerprint(
  raw: string | null | undefined,
  currentRoot: string | null | undefined,
  limits: ChangeSetLimits = CHANGE_SET_LIMITS
): 'unchanged' | 'changed' | 'unavailable' {
  const stored = parseWorkspaceFingerprint(raw)
  if (!stored || stored.status !== 'ok') return 'unavailable'
  const current = createWorkspaceFingerprint(currentRoot, limits)
  if (!current || current.status !== 'ok') return 'unavailable'
  return canonicalFiles(stored) === canonicalFiles(current) ? 'unchanged' : 'changed'
}
