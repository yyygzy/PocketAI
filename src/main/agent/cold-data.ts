// 冷数据的会话级清理与失败计数（P0-5 第二批）
//
// 分层：**仓储只删行，这一层只删盘，调用方按顺序串起来**。
// `conversationRepo.delete()` 是 DB 层，让它顺手 rmSync 等于让仓储依赖文件系统；
// 反过来让这里去读 DB 也不对。所以 `delete()` 把"这次删了哪几个会话（含子会话）"返回出来，
// 由 IPC 调用方把这份 id 清单交给 `purgeConversationColdData()`。
//
// 为什么删盘要跟 DB 删除同批：删了行不删文件，目录会随会话长期累积，且文件名（消息 id）
// 已经失去 DB 里的对应关系，只能等 30 天时间上限兜底。
//
// 失败处理：**计数 + 留痕，不静默**。Windows 文件锁会让 rmSync 抛 EBUSY，
// 以前 prune 里的 `catch {}` 一吞，目录就悄悄超上限。这里的计数供第三批的数据健康口径读取；
// 日志只在同一目录第一次失败时打，避免重试刷屏。

import fs from 'node:fs'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { conversationOffloadDir, defaultOffloadRoot, getOffloadPruneFailureCount } from './tool-output-offload'
import { getSnapshotPruneFailureCount } from './file-snapshots'

const log = createLogger('cold-data')

let purgeFailures = 0
const loggedPurgeFailures = new Set<string>()

export interface ColdDataFailureStats {
  /** 会话目录删除失败次数（删会话级联这一路） */
  purgeFailures: number
  /** 卸载目录淘汰失败次数（时间/字节/份数上限这一路） */
  offloadPruneFailures: number
  /** 快照目录淘汰失败次数 */
  snapshotPruneFailures: number
}

/** 供数据健康口径（第三批）读取；本批不做 UI */
export function getColdDataFailureStats(): ColdDataFailureStats {
  return {
    purgeFailures,
    offloadPruneFailures: getOffloadPruneFailureCount(),
    snapshotPruneFailures: getSnapshotPruneFailureCount()
  }
}

/**
 * 整库替换（备份恢复）后的差集：旧库有、新库没有的会话 id（含子会话——子会话行也没了，自然在差集里）。
 * 调用方必须在**恢复成功、库已重开**之后才调；拿不到新库会话清单时不要调（空集不等于空库）。
 */
export function removedConversationIds(beforeIds: string[], afterIds: string[]): string[] {
  const after = new Set(afterIds)
  return beforeIds.filter((id) => !after.has(id))
}

/**
 * 删掉一批会话的冷数据目录（整目录递归删，幂等：目录不在也算成功）。
 * **只删 `agent-tool-outputs/<conversationId>/`**，不碰旧平铺文件：
 * 旧布局的文件没有会话归属，删会话时无法判断它属于谁——误删比留着更糟。
 * 旧文件由 30 天时间上限与 512 MB 字节上限兜底。
 *
 * @returns 真正删掉的目录数
 */
export function purgeConversationColdData(
  conversationIds: string[],
  removeDir: (abs: string) => void = (abs) => fs.rmSync(abs, { recursive: true, force: true })
): number {
  if (conversationIds.length === 0) return 0
  const root = defaultOffloadRoot()
  let removed = 0
  for (const id of conversationIds) {
    const dir = conversationOffloadDir(root, id)
    try {
      removeDir(dir)
      removed++
    } catch (e) {
      purgeFailures++
      if (loggedPurgeFailures.size > 1000) loggedPurgeFailures.clear()
      if (!loggedPurgeFailures.has(dir)) {
        loggedPurgeFailures.add(dir)
        log.warn(`会话冷数据目录删除失败（累计 ${purgeFailures} 次）: ${dir}: ${errMsg(e)}`)
      }
    }
  }
  return removed
}
