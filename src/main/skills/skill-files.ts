// 技能随附文件（§236 第三层）：一个技能一个目录，落在应用自己的数据目录里。
//
// 为什么要落盘而不是塞进那一列 TEXT：上游 SKILL.md 技能包的形状就是「一个目录 + SKILL.md + scripts/references/assets」，
// 三层按需加载是这套标准的一部分；正文进库没问题，资源文件进一列字符串就再也回不去"文件"这个形状了。
// 落点的两个选择与取向：
//  · 放进 `agent.workspace_dir` ⇒ `fs_read` 立刻能读，但那是用户的项目目录，应用往里面写自带资源、
//    并且和 §193／§194 那套"遗留清扫"共用一棵树，风险和观感都不好；
//  · 放进 `<DATA_DIR>/skills/<id>/`（本文件这条）⇒ 与应用自己的卸载目录 `agent-tool-outputs` 同族，
//    读它走一颗窄工具（`load_skill`），不放开 `fs_read` 的第二根路径。
// 路径**完全由技能 id 推出** ⇒ 库里不需要新列，删掉技能就等于删掉目录（残留由 removeSkillFiles 收）。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../portable'
import { errMsg } from '../error'

/** 单个资源文件的读取上限（与 `fs_read` 同一档：技能资源本质是文本） */
export const SKILL_FILE_READ_LIMIT_BYTES = 256 * 1024
/** 一个技能目录的总量上限（导入时逐文件累计，超了整个导入拒掉——不是静默截断） */
export const SKILL_DIR_TOTAL_LIMIT_BYTES = 2 * 1024 * 1024
/** 一个技能最多带多少个资源文件 */
export const SKILL_DIR_MAX_FILES = 200
/** 目录里最深几层（SKILL.md 标准形状是 skills/<name>/references/x.md 这种两三层） */
export const SKILL_DIR_MAX_DEPTH = 4

/** 顶层入口文件名（大小写不敏感匹配，优先精确这个写法） */
const SKILL_ENTRY_NAME = 'SKILL.md'

/** 导入一份技能目录的结果 */
export interface SkillFolderImport {
  /** 入口文件（SKILL.md）的原文，交给 `parseSkillText` 解析 */
  entryText: string
  /** 复制进技能目录的相对路径（不含入口文件本身——它就存进那一列 content） */
  copied: string[]
  /** 被跳过/拒绝的条目与原因（如实报给用户，不静默丢） */
  skipped: Array<{ path: string; reason: string }>
  /** 复制的总字节数 */
  totalBytes: number
}

/** 列目录的返回（界面与 `load_skill` 都用它） */
export interface SkillFileEntry {
  path: string
  size: number
}

/**
 * id → 目录名。技能 id 是 UUID 或内置的 kebab 串，正常都不变；
 * 变了一律换掉非法字符，宁可让两个畸形 id 撞在一起（它们的正文本来就是同一份库行），
 * 也不把没被净化过的字符串拼进路径。
 */
function safeIdSegment(id: string): string {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  if (!s) throw new Error('非法的技能 id')
  return s
}

export function skillFilesRoot(): string {
  return path.join(DATA_DIR, 'skills')
}

export function skillFilesDir(id: string): string {
  return path.join(skillFilesRoot(), safeIdSegment(id))
}

/**
 * 纯路径函数（不碰文件系统，形状对齐 `resolveOffloadPath`）：技能目录内的相对路径 → 绝对路径。
 * 拒掉：`''`、`.`、`..` 开头的、带 NUL 的。绝对路径与开头的 `/` **剥成根内相对路径**（与卸载引用同一档口径：
 * 保证"出不去"，而不是假装能区分"用户是不是真的想写绝对路径"）。
 * 这一层不判存在性：把"不存在"混进路径解析里，等于让一个纯函数带上 fs 副作用，调用点与用例都会开始说谎。
 */
export function resolveSkillFilePath(id: string, rel: string): string {
  const rest = String(rel ?? '').replace(/\\/g, '/')
  if (rest.includes('\0')) throw new Error('非法的技能文件路径')
  const norm = path.posix.normalize(rest).replace(/^\/+/, '')
  if (norm === '' || norm === '.' || norm.startsWith('..')) throw new Error('非法的技能文件路径')
  const root = skillFilesDir(id)
  const abs = path.resolve(root, norm)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径超出技能目录范围')
  return abs
}

