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

export function defaultSnapshotRoot(): string {
  return path.join(DATA_DIR, 'agent-file-snapshots')
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
  fs.writeFileSync(snapshotFile(root, record.id), JSON.stringify(record), 'utf-8')
  prune(root)
  return record
}

export function readSnapshot(root: string, id: string): FileSnapshot | null {
  const file = snapshotFile(root, id)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as FileSnapshot
  } catch {
    return null
  }
}

export function markConsumed(root: string, id: string): FileSnapshot {
  const record = readSnapshot(root, id)
  if (!record) throw new Error('SNAPSHOT_NOT_FOUND:找不到这一笔写入的快照')
  const next: FileSnapshot = { ...record, consumedAt: Date.now() }
  fs.writeFileSync(snapshotFile(root, id), JSON.stringify(next), 'utf-8')
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
  if (ids.length <= MAX_SNAPSHOTS) return 0
  let removed = 0
  for (const id of ids.slice(MAX_SNAPSHOTS)) {
    try {
      fs.rmSync(snapshotFile(root, id))
      removed++
    } catch {
      // 淘汰失败不影响写入本身：快照目录会由数据健康屏那侧报体积
    }
  }
  return removed
}
