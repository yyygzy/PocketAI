// Agent 写文件的还原快照（V4-Iter-231）
//
// 为什么要有这一层：`fs_write` 从"直接覆盖"改成"审批 + 落盘前留一份"之后，用户在界面上点「还原到写入前」
// 得有个出处。这份存储**只管存与取，不认识工作目录**——路径守卫住在 `tools/fs-tools.ts`（那里已有
// `resolveWorkspacePath` 那一套），反过来 import 会和 fs-tools 成环。
//
// 两条上限都是"要有个数"而非测出来的数，取值理由写在名字旁边：
//  · 单份上限 2 MiB：文本文件快照，超了就不是"顺手留一份"而是复制资料库；**不快照时如实返回 null**，
//    工具结果里带一个不可还原的回码，界面就不出现「还原」按钮（不出现比出现但失败诚实）。
//  · 总份数 100：按 mtime 淘汰最旧的。一次长编排写几十个文件是常见的，100 份 ×≤2MiB 在最坏情况约 200 MiB，
//    真到那一档该由数据健康屏报体积，而不是这里默默涨。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from '../portable'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('snapshot')

export interface FileSnapshot {
  id: string
  /** 相对工作目录的路径：还原时按**当时**的工作目录重新解析，绝对路径不存（换机器/换目录会指到别处） */
  relPath: string
  prevExists: boolean
  /** prevExists=false 时为空串，靠 prevExists 判"还原=删除该文件" */
  prevContent: string
  /** 这次写进去的内容：还原前用它判"我们写完之后有没有别人再改过" */
  wroteContent: string
  createdAt: number
  consumedAt: number | null
}

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOTS = 100
/** 原子写临时后缀；`.part` 不在 `listSnapshotIds`/`readSnapshot` 的解析路径上 */
const PART_SUFFIX = '.part'
const STALE_PART_MS = 60 * 60 * 1000

/**
 * 写一份 JSON 走 `.part` → rename：杀进程/断电时最多剩一个 `.part`，
 * 而 `readSnapshot` 只认 `<id>.json`，半截文件永远不会被当成一份快照读出来。
 */
function writeSnapshotAtomic(file: string, record: FileSnapshot): void {
  const part = `${file}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${PART_SUFFIX}`
  fs.writeFileSync(part, JSON.stringify(record), 'utf-8')
  try {
    fs.renameSync(part, file)
  } catch (e) {
    try {
      fs.rmSync(part, { force: true })
    } catch { /* 留待下次 prune 扫走 */ }
    throw e
  }
}

/** 淘汰失败计数（不静默；第三批数据健康口径取这个数） */
let pruneFailures = 0
const loggedPruneFailures = new Set<string>()

export function getSnapshotPruneFailureCount(): number {
  return pruneFailures
}

function recordPruneFailure(target: string, e: unknown): void {
  pruneFailures++
  if (loggedPruneFailures.size > 1000) loggedPruneFailures.clear()
  if (!loggedPruneFailures.has(target)) {
    loggedPruneFailures.add(target)
    log.warn(`快照删除失败（累计 ${pruneFailures} 次）: ${target}: ${errMsg(e)}`)
  }
}

/** 快照根目录名：数据健康的冷数据口径按它分桶，不写字面量避免两处漂移 */
export const SNAPSHOT_DIR_NAME = 'agent-file-snapshots'

export function defaultSnapshotRoot(): string {
  return path.join(DATA_DIR, SNAPSHOT_DIR_NAME)
}

/**
 * 只回答「本机还有没有这份快照」，**不读内容**。
 * 用于结果卡在**点击前**判断还原入口是否可用：异机恢复后快照文件不在本机，
 * 让用户点了才吃 `SNAPSHOT_NOT_FOUND` 是拿错误当发现手段。
 * id 形状不对或文件不存在都按 `false`（形状不对的 id 本来就不可能存在）。
 */
