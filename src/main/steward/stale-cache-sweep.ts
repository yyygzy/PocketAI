// 遗留浏览器缓存档案树的启动后清扫（V4-Iter-193，落点按台账 V4-Iter-192 定的 D2 ＋ 范围 S1）
//
// 为什么需要它：`session.defaultSession.clearCache()` 只覆盖当前 Electron 真正在用的那一棵
// （190 在独立实例里实测：全新档案根下 HTTP 缓存全在 `userdata/Cache/`，而 `sessionData` 只剩
// `Dictionaries`），所以数据健康那一格里由 Electron 升档遗留下来的一整棵旧 profile 缓存清不掉——
// 本机实测 331,339,518 B／7,494 个文件、mtime 全停在 21 天前。要拿回这些字节只能走文件系统删除。
//
// 四条安全轨，都是 192/194 实测出来的形状：
// 1) **活根之下的一律不删**：当前 Electron 的 HTTP 缓存在 `<userData>/Cache`（190 实测），
//    所以判定"遗留"的前提是"这棵不在 `app.getPath('userData')` 之下"。mtime 只是第二层——
//    单靠 mtime 会把"整机闲置 8 天后启动"的活缓存当遗留删掉（194 修的就是这条，193 交付时没看出来）。
//    再加一条前提：活根下确实有同名缓存；没有就说明档案根又翻转了，这种不确定状态下宁可一个都不删。
// 2) **新鲜度闸门**：看目录本身**与其直接子目录**的 mtime（Chromium 用磁盘缓存时会不断在
//    `Cache_Data/` 里增删文件 ⇒ 那层 mtime 必然是新的），7 天内碰过的一律不删。
// 3) **不做递归删，也不原地逐文件删**：192 实测运行中的 Chromium 会占住
//    `Cache/No_Vary_Search/journal.baj`（winerror 32，随后 rmdir 报 145 DIR_NOT_EMPTY），naive 递归强删
//    就抛在那儿，留下"数据文件没了、索引骨架还在"的半态。这里先把整棵**改名**成 `*.sweep-stale`
//    （同卷原子；改名失败＝还在被用，整棵跳过），再逐文件删改名后的树，字节与文件数**只累加真正删掉的**
//    那些。中途退出留下的是一棵可识别的暂存目录，下次启动先收掉，而不是半态。
// 4) **只碰这两个目录名**：`Dictionaries`（spellcheck 词典，删了要联网重下，与便携盘离线场景冲突）
//    与其余任何档案文件都不在射程内；路径全部由常量拼出，**不接收任何入参**（190 真机里那本词典
//    被清扫后当场被应用重写成 451,968 B，可见它确实还活着）。
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { app } from 'electron'
import { BROWSER_PROFILE_DIR_NAMES } from '../../shared/data-dirs'
import { errMsg } from '../error'
import { createLogger } from '../logger'
import { DATA_DIR } from '../portable'

const log = createLogger('cache')

/** 可回收的那两个目录名（Chromium 自己的命名，不是本应用的产物） */
const CACHE_DIR_NAMES: readonly string[] = ['Cache', 'Code Cache']

/** 判断"活根"用的标记目录：当前 Electron 的 HTTP 缓存一定在它下面（190 实测） */
const LIVE_ROOT_MARKER = 'Cache'

/** 改名暂存用的后缀：中途退出留下的就是它，下次启动先收掉 */
const STAGING_SUFFIX = '.sweep-stale'

/** 闸门：目录（含其直接子目录）超过这个年龄没被写过，才认定它不属于当前运行时 */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface SweepTarget {
  dir: string
  bytes: number
  files: number
}

export interface SweepResult {
  freedBytes: number
  freedFiles: number
  busyFiles: number
  targets: string[]
  ms: number
}

/** DATA_DIR 下所有"档案树 × 缓存目录名"的候选路径（顺序稳定，便于日志对账） */
export function cacheDirCandidates(): string[] {
  const out: string[] = []
  for (const tree of BROWSER_PROFILE_DIR_NAMES) {
    for (const name of CACHE_DIR_NAMES) {
      out.push(path.join(DATA_DIR, tree, name))
    }
  }
  return out
}

