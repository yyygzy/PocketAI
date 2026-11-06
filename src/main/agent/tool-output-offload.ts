// 工具大结果的「卸载」而非「截断」（V4-Iter-232；P0-5 第二批改为按会话组织）
//
// 为什么要有这一层：`engine.ts` 原本把每一步的工具返回值一律压到 2000 字符再塞回上下文
// （`compressToolResult`），被砍掉的那一段**模型再也拿不回来**——
// 而它砍完还会在文案里告诉模型"完整 12,345 字符"，等于一边承认有全文、一边不给回读口。
// 卸载的形状是主流 harness 那一套：过阈值就写文件、上下文里只留前几行预览 + 一个引用，
// 模型要看细节自己调 fs_read；只有连卸载都腾不出空间时才退到摘要。
//
// 三条不是可有可无的规矩：
//  · **键取那条工具结果的 DB 消息 id**，不取"第几步"。理由有两层：同一份全文只落一次
//    （跨轮重建历史时不必每轮重写一遍），以及"这一轮的第 3 步"在下一轮的上下文里根本对不上号。
//  · **落在应用数据目录，不落在用户的工作目录里**：Agent 工作目录是用户的树，往里塞几百 KB 的
//    中间产物是污染（与 §231 的写快照同一条口径）。
//  · **只读得回、写不进去**：只有 `fs_read` 认 `@outputs/`，`fs_write`／`fs_list` 不认。
//    否则模型会把这里当临时盘，也会看见别的运行留下的东西。
//
// P0-5 第二批（本文件这一版）：
//  · **新写入按会话分目录**：`<root>/<conversationId>/<messageId>.txt`，删会话可整目录删；
//  · **旧平铺布局继续可读**：`@outputs/<messageId>.txt` 仍照旧解析——库里已有的 `cold_ref` 不能因为改布局集体失联。
//    （选"读时兼容"而不是"搬迁"：搬迁要么搬完没改引用、要么改引用没搬完，两种中间态都会把回放做坏。）
//  · **上限改为时间 + 字节**，目录级淘汰；旧平铺文件的 200 份上限保留，避免根目录越积越多；
//  · **写入原子化**（`.part` → rename），且删不掉的失败要计数（供数据健康口径用）。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../portable'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('offload')

/** 上下文里留几行预览 */
export const OFFLOAD_PREVIEW_LINES = 10
/**
 * 落文件门槛（v54）：**与 trace 截断上限 `TRACE_TEXT_MAX_CHARS` 对齐**。
 * 低于它时 trace 存的就是全文，不需要另一条路径；一旦被 trace 截断，就必须有可取的全文。
 * 这一档原先取 20,000，留下 4,001–20,000 这一段"trace 里没有全文、也没有文件"的空档（P0-5 第一批修掉）。
 */
export const OFFLOAD_MIN_CHARS = 4_000
/**
 * 上下文改放「预览 + 引用」的门槛（与落文件门槛分开）：
 * 4,001–20,000 这一段照样落文件（供 trace 回放/诊断），但上下文里仍放原文，
 * 不把模型的输入形状一起改掉——那是一次行为变化，不该和"补全文路径"捆在一批。
 */
export const OFFLOAD_PREVIEW_MIN_CHARS = 20_000
/** 兼容既有调用/测试的旧名：语义是"上下文预览门槛"，不是落文件门槛 */
export const OFFLOAD_THRESHOLD_CHARS = OFFLOAD_PREVIEW_MIN_CHARS
/** 平铺（旧布局）目录里最多留多少份文件（按 mtime 淘汰最旧的）；会话目录由时间/字节上限管 */
export const OFFLOAD_KEEP_FILES = 200
/** 会话目录的时间上限：整目录里**最新**一份也超过 30 天，就整目录淘汰 */
export const OFFLOAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** 卸载根的总字节上限（含旧平铺文件）；超了按目录 LRU 整目录淘汰 */
export const OFFLOAD_MAX_BYTES = 512 * 1024 * 1024
/** 原子写的临时后缀；半写的 `.part` 永远不会被 `resolveOffloadPath` 指向 */
const PART_SUFFIX = '.part'
/** 半小时内不动过的 `.part` 才当垃圾清：避免和正在写的另一个进程抢文件 */
const STALE_PART_MS = 60 * 60 * 1000
/** 给模型看的路径前缀：只有 `fs_read` 认它，指向应用数据目录下的卸载根 */
export const OFFLOAD_PREFIX = '@outputs/'

/** 卸载根目录名：数据健康的冷数据口径按它分桶，不写字面量避免两处漂移 */
export const OFFLOAD_DIR_NAME = 'agent-tool-outputs'

