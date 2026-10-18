// 浏览器 HTTP 缓存的清理动作（V4-Iter-189，落点按台账 V4-Iter-182 定的 C：只有用户按按钮时才发生）
//
// 三条设计约束，都写在 V4-Iter-182 里，这里逐条落地：
// 1) **只走 `session.clearCache()`**，不做文件系统删除——档案树里的文件正被 Chromium 持有，
//    fs 删有半态风险，而 clearCache 走的是它自己的淘汰路径；
// 2) **能力范围只有 HTTP 缓存**：`Cache/` 归它，`Code Cache/` 不归（本机实测 Cache 584.0 MB / 7,486 个文件，
//    Code Cache 184.2 MB / 14,088 个文件），所以清理后不可能把档案树清零，文案与日志都不许承诺"全部释放"。
//    而且只覆盖 `userData` 那一棵：独立实例实测全新档案根下 `sessionData`（`data/session`）只剩 `Dictionaries`
//    一个文件，HTTP 缓存全在 `userdata/Cache/`；本机那 249 MB 的 `session/Cache/` 是 2026-09-27 之前的遗留树，
//    这条路碰不到（台账 V4-Iter-189）。清完字节掉、文件数几乎不掉——Chromium 截断 blockfile 而非删除。
// 3) 清完必须让 V4-Iter-177 那颗进程内 memo 失效，否则界面上的数字不动——这里靠"清理前后各以 refresh 现数一次"顺带做到。
import { session } from 'electron'
import { errMsg } from '../error'
import { createLogger } from '../logger'
import { browserCacheTreeBreakdown, getBrowserCacheStats } from './data-health'

const log = createLogger('cache')

export interface BrowserCacheCleanResult {
  ok: boolean
  beforeBytes: number
  afterBytes: number
  error?: string
}

/**
 * 清 default session 的 HTTP 缓存，并回报清理前后的档案树体积。
 * 不接收任何路径入参（与「打开数据目录」那条通道同一口径：少一处校验面）。
 */
export async function clearBrowserHttpCache(): Promise<BrowserCacheCleanResult> {
  // refresh=true：拿到"此刻的真数"，同时把 memo 换掉
  const before = getBrowserCacheStats(true)
  try {
    await session.defaultSession.clearCache()
  } catch (e) {
    // 失败要说失败：清理没做成却回 {ok:true}，等于让界面显示一个没发生的数
    log.warn(`浏览器缓存清理失败：${errMsg(e)}`)
    const after = getBrowserCacheStats(true)
    return { ok: false, beforeBytes: before.bytes, afterBytes: after.bytes, error: errMsg(e) }
  }
  const after = getBrowserCacheStats(true)
  log.info(
    `浏览器 HTTP 缓存清理：${before.bytes} B / ${before.files} 个 → ${after.bytes} B / ${after.files} 个`
  )
  // 分树明细：回答「userdata 与 session 到底谁被清了」（V4-Iter-182 的未证问题之一）
  for (const t of browserCacheTreeBreakdown()) {
    log.info(`  分树 ${t.tree}: ${t.bytes} B / ${t.files} 个`)
  }
  return { ok: true, beforeBytes: before.bytes, afterBytes: after.bytes }
}