/** 目录自身与其直接子目录的最大 mtime；读不到就返回 0（当作不可用，跳过删除） */
function freshnessMs(dir: string): number {
  try {
    let max = fs.statSync(dir).mtimeMs
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      try {
        max = Math.max(max, fs.statSync(path.join(dir, e.name)).mtimeMs)
      } catch { /* 单个子目录读不到不影响判定 */ }
    }
    return max
  } catch {
    return 0
  }
}

/** 当前运行时真正在用的档案根（190 实测：HTTP 缓存就落在这棵下面，`sessionData` 只剩 `Dictionaries`） */
export function liveProfileRoot(): string {
  return app.getPath('userData')
}

/** child 是否落在 parent 目录之内（两边都 resolve，避免相对/绝对混比） */
function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(p + path.sep)
}

/**
 * 候选里哪些该删，三道闸：
 *  1) **活根之下的一律不删**——`<userData>/Cache` 是 190 实测的活落点。这一条与 mtime 无关：
 *     整台机器闲置三个月后启动，那棵仍是"用户的资产"而不是遗留（V4-Iter-194 补的，之前只看 mtime
 *     会把休眠的活树当遗留删掉，正撞在 182 那条"缓存对离线/USB 是资产"的口径上）。
 *  2) **活根下确实有同名缓存**才继续——若 `<userData>/Cache` 不存在，说明当前 Electron 的缓存根
 *     不是我们以为的那一个（档案根历史上就翻转过一次），这种不确定状态下宁可一个都不删。
 *  3) 存在、是**真目录**（不是符号链接）、且目录与其直接子目录 7 天内都没被写过。
 */
export function pickStaleTargets(candidates: string[], nowMs: number, liveRoot: string = liveProfileRoot()): string[] {
  try {
    if (!fs.existsSync(path.join(liveRoot, LIVE_ROOT_MARKER))) return []
  } catch {
    return []
  }
  const stale: string[] = []
  for (const dir of candidates) {
    if (isUnder(dir, liveRoot)) continue
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      log.warn(`跳过非目录或符号链接的缓存路径：${dir}`)
      continue
    }
    const fresh = freshnessMs(dir)
    if (fresh === 0 || nowMs - fresh < STALE_AFTER_MS) continue
    stale.push(dir)
  }
  return stale
}

/** 上一轮被中断留下的暂存目录（改名后没删完的那棵） */
export function findStagingLeftovers(): string[] {
  const out: string[] = []
  for (const tree of BROWSER_PROFILE_DIR_NAMES) {
    const base = path.join(DATA_DIR, tree)
    let names: string[]
    try {
      names = fs.readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) {
      if (n.endsWith(STAGING_SUFFIX)) out.push(path.join(base, n))
    }
  }
  return out
}

