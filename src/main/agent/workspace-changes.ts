// 执行后变更清单（P0-3b：只读，不回滚）
//
// 口径：**只对「被判 confirm 且用户已批准」的 shell／MCP 调用**在执行前后各扫一次受保护目录
// （现有 workspace 配置），只回答「这次改了哪些路径、大小多少」；不提供还原、不做目录级快照、不碰 git。
// 自动放行的调用不扫——每步固定两扫的代价会落到所有步骤上，而自动放行恰恰是用户没在看的那一类
// （代价推算与取值依据见 CHANGE_SET_LIMITS 的注释）；这类步骤写 `auto-allowed-not-recorded`。
//
// 三条硬约束：
// 1. 复用既有遍历（`fs/dir-walk`）与既有 sha256Hex（`fs/hash`），不新写第三套目录树遍历/哈希实现；
// 2. 哈希只在 size 或 mtime 变化时才算——每次全量读盘会把 agent 拖死；
// 3. 任一闸门（文件数/哈希总字节/耗时/变更条数）超限 → **整次降级**，
//    绝不拿半份遍历结果拼出"看起来完整"的清单。

import fs from 'node:fs'
import { walkEntries, type WalkFileEntry } from '../fs/dir-walk'
import { sha256Hex } from '../fs/hash'
import { redactSecretsInText } from '../security/audit-redact'
import type {
  WorkspaceChangeEntry,
  WorkspaceChangeSet,
  WorkspaceChangeDegradedReason
} from '../../shared/types'

/** 默认整棵跳过的目录：VCS 元数据与三方依赖不算"这次改了哪些用户文件"，也避免把闸门撑爆 */
export const CHANGE_SET_SKIP_DIRS = ['.git', 'node_modules'] as const

/**
 * 闸门默认值。为什么是这些数：全部按"宁可这次不记录，也不拖慢/撑爆"取保守值。
 *
 * 代价推算（不要凭感觉改）：本仓 2026-10 实测 21,179 个文件 ≈ 580 ms（docs/verify-checklist.md B100 记录），
 * 即 ≈ 0.027 ms/文件（≈ 3.7 文件/ms）。一次审计是前后两扫，因此**单次被审计调用**的固定开销：
 *   1k 文件 ≈ 54 ms；5k ≈ 270 ms；10k ≈ 540 ms；25k ≈ 1.35 s；30k ≈ 1.63 s。
 * 结论：≤5k 文件的工作目录，这一步开销在 0.3 s 以内（可接受）；≥10k 已到"每步多半秒"，
 * 所以扫描范围必须先收窄到「confirm 且已批准」（自动放行的调用不再固定交这笔钱）。
 * （2026-11-06 在本机复测同一份代码得到 ≈0.44 ms/次 statSync、≈0.66–0.77 ms/文件，比上面的基线慢
 *  16–35 倍——属环境异常（根因未实证），不作为取值基线；它的后果由耗时闸兜住：整次降级，不会拖死。）
 * 剩下一道闸门的选择：
 *   · `scanBudgetMs=800` 是**单次扫描**的硬上限（两扫最坏 1.6 s），按 0.027 ms/文件 折算
 *     约覆盖 29.6k 文件；它同时兜住"慢盘上同样文件数更贵"的情况；
 *   · `maxScanFiles=25_000` 是"我们打算支持多大工作目录"的口径：25k × 0.027 ≈ 675 ms，
 *     留在 800 ms 预算内、还有 125 ms 余量，且条目 Map 内存约 3–4 MB。
 *     原先的 20,000 落在预算容量之下，会让 20k–25k 的仓库**只因为文件数**先降级，
 *     而时间闸明明还装得下——两闸重叠处取"时间闸主导、文件数闸兜内存"。
 */
export const CHANGE_SET_LIMITS = {
  /** 单次遍历最多数多少个文件；工作目录超过这个量级时整次不记录 */
  maxScanFiles: 25_000,
  /** 单次遍历预算（毫秒）；前后各一次，超时即降级 */
  scanBudgetMs: 800,
  /** 单个文件超过这个大小不取内容，只标 too-large */
  maxHashFileBytes: 8 * 1024 * 1024,
  /** 一次审计里累计读盘做哈希的原始字节上限 */
  maxHashTotalBytes: 64 * 1024 * 1024,
  /** 清单条数上限；超出整次降级（不是截断成前 100 条） */
  maxChangedEntries: 100,
  /** 落库 JSON 字符上限的兜底（正常情况下条数闸门先生效） */
  maxJsonChars: 32_000
} as const

export interface ChangeSetLimits {
  maxScanFiles: number
  scanBudgetMs: number
  maxHashFileBytes: number
  maxHashTotalBytes: number
  maxChangedEntries: number
  maxJsonChars: number
}

interface ScannedFile {
  size: number
  mtimeMs: number
}

type ScanFailure = 'ok' | 'too-many-files' | 'timeout' | 'failed'

interface TreeScan {
  status: ScanFailure
  files: Map<string, ScannedFile>
  ms: number
}

export interface WorkspaceChangeAudit {
  root: string
  before: TreeScan
  limits: ChangeSetLimits
  startedAt: number
}

