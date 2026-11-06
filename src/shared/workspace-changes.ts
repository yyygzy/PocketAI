// 变更清单的共享解析/文案判据（主进程写、渲染层读，两边同一套形状）
import type {
  WorkspaceChangeDegradedReason,
  WorkspaceChangeEntry,
  WorkspaceChangeSet
} from './types'

const KINDS = new Set(['added', 'modified', 'deleted'])
const CONTENTS = new Set(['hashed', 'mtime-only', 'binary', 'too-large', 'unreadable', 'not-compared'])
const REASONS = new Set([
  'too-many-files',
  'too-many-bytes',
  'timeout',
  'too-many-changes',
  'before-scan-failed',
  'after-scan-failed',
  // 自动放行的调用不记变更：同样是"本次未记录"，不能解析成"没有变更"
  'auto-allowed-not-recorded'
])

function isEntry(v: unknown): v is WorkspaceChangeEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.path === 'string' &&
    typeof e.size === 'number' &&
    KINDS.has(String(e.kind)) &&
    CONTENTS.has(String(e.content))
  )
}

/**
 * 解析 trace 里的 `changeSet` 字符串；形状不对或为空一律返回 null。
 * 渲染层必须把 null 当"没记录"，不能当"没有变更"。
 */
export function parseWorkspaceChangeSet(raw: string | null | undefined): WorkspaceChangeSet | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object') return null
    const entries = Array.isArray(v.entries) ? v.entries.filter(isEntry) : []
    const counts = v.counts as Record<string, unknown> | undefined
    const status = v.status === 'degraded' ? 'degraded' : 'ok'
    const reason = typeof v.degradedReason === 'string' && REASONS.has(v.degradedReason)
      ? (v.degradedReason as WorkspaceChangeDegradedReason)
      : undefined
    return {
      status,
      entries,
      counts: {
        added: typeof counts?.added === 'number' ? counts.added : 0,
        modified: typeof counts?.modified === 'number' ? counts.modified : 0,
        deleted: typeof counts?.deleted === 'number' ? counts.deleted : 0
      },
      scanMs: typeof v.scanMs === 'number' ? v.scanMs : 0,
      ...(status === 'degraded' && reason ? { degradedReason: reason } : {})
    }
  } catch {
    return null
  }
}