/** 递归收集源目录里的普通文件（跳过符号链接、非常规文件与超限深度） */
function collectSourceFiles(
  dir: string,
  prefix: string,
  depth: number,
  out: Array<{ rel: string; abs: string; size: number }>,
  skipped: Array<{ path: string; reason: string }>
): void {
  if (out.length >= SKILL_DIR_MAX_FILES) {
    skipped.push({ path: prefix || '.', reason: 'TOO_MANY_FILES' })
    return
  }
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    let st: fs.Stats
    try {
      st = fs.lstatSync(abs)
    } catch {
      skipped.push({ path: rel, reason: 'STAT_FAILED' })
      continue
    }
    // 符号链接一律不带：复制它等于把目录外的真实内容搬进"这个技能自带"的那份快照里，
    // 而读侧再怎么做 realpath 约束也追不回"当初是谁指出去的那一步"
    if (st.isSymbolicLink()) {
      skipped.push({ path: rel, reason: 'SYMLINK_SKIPPED' })
      continue
    }
    if (st.isDirectory()) {
      if (depth + 1 >= SKILL_DIR_MAX_DEPTH) {
        skipped.push({ path: rel, reason: 'TOO_DEEP' })
        continue
      }
      collectSourceFiles(abs, rel, depth + 1, out, skipped)
      continue
    }
    if (!st.isFile()) {
      skipped.push({ path: rel, reason: 'NOT_A_REGULAR_FILE' })
      continue
    }
    out.push({ rel, abs, size: st.size })
  }
}

/**
 * 读一份技能目录（还没落库，先解析入口再决定）：返回入口原文与将要复制的文件清单。
 * 目录里没有 `SKILL.md`（大小写任一）⇒ 判 `NO_SKILL_MD`，不猜"那随便挑个 .md 吧"。
 */
export function readSkillFolder(srcDir: string): {
  entryText: string
  files: Array<{ rel: string; abs: string; size: number }>
  skipped: Array<{ path: string; reason: string }>
  error?: string
} {
  let real = ''
  try {
    real = fs.realpathSync(srcDir)
  } catch {
    return { entryText: '', files: [], skipped: [], error: 'NOT_A_DIRECTORY' }
  }
  if (!fs.statSync(real).isDirectory()) return { entryText: '', files: [], skipped: [], error: 'NOT_A_DIRECTORY' }

  const names = fs.readdirSync(real)
  const exact = names.includes(SKILL_ENTRY_NAME) ? SKILL_ENTRY_NAME : names.find((n) => n.toUpperCase() === SKILL_ENTRY_NAME.toUpperCase())
  if (!exact) return { entryText: '', files: [], skipped: [], error: 'NO_SKILL_MD' }
  const entryAbs = path.join(real, exact)
  const entryStat = fs.lstatSync(entryAbs)
  if (!entryStat.isFile() || entryStat.size > SKILL_FILE_READ_LIMIT_BYTES) {
    return { entryText: '', files: [], skipped: [], error: entryStat.isFile() ? 'ENTRY_TOO_LARGE' : 'NOT_A_REGULAR_FILE' }
  }

  const files: Array<{ rel: string; abs: string; size: number }> = []
  const skipped: Array<{ path: string; reason: string }> = []
  collectSourceFiles(real, '', 0, files, skipped)
  // 入口文件本身进 content 那一列，资源清单里不再重复它
  const resources = files.filter((f) => f.rel !== exact)
  const entryText = fs.readFileSync(entryAbs, 'utf8')
  return { entryText, files: resources, skipped }
}

/**
 * 把已经解析过的技能目录复制进 `<DATA_DIR>/skills/<id>/`。
 * 超限（总量／单文件）在这里判死，而不是"先收下再截断"：一个被截断的脚本文件比没有更糟——
 * 它会让人以为技能自带的那份东西是可用的。
 */
