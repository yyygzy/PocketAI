// 工具大结果的「卸载」而非「截断」（V4-Iter-232）
//
// 为什么要有这一层：`engine.ts` 原本把每一步的工具返回值一律压到 2000 字符再塞回上下文
// （`compressToolResult`，`engine.ts:634`），被砍掉的那一段**模型再也拿不回来**——
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
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../portable'

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
/** 卸载目录里最多留多少份文件（按 mtime 淘汰最旧的） */
export const OFFLOAD_KEEP_FILES = 200
/** 给模型看的路径前缀：只有 `fs_read` 认它，指向应用数据目录下的卸载根 */
export const OFFLOAD_PREFIX = '@outputs/'

export function defaultOffloadRoot(): string {
  return path.join(DATA_DIR, 'agent-tool-outputs')
}

/**
 * 文件名只允许安全字符。**刻意把点号也换掉**：`../../x` 这类键里的 `..` 一旦留在文件名里，
 * 虽然出不了目录（斜杠已被替换），但文件名会出现 `__..x` 这种形状——读起来像路径、实际不是，
 * 而这一层的引用是要原样交给模型去看下一段的，名字不该带这种暗示。
 */
function safeSegment(value: string): string {
  return (value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool'
}

export interface OffloadRef {
  /** 给模型看的路径（`@outputs/<file>.txt`），不是绝对路径——绝对路径会暴露机器目录结构 */
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
 */
export function offloadToolOutput(root: string, key: string, content: string): OffloadRef | null {
  if (content.length <= OFFLOAD_MIN_CHARS) return null
  return writeOffloadFile(root, key, content)
}

/**
 * 无条件落一份全文（v54 的补洞入口）：
 * trace 的 `toolResult` 是**整步聚合字符串**，多个中等长度的调用拼起来也会越过 4000，
 * 那时单看每个调用的长度都不会触发 `offloadToolOutput`——所以写入端在"整步被截断"时
 * 对每个调用都调这里，保证每一段都有可取回的文件，不留"trace 截了、却没有路径"的段。
 * 仍然只是缓存：权威存储是 `messages.content`。
 */
export function writeOffloadFile(root: string, key: string, content: string): OffloadRef | null {
  const file = `${safeSegment(key)}.txt`
  const absPath = path.join(root, file)
  try {
    fs.mkdirSync(root, { recursive: true })
    // 已经落过且长度一致 ⇒ 不重写（跨轮重建历史会反复拿到同一条消息）
    if (!fs.existsSync(absPath) || fs.statSync(absPath).size !== Buffer.byteLength(content, 'utf-8')) {
      fs.writeFileSync(absPath, content, 'utf-8')
    }
  } catch {
    return null
  }
  pruneOffloads(root)
  return { ref: `${OFFLOAD_PREFIX}${file}`, absPath }
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

/** 只保留最新 N 份（按 mtime）；返回删掉的份数 */
export function pruneOffloads(root: string, keep = OFFLOAD_KEEP_FILES): number {
  if (!fs.existsSync(root)) return 0
  const files = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(root, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const item of files.slice(keep)) {
    try {
      fs.rmSync(path.join(root, item.f))
      removed++
    } catch {
      // 删不掉就留着：这一层是辅助，不该反过来把运行卡住
    }
  }
  return removed
}