function scanTree(root: string, limits: ChangeSetLimits, budgetMs: number): TreeScan {
  const t0 = Date.now()
  let isDir = false
  try {
    isDir = fs.statSync(root).isDirectory()
  } catch {
    return { status: 'failed', files: new Map(), ms: Date.now() - t0 }
  }
  if (!isDir) return { status: 'failed', files: new Map(), ms: Date.now() - t0 }

  const entries: WalkFileEntry[] = []
  const status = walkEntries(root, root, entries, 'all', {
    maxFiles: limits.maxScanFiles,
    deadlineMs: t0 + budgetMs,
    skipDirNames: CHANGE_SET_SKIP_DIRS
  })
  const files = new Map<string, ScannedFile>()
  for (const e of entries) files.set(e.rel, { size: e.bytes, mtimeMs: e.mtimeMs })
  return {
    status: status === 'deadline' ? 'timeout' : status,
    files,
    ms: Date.now() - t0
  }
}

/** 前扫失败时的空 handle 仍是"要记一条降级"，不能让 NULL 演成"没有变更" */
export function beginWorkspaceChangeAudit(
  root: string | null | undefined,
  limits: ChangeSetLimits = CHANGE_SET_LIMITS
): WorkspaceChangeAudit | null {
  const dir = String(root ?? '').trim()
  if (!dir) return null
  const before = scanTree(dir, limits, limits.scanBudgetMs)
  return { root: dir, before, limits, startedAt: Date.now() }
}

interface ContentProbe {
  content: WorkspaceChangeEntry['content']
  sha?: string
  bytesRead: number
}