export function installSkillFiles(
  id: string,
  files: Array<{ rel: string; abs: string; size: number }>
): SkillFolderImport {
  const copied: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  const dest = skillFilesDir(id)
  fs.mkdirSync(dest, { recursive: true })
  let totalBytes = 0
  for (const f of files) {
    if (copied.length >= SKILL_DIR_MAX_FILES) {
      skipped.push({ path: f.rel, reason: 'TOO_MANY_FILES' })
      continue
    }
    if (f.size > SKILL_FILE_READ_LIMIT_BYTES) {
      skipped.push({ path: f.rel, reason: 'FILE_TOO_LARGE' })
      continue
    }
    if (totalBytes + f.size > SKILL_DIR_TOTAL_LIMIT_BYTES) {
      skipped.push({ path: f.rel, reason: 'DIR_TOO_LARGE' })
      continue
    }
    // rel 已经在收集时限定为目录内的普通相对路径，这里再过一次解析器：两道都是同一份判据的写法，
    // 但收集侧与安装侧是两次独立调用（越界来源不同），不让一处坏掉就把另一处带倒
    const target = resolveSkillFilePath(id, f.rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(f.abs, target)
    copied.push(f.rel)
    totalBytes += f.size
  }
  return { entryText: '', copied, skipped, totalBytes }
}

/** 列出某技能自带的资源文件（目录不存在就是空表，不抛） */
export function listSkillFiles(id: string): SkillFileEntry[] {
  const dir = skillFilesDir(id)
  if (!fs.existsSync(dir)) return []
  const out: SkillFileEntry[] = []
  const walk = (current: string, prefix: string, depth: number): void => {
    if (depth >= SKILL_DIR_MAX_DEPTH || out.length >= SKILL_DIR_MAX_FILES) return
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let st: fs.Stats
      try {
        st = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      // 目录要钻进去：装进来那一刻是带子目录复制的（references/api.md），
      // 只列顶层等于把清单说成"没有"，而 load_skill 明明能读到那份东西
      if (st.isDirectory()) {
        walk(abs, rel, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      out.push({ path: rel, size: st.size })
      if (out.length >= SKILL_DIR_MAX_FILES) return
    }
  }
  walk(dir, '', 0)
  return out
}

/** 读某技能自带的一个文件（越界／越目录的软链／二进制／超长都有明确一句） */
export function readSkillFile(
  id: string,
  rel: string
): { content: string; size: number; truncated: boolean; path: string } {
  const abs = resolveSkillFilePath(id, rel)
  const st = fs.lstatSync(abs)
  if (st.isSymbolicLink()) throw new Error('技能资源里的符号链接不被支持')
  if (!st.isFile()) throw new Error('不是一个文件')
  const fh = fs.openSync(abs, 'r')
  try {
    const probe = Buffer.alloc(Math.min(1024, st.size))
    fs.readSync(fh, probe, 0, probe.length, 0)
    if (probe.includes(0)) throw new Error('疑似二进制文件，不支持按文本读取')
    const len = Math.min(st.size, SKILL_FILE_READ_LIMIT_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fh, buf, 0, len, 0)
    return { content: buf.toString('utf-8'), size: st.size, truncated: st.size > len, path: rel }
  } finally {
    fs.closeSync(fh)
  }
}

/**
 * 删技能的资源目录（删技能时调）。
 * 返回有没有删：路径不存在返回 false，让调用方知道"本来就没有"，不把它当失败。
 * 只敢删 `skillFilesRoot()` 之下、由 id 净化推出来的那一层——`skillFilesRoot()` 自己永远不碰。
 */
export function removeSkillFiles(id: string): boolean {
  const dir = skillFilesDir(id)
  const root = skillFilesRoot()
  if (dir === root || !dir.startsWith(root + path.sep)) throw new Error('拒绝删除技能资源根之外的路径')
  if (!fs.existsSync(dir)) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    // 删不掉就留着：这一层是辅助，反过来把"删技能"这件事卡住更糟
    return false
  }
}

/** 安装失败时把已经复制进去的那一半清掉（不留半份资源） */
export function rollbackSkillFiles(id: string): string {
  try {
    removeSkillFiles(id)
    return ''
  } catch (e) {
    return errMsg(e)
  }
}