export function defaultOffloadRoot(): string {
  return path.join(DATA_DIR, OFFLOAD_DIR_NAME)
}

/**
 * 文件名只允许安全字符。**刻意把点号也换掉**：`../../x` 这类键里的 `..` 一旦留在文件名里，
 * 虽然出不了目录（斜杠已被替换），但文件名会出现 `__..x` 这种形状——读起来像路径、实际不是，
 * 而这一层的引用是要原样交给模型去看下一段的，名字不该带这种暗示。
 * 会话 id 与消息 id 都走同一个白名单（UUID 不会被改动，非法输入也出不了目录）。
 */
export function safeSegment(value: string): string {
  return (value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool'
}

/** 会话目录的绝对路径（删会话时按它整目录删） */
export function conversationOffloadDir(root: string, conversationId: string): string {
  return path.join(root, safeSegment(conversationId))
}

export interface OffloadRef {
  /** 给模型看的路径（`@outputs/<conversationId>/<file>.txt` 或旧的 `@outputs/<file>.txt`），不是绝对路径 */
  ref: string
  /** 实际落点（日志与测试用，不进模型上下文） */
  absPath: string
}

/**
 * 落一份全文。返回 null 表示**没落**（没过落文件门槛，或写失败）。
 * 写失败退回"照旧截断"而不是抛错：这一步的返回值还要给模型用，卸载只是让它**还能读回全文**，
 * 不是它工作的前提——把辅助做成故障点是本末倒置。
 *
 * 这里落的是**缓存**：全文的权威存储是那条 tool 消息的 `messages.content`
 * （见 engine.ts 的持久化处）。读回放必须走 messages，不要把这个 `.txt` 当唯一来源。
 *
 * @param conversationId 新写入必须带（目录按会话分）；缺省写平铺根，只为兼容既有测试/旧调用。
 */
export function offloadToolOutput(
  root: string,
  key: string,
  content: string,
  conversationId?: string | null
): OffloadRef | null {
  if (content.length <= OFFLOAD_MIN_CHARS) return null
  return writeOffloadFile(root, key, content, conversationId)
}

/**
 * 无条件落一份全文（v54 的补洞入口）：
 * trace 的 `toolResult` 是**整步聚合字符串**，多个中等长度的调用拼起来也会越过 4000，
 * 那时单看每个调用的长度都不会触发 `offloadToolOutput`——所以写入端在"整步被截断"时
 * 对每个调用都调这里，保证每一段都有可取回的文件，不留"trace 截了、却没有路径"的段。
 * 仍然只是缓存：权威存储是 `messages.content`。
 */
export function writeOffloadFile(
  root: string,
  key: string,
  content: string,
  conversationId?: string | null
): OffloadRef | null {
  const file = `${safeSegment(key)}.txt`
  const conv = conversationId ? safeSegment(conversationId) : ''
  const dir = conv ? path.join(root, conv) : root
  const absPath = path.join(dir, file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 已经落过且长度一致 ⇒ 不重写（跨轮重建历史会反复拿到同一条消息）
    if (!fs.existsSync(absPath) || fs.statSync(absPath).size !== Buffer.byteLength(content, 'utf-8')) {
      writeAtomic(absPath, content)
    }
  } catch {
    return null
  }
  pruneOffloads(root)
  return { ref: conv ? `${OFFLOAD_PREFIX}${conv}/${file}` : `${OFFLOAD_PREFIX}${file}`, absPath }
}

/**
 * 先写 `.part` 再 rename：断掉/被杀时磁盘上最多留一个 `.part`，
 * 而 `.part` 不在 `@outputs/... .txt` 的解析路径上，读回放永远读不到半截文件。
 * `.part` 名带随机后缀：并发写同一消息（理论上不该发生）不会互相覆盖临时文件。
 */
function writeAtomic(absPath: string, content: string): void {
  const part = `${absPath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${PART_SUFFIX}`
  fs.writeFileSync(part, content, 'utf-8')
  try {
    fs.renameSync(part, absPath)
  } catch (e) {
    try {
      fs.rmSync(part, { force: true })
    } catch { /* 临时文件清不掉也不影响结果：下一次 prune 会扫走它 */ }
    throw e
  }
}

/**
 * 上下文里放的那一段：**先给引用、再给前 N 行预览**。
 * 顺序是刻意的：预览随后还要被 `MAX_TOOL_RESULT_CHARS` 截一刀，把引用放在末尾就等于
 * 模型拿到的那段里"全文在哪"被截掉了——那句才是这一层存在的全部意义。
 */
export function buildOffloadPreview(content: string, ref: string): string {
  const lines = content.split('\n')
  const head = lines.slice(0, OFFLOAD_PREVIEW_LINES).join('\n')
  const more = lines.length > OFFLOAD_PREVIEW_LINES ? `\n…（预览到此，共 ${lines.length} 行）` : ''
  return `（本次返回 ${content.length} 字符，太长已截给模型看的部分；全文在 ${ref}，用 fs_read 读这个路径可以看后面的内容。这一层只读，写不进去。）\n\n${head}${more}`
}

/**
 * 把模型给的 `@outputs/...` 解析成卸载根内的绝对路径。
 * 越界一律拒。这里没有"写"的入口（`fs_write` 不调本函数），所以不需要再判符号链接目标能不能写。
 *
 * **两种布局都认**：`@outputs/<messageId>.txt`（旧平铺）与
 * `@outputs/<conversationId>/<messageId>.txt`（新分目录）——旧 `cold_ref` 靠这一条继续可回放。
 */
export function resolveOffloadPath(root: string, ref: string): string {
  const rest = ref.startsWith(OFFLOAD_PREFIX) ? ref.slice(OFFLOAD_PREFIX.length) : ref
  const norm = path.posix.normalize(rest.replace(/\\/g, '/')).replace(/^\/+/, '')
  // 空串与 `.` 要单独挡：`normalize('')` 给的是 `'.'`，而 `'.'` 解析出来就是卸载根本身——
  // 把一个目录当"文件"交给 fs_read，报出来的会是"文件不存在"，那是句假话（这里根本不该走到那一步）。
  if (norm.includes('\0') || norm === '' || norm === '.' || norm.startsWith('..')) throw new Error('非法的工具输出路径')
  const abs = path.resolve(root, norm)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径超出工具输出目录范围')
  // 这一层**不判存在性**：它是纯路径函数，存在与否则由调用方（fs_read）在它自己的语义里报——
  // 把"不存在"混进解析里，就等于让一个路径函数带上 fs 副作用，测试与调用点都会开始说谎。
  return abs
}

// ─── 淘汰与失败计数（P0-5 第二批） ────────────────────────────────

/**
 * 删除失败计数：**不静默**。Windows 上文件被占用会 EBUSY，以前这里 `catch {}` 一吞，
 * 目录就悄悄超过上限；现在每次失败都累加，第三批的数据健康屏直接用这个数。
 * 日志只在**同一目标第一次失败**时打一条，避免 prune 每次写入都刷屏。
 */
let pruneFailures = 0
const loggedPruneFailures = new Set<string>()

export function getOffloadPruneFailureCount(): number {
  return pruneFailures
}

function recordPruneFailure(target: string, e: unknown): void {
  pruneFailures++
  if (loggedPruneFailures.size > 1000) loggedPruneFailures.clear()
  if (!loggedPruneFailures.has(target)) {
    loggedPruneFailures.add(target)
    log.warn(`冷数据删除失败（累计 ${pruneFailures} 次）: ${target}: ${errMsg(e)}`)
  }
}

export interface OffloadPruneOptions {
  /** 旧平铺文件份数上限（默认 200） */
  keep?: number
  /** 会话目录时间上限（默认 30 天） */
  maxAgeMs?: number
  /** 卸载根总字节上限（默认 512 MB） */
  maxBytes?: number
  /** 测试注入：替换文件删除实现（默认 fs.rmSync） */
  removeFile?: (abs: string) => void
  /** 测试注入：替换目录删除实现（默认 fs.rmSync recursive） */
  removeDir?: (abs: string) => void
}

interface DirEntry {
  name: string
  abs: string
  bytes: number
  newestMtime: number
}

/**
 * 淘汰：**先到先算**——时间到期先删（整目录 / 平铺文件），再压旧平铺份数，最后才按字节 LRU。
 * 之所以按目录而不是按文件淘汰：删会话要能整目录删，保留策略也得同粒度，
 * 否则一个会话被删了一半、另一半还在，引用关系讲不清。
 *
 * 幂等：已经达标时再跑不会删任何东西（测试会连跑两次）。
 * 返回删掉的条目数（文件与目录各算一个）。
 */
export function pruneOffloads(root: string, opts: number | OffloadPruneOptions = {}): number {
  const o: OffloadPruneOptions = typeof opts === 'number' ? { keep: opts } : opts
  const keep = o.keep ?? OFFLOAD_KEEP_FILES
  const maxAgeMs = o.maxAgeMs ?? OFFLOAD_MAX_AGE_MS
  const maxBytes = o.maxBytes ?? OFFLOAD_MAX_BYTES
  const removeFile = o.removeFile ?? ((abs: string) => fs.rmSync(abs))
  const removeDir = o.removeDir ?? ((abs: string) => fs.rmSync(abs, { recursive: true }))

  if (!fs.existsSync(root)) return 0
  const now = Date.now()
  let removed = 0

  const legacyFiles: Array<{ name: string; abs: string; bytes: number; mtime: number }> = []
  const dirs: DirEntry[] = []
  const staleParts: Array<{ abs: string; mtime: number }> = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0 // 根不可读：不在这里制造噪声，下次写入会再试
  }
  for (const it of entries) {
    const abs = path.join(root, it.name)
    if (it.isDirectory()) {
      let bytes = 0
      let newest = 0
      try {
        for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
          if (!f.isFile()) continue
          const fp = path.join(abs, f.name)
          const st = fs.statSync(fp)
          if (f.name.endsWith(PART_SUFFIX)) {
            staleParts.push({ abs: fp, mtime: st.mtimeMs })
            continue
          }
          bytes += st.size
          if (st.mtimeMs > newest) newest = st.mtimeMs
        }
      } catch {
        continue // 目录刚被删/读不动：跳过
      }
      let newestMtime = newest
      if (!newestMtime) {
        // 目录里没有正式文件（只剩 .part）：用目录自身 mtime；拿不到说明它刚被删，跳过
        try {
          newestMtime = fs.statSync(abs).mtimeMs
        } catch {
          continue
        }
      }
      dirs.push({ name: it.name, abs, bytes, newestMtime })
    } else if (it.isFile()) {
      if (it.name.endsWith(PART_SUFFIX)) {
        try {
          staleParts.push({ abs, mtime: fs.statSync(abs).mtimeMs })
        } catch { /* 竞态：忽略 */ }
      } else if (it.name.endsWith('.txt')) {
        try {
          const st = fs.statSync(abs)
          legacyFiles.push({ name: it.name, abs, bytes: st.size, mtime: st.mtimeMs })
        } catch { /* 竞态：忽略 */ }
      }
    }
  }

  // 1) 时间：会话目录整体过期 / 平铺文件过期
  for (const d of dirs.filter((x) => now - x.newestMtime > maxAgeMs)) {
    try {
      removeDir(d.abs)
      removed++
    } catch (e) {
      recordPruneFailure(d.abs, e)
    }
  }
  for (const f of legacyFiles.filter((x) => now - x.mtime > maxAgeMs)) {
    try {
      removeFile(f.abs)
      removed++
    } catch (e) {
      recordPruneFailure(f.abs, e)
    }
  }

  // 2) 旧平铺布局的份数上限（新目录不按份数淘汰，交给时间/字节）
  const freshLegacy = legacyFiles.filter((x) => now - x.mtime <= maxAgeMs).sort((a, b) => b.mtime - a.mtime)
  for (const f of freshLegacy.slice(keep)) {
    try {
      removeFile(f.abs)
      removed++
    } catch (e) {
      recordPruneFailure(f.abs, e)
    }
  }

  // 3) 字节：按目录 LRU 整目录删，再删平铺旧文件
  const liveDirs = [...dirs]
    .filter((d) => now - d.newestMtime <= maxAgeMs)
    .sort((a, b) => a.newestMtime - b.newestMtime)
  const liveLegacy = freshLegacy.slice(0, keep)
  let total = liveDirs.reduce((s, d) => s + d.bytes, 0) + liveLegacy.reduce((s, f) => s + f.bytes, 0)
  while (total > maxBytes && (liveDirs.length > 0 || liveLegacy.length > 0)) {
    // 先整目录（同粒度删会话），再单文件——平铺文件没有会话归属，只能一个个删
    const d = liveDirs.shift()
    if (d) {
      try {
        removeDir(d.abs)
        total -= d.bytes
        removed++
        continue
      } catch (e) {
        recordPruneFailure(d.abs, e)
        // 删不掉也要把它从候选里拿掉，否则 while 会原地打转
      }
    }
    const f = liveLegacy.shift()
    if (f) {
      try {
        removeFile(f.abs)
        total -= f.bytes
        removed++
      } catch (e) {
        recordPruneFailure(f.abs, e)
      }
    }
    if (!d && !f) break
  }

  // 4) 半写的临时文件：只清一小时前就不动的，避免抢正在写的那个
  for (const p of staleParts.filter((x) => now - x.mtime > STALE_PART_MS)) {
    try {
      removeFile(p.abs)
      removed++
    } catch (e) {
      recordPruneFailure(p.abs, e)
    }
  }

  return removed
}