/** 累计一棵子树的字节与文件数（逐文件，不跟随符号链接） */
async function measure(dir: string): Promise<SweepTarget> {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries: string[]
    try {
      entries = await fs.promises.readdir(cur)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = path.join(cur, name)
      let st
      try {
        st = await fs.promises.lstat(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (st.isFile()) {
        bytes += st.size
        files += 1
      }
    }
  }
  return { dir, bytes, files }
}

/**
 * 逐文件删：字节与文件数**只累加真正删掉的那些**（194 修的：原来是"删成一个就报整树"，
 * 部分失败时日志里会出现没发生的数）。失败只 warn 第一条并计数——7,494 个文件逐个
 * 同步写日志会把这条后台任务变成第二个问题。
 */
export async function removeTree(dir: string, unlink: (p: string) => Promise<void> = (p) => fs.promises.rm(p)): Promise<{
  removedFiles: number
  removedBytes: number
  failed: number
}> {
  let removedFiles = 0
  let removedBytes = 0
  let failed = 0
  let firstFailure: string | null = null
  const stack = [dir]
  const dirs: string[] = []
  while (stack.length) {
    const cur = stack.pop()!
    let entries: string[]
    try {
      entries = await fs.promises.readdir(cur)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = path.join(cur, name)
      let st
      try {
        st = await fs.promises.lstat(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(p)
        dirs.push(p)
        continue
      }
      try {
        await unlink(p)
        removedFiles += 1
        // 删之前那份 stat 就是它占的字节；符号链接指向多大的文件都不算进来（lstat 给的是链接自身）
        if (st.isFile()) removedBytes += st.size
      } catch (e) {
        failed += 1
        if (!firstFailure) firstFailure = `${p}（${errMsg(e)}）`
      }
    }
  }
  for (const d of dirs.reverse()) {
    try {
      await fs.promises.rmdir(d)
    } catch { /* 里面还有删不掉的东西，留着下次再说 */ }
  }
  try {
    await fs.promises.rmdir(dir)
  } catch { /* 同上 */ }
  if (failed && firstFailure) log.warn(`有 ${failed} 个文件删不掉（多为仍被占用），首个：${firstFailure}`)
  return { removedFiles, removedBytes, failed }
}

/**
 * 先整体改名再删：`Cache` → `Cache.sweep-stale`。
 * 改名是同卷一次原子操作，成功之后这棵树就与运行时彻底无关；即便中途退出，
 * 留下的也是一棵**可识别的暂存目录**（下次启动先收掉），而不是 192 实测的那种
 * "数据文件没了、索引骨架还在"的半态。改名失败（Windows 上目录被占用会 EBUSY）
 * 就整棵跳过——那正好是"还在用"的额外证据。
 */
async function stage(dir: string): Promise<string | null> {
  const target = dir + STAGING_SUFFIX
  try {
    await fs.promises.rename(dir, target)
    return target
  } catch (e) {
    log.warn(`无法与运行时隔离（改名失败，按仍在使用的情况跳过）：${dir}（${errMsg(e)}）`)
    return null
  }
}

/** 对给定的一组目标做"改名→删暂存"，逐文件如实计数（启动路径与用例共用） */
export async function sweepGivenTargets(targets: string[]): Promise<SweepResult> {
  const t0 = performance.now()
  let freedBytes = 0
  let freedFiles = 0
  let busyFiles = 0
  const swept: string[] = []
  for (const dir of targets) {
    const before = await measure(dir)
    const staged = await stage(dir)
    if (!staged) continue
    const done = await removeTree(staged)
    freedBytes += done.removedBytes
    freedFiles += done.removedFiles
    busyFiles += done.failed
    swept.push(dir)
    log.info(`  ${path.relative(DATA_DIR, dir)}：应释放 ${before.bytes} B／${before.files} 个，实删 ${done.removedBytes} B／${done.removedFiles} 个，删不掉 ${done.failed} 个`)
  }
  const ms = Math.round(performance.now() - t0)
  log.info(`遗留浏览器缓存清扫完成：释放 ${freedBytes} B／${freedFiles} 个，仍占用 ${busyFiles} 个，耗时 ${ms}ms`)
  return { freedBytes, freedFiles, busyFiles, targets: swept, ms }
}

/**
 * 启动后清扫：找不到可清的东西时只花几次 readdir，不会递归。
 * 只在主进程启动路径上被调用一次，参数全部来自常量（不接受外部输入）。
 */
export async function sweepStaleProfileCaches(): Promise<SweepResult> {
  const leftovers = findStagingLeftovers()
  const targets = [...leftovers, ...pickStaleTargets(cacheDirCandidates(), Date.now())]
  if (!targets.length) {
    return { freedBytes: 0, freedFiles: 0, busyFiles: 0, targets: [], ms: 0 }
  }
  if (leftovers.length) log.info(`先收上一轮没删完的暂存目录：${leftovers.join('、')}`)
  const fresh = targets.filter((d) => !d.endsWith(STAGING_SUFFIX))
  if (fresh.length) log.info(`遗留浏览器缓存清扫开始（判据：不在当前档案根之下，且目录及其直接子目录 ${Math.round(STALE_AFTER_MS / 86400000)} 天内未被写过）：${fresh.join('、')}`)
  return sweepGivenTargets(targets)
}