/** 先读 8 KiB 判断是否二进制；文本再整读做 sha256，二进制/超大不读全文 */
function probeFile(abs: string, expectedSize: number, limits: ChangeSetLimits): ContentProbe {
  if (expectedSize > limits.maxHashFileBytes) return { content: 'too-large', bytesRead: 0 }
  let fd: number | null = null
  try {
    fd = fs.openSync(abs, 'r')
    const probeLen = Math.min(8192, Math.max(0, expectedSize))
    const probe = Buffer.alloc(probeLen)
    if (probeLen > 0) fs.readSync(fd, probe, 0, probeLen, 0)
    if (probe.includes(0)) return { content: 'binary', bytesRead: probeLen }
  } catch {
    return { content: 'unreadable', bytesRead: 0 }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
  try {
    const buf = fs.readFileSync(abs)
    return { content: 'hashed', sha: sha256Hex(buf), bytesRead: buf.length }
  } catch {
    return { content: 'unreadable', bytesRead: 0 }
  }
}

interface DiffResult {
  entries: WorkspaceChangeEntry[]
  reason?: WorkspaceChangeDegradedReason
}

function diffTrees(
  root: string,
  before: Map<string, ScannedFile>,
  after: Map<string, ScannedFile>,
  limits: ChangeSetLimits
): DiffResult {
  const entries: WorkspaceChangeEntry[] = []
  let hashedBytes = 0

  /** 返回 null = 已追加；返回降级原因 = 整次作废（调用方丢掉 entries） */
  const pushWithProbe = (
    kind: 'added' | 'modified',
    rel: string,
    cur: ScannedFile
  ): WorkspaceChangeDegradedReason | null => {
    const probe = probeFile(`${root}/${rel}`, cur.size, limits)
    if (hashedBytes + probe.bytesRead > limits.maxHashTotalBytes) return 'too-many-bytes'
    hashedBytes += probe.bytesRead
    entries.push({
      // 文件名也可能被命令拼进密钥（如 `> api_key=xxx.txt`）：与 trace 参数同一套脱敏，别在这里漏
      path: redactSecretsInText(rel),
      kind,
      size: cur.size,
      content: probe.content,
      ...(probe.sha ? { afterSha: probe.sha } : {})
    })
    return entries.length > limits.maxChangedEntries ? 'too-many-changes' : null
  }

  for (const [rel, cur] of after) {
    const prev = before.get(rel)
    if (!prev) {
      const reason = pushWithProbe('added', rel, cur)
      if (reason) return { entries: [], reason }
      continue
    }
    if (prev.size === cur.size && prev.mtimeMs === cur.mtimeMs) continue
    if (prev.size === cur.size) {
      // 大小没变、mtime 变了：前扫只存了 size/mtime，事后拿不到"变更前"内容，
      // 因此**不能**假装比对过——如实标 mtime-only（大小未变，未取内容比对）。
      entries.push({ path: redactSecretsInText(rel), kind: 'modified', size: cur.size, content: 'mtime-only' })
      if (entries.length > limits.maxChangedEntries) return { entries: [], reason: 'too-many-changes' }
      continue
    }
    const reason = pushWithProbe('modified', rel, cur)
    if (reason) return { entries: [], reason }
  }

  for (const [rel, prev] of before) {
    if (after.has(rel)) continue
    if (entries.length >= limits.maxChangedEntries) return { entries: [], reason: 'too-many-changes' }
    // 删除项后扫已看不到文件：只能报变更前大小，不能伪装成"可比对"
    entries.push({ path: redactSecretsInText(rel), kind: 'deleted', size: prev.size, content: 'not-compared' })
  }

  return { entries, reason: undefined }
}

function countOf(entries: WorkspaceChangeEntry[]): WorkspaceChangeSet['counts'] {
  const counts = { added: 0, modified: 0, deleted: 0 }
  for (const e of entries) counts[e.kind]++
  return counts
}

function degraded(reason: WorkspaceChangeDegradedReason, scanMs: number): WorkspaceChangeSet {
  return { status: 'degraded', entries: [], counts: { added: 0, modified: 0, deleted: 0 }, scanMs, degradedReason: reason }
}

/**
 * 后扫 + 求差。任何一步失败都返回 degraded（entries 恒空），
 * 调用方据此把"本次未记录变更"写进 trace，而不是写"没有变更"。
 */
export function finishWorkspaceChangeAudit(audit: WorkspaceChangeAudit): WorkspaceChangeSet {
  const { root, limits, before } = audit

  if (before.status === 'failed') return degraded('before-scan-failed', before.ms)
  if (before.status === 'too-many-files') return degraded('too-many-files', before.ms)
  if (before.status === 'timeout') return degraded('timeout', before.ms)

  const after = scanTree(root, limits, limits.scanBudgetMs)
  if (after.status === 'failed') return degraded('after-scan-failed', before.ms + after.ms)
  if (after.status === 'too-many-files') return degraded('too-many-files', before.ms + after.ms)
  if (after.status === 'timeout') return degraded('timeout', before.ms + after.ms)

  const diff = diffTrees(root, before.files, after.files, limits)
  const scanMs = Date.now() - audit.startedAt
  if (diff.reason) return degraded(diff.reason, scanMs)

  return {
    status: 'ok',
    entries: diff.entries,
    counts: countOf(diff.entries),
    scanMs
  }
}

/** 落库前最后一道 JSON 上限兜底：超限同样整次降级，不截断条目 */
export function serializeWorkspaceChangeSet(cs: WorkspaceChangeSet, limits: ChangeSetLimits = CHANGE_SET_LIMITS): string {
  const json = JSON.stringify(cs)
  if (json.length <= limits.maxJsonChars) return json
  return JSON.stringify(degraded('too-many-changes', cs.scanMs))
}

/**
 * 一个工具步骤里可能有多条「confirm 且已批准」的调用（每条各自前后扫一次）：这里合并成一份清单。
 * - 任一降级 ⇒ 整步降级（理由取第一条）——不许把半份结果拼成"看起来完整"；
 * - 同一路径被两条调用都命中时只留**最早**那次观测：它描述的是"相对本步开始时该路径的形态"，
 *   后面的再次变更（例如先新增再改写）不追——这是与"删了又建"同族的已声明盲区。
 */
export function mergeWorkspaceChangeSets(
  sets: readonly WorkspaceChangeSet[],
  limits: ChangeSetLimits = CHANGE_SET_LIMITS
): WorkspaceChangeSet {
  let scanMs = 0
  for (const s of sets) scanMs += s.scanMs
  const bad = sets.find((s) => s.status === 'degraded')
  // 形状上 degraded 必带原因（本模块所有产出都经过 degraded()）；万一没有也照原样不编造，
  // 只把它演进成整步降级
  if (bad) {
    return {
      status: 'degraded',
      entries: [],
      counts: { added: 0, modified: 0, deleted: 0 },
      scanMs,
      ...(bad.degradedReason ? { degradedReason: bad.degradedReason } : {})
    }
  }

  const firstSeen = new Map<string, WorkspaceChangeEntry>()
  for (const s of sets) {
    for (const e of s.entries) if (!firstSeen.has(e.path)) firstSeen.set(e.path, e)
  }
  const entries = [...firstSeen.values()]
  if (entries.length > limits.maxChangedEntries) return degraded('too-many-changes', scanMs)
  return { status: 'ok', entries, counts: countOf(entries), scanMs }
}

/**
 * 一个 tools 步骤落进 `agent_traces.change_set` 的最终值（engine 与用例共用这一处口径）。
 * - 有被审计的确认调用 ⇒ 合并后的清单；
 * - 一条都没有、但本步确实执行过自动放行的 shell／MCP ⇒ 明确写"未记录"及原因，
 *   不能留 NULL 让用户以为是"没有变更"；
 * - 两者都没有（无目标工具／全被拒／未设工作目录）⇒ undefined（NULL＝没这一步的事）。
 */
export function buildStepChangeSet(
  audited: readonly WorkspaceChangeSet[],
  hadAutoAllowedAuditableCall: boolean,
  limits: ChangeSetLimits = CHANGE_SET_LIMITS
): string | undefined {
  if (audited.length > 0) return serializeWorkspaceChangeSet(mergeWorkspaceChangeSets(audited, limits), limits)
  if (hadAutoAllowedAuditableCall) {
    return serializeWorkspaceChangeSet(degraded('auto-allowed-not-recorded', 0), limits)
  }
  return undefined
}