export function snapshotExists(id: string, root = defaultSnapshotRoot()): boolean {
  try {
    return fs.existsSync(snapshotFile(root, id))
  } catch {
    return false
  }
}

function snapshotFile(root: string, id: string): string {
  // id 由 randomUUID 生成；仍把非白名单字符挡掉，避免这个函数被别处拿用户输入直接调用
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('SNAPSHOT_ID_INVALID:快照编号形状不对')
  return path.join(root, `${id}.json`)
}

/** 工作目录之外的守卫不在这里（见文件头），这里只保证 root 存在并返回落点 */
function ensureRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true })
}

/**
 * 落一份快照。返回 null 表示**没有留**（旧内容过大）——调用方必须把这件事带到工具结果里，
 * 不能假装留了。
 */
export function captureSnapshot(
  root: string,
  input: { relPath: string; prevExists: boolean; prevContent: string; wroteContent: string }
): FileSnapshot | null {
  if (input.prevExists && Buffer.byteLength(input.prevContent, 'utf-8') > MAX_SNAPSHOT_BYTES) return null
  ensureRoot(root)
  const record: FileSnapshot = {
    id: randomUUID(),
    relPath: input.relPath,
    prevExists: input.prevExists,
    prevContent: input.prevContent,
    wroteContent: input.wroteContent,
    createdAt: Date.now(),
    consumedAt: null
  }
  writeSnapshotAtomic(snapshotFile(root, record.id), record)
  prune(root)
  return record
}

/**
 * 读一份快照。**两种事实分开**：null=没有这份快照（文件不存在，可能已被 prune 清理或从未留成）；
 * 文件存在却解析不了=就地抛 SNAPSHOT_CORRUPT，绝不折成 null。理由同 §367 那簇——把"坏了"当"没有"
 * 会让上层回一句「找不到这一笔写入的快照，可能已被清理」，而真相是快照还在、内容烂了，两种情形的
 * 处置方式不同（前者重做一次写入即可，后者得查盘）。
 */
export function readSnapshot(root: string, id: string): FileSnapshot | null {
  const file = snapshotFile(root, id)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as FileSnapshot
  } catch {
    throw new Error('SNAPSHOT_CORRUPT:快照文件存在但读不出来')
  }
}

export function markConsumed(root: string, id: string): FileSnapshot {
  const record = readSnapshot(root, id)
  if (!record) throw new Error('SNAPSHOT_NOT_FOUND:找不到这一笔写入的快照')
  const next: FileSnapshot = { ...record, consumedAt: Date.now() }
  // 原地重写也走原子替换：`markConsumed` 被杀在半截时，读到的是旧 JSON 而不是坏 JSON
  writeSnapshotAtomic(snapshotFile(root, id), next)
  return next
}

/** 快照目录下现有 id（按 mtime 从新到旧）；文件名即 id，不做递归 */
export function listSnapshotIds(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(root, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.name.slice(0, -'.json'.length))
}

/** 超出份数上限时淘汰最旧的若干份（保留最新 MAX_SNAPSHOTS 份） */
export function prune(root: string): number {
  const ids = listSnapshotIds(root)
  let removed = 0
  if (ids.length > MAX_SNAPSHOTS) {
    for (const id of ids.slice(MAX_SNAPSHOTS)) {
      try {
        fs.rmSync(snapshotFile(root, id))
        removed++
      } catch (e) {
        // 淘汰失败不影响写入本身，但**必须留痕**：Windows 文件锁会让目录悄悄超上限
        recordPruneFailure(snapshotFile(root, id), e)
      }
    }
  }
  // 半写临时文件：只清一小时前就不动的，避免抢正在写的那个
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith(PART_SUFFIX)) continue
      const abs = path.join(root, f)
      try {
        if (now - fs.statSync(abs).mtimeMs > STALE_PART_MS) {
          fs.rmSync(abs)
          removed++
        }
      } catch (e) {
        recordPruneFailure(abs, e)
      }
    }
  } catch { /* 目录不可读：下次写入再试 */ }
  return removed
}
