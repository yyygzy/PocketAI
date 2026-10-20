// 文件写入前的行级 diff（V4-Iter-231）——纯规则，零依赖，所以住在 shared
//
// 为什么要单开一份：审批弹窗要在**落盘之前**把"这一笔会把什么改成什么"讲清楚，
// 而那段算法必须能被 CI 直接喂两串文本判对错，不能住在主进程里（主进程 import 会带 electron 链，
// 与 `shared/delegation-rules.ts` 分家是同一条纪律）。
//
// 两处刻意的设计，不是省事：
//  · **末尾换行单独成行**：`"a\n"` 与 `"a"` 只差一个换行符，行级 diff 会把两者判成"没有变化"，
//    于是"改坏了但弹窗说没改"就成了可能。判据要问的是"内容会不会变"，所以这一位必须显式出现在结果里。
//  · **过大时退回朴素两栏而不是报错**：LCS 是 O(n·m)，真文件能到几十万行。
//    退回"前 60 行按删除、后 60 行按新增"仍然是真信息（用户看得见两侧长什么样），
//    只是少了行对齐——`coarse` 把这件事如实带出去，不假装是精确 diff。
export type DiffRowKind = 'ctx' | 'add' | 'del'

export interface DiffRow {
  kind: DiffRowKind
  text: string
}

export interface FileDiff {
  /** 展示用行（已按 maxRows 截断） */
  rows: DiffRow[]
  added: number
  removed: number
  /** 精确 diff 下被截断掉的行 */
  truncated: boolean
  /** 截断前的总行数（渲染端要说"显示了 200／517"就靠它） */
  totalRows: number
  prevLines: number
  nextLines: number
  prevExists: boolean
  /** true=两侧行数超过算法上限，本结果是朴素两栏（不做行对齐） */
  coarse: boolean
  /** 末尾换行的变化；null=没变化（含两侧都不存在文件的情况） */
  finalNewline: { prev: boolean; next: boolean } | null
}

const LINE_LIMIT = 800
const COARSE_HEAD = 60
/** 展示上限：再长就没人逐行看，截断并把 `truncated` 带出去 */
export const DIFF_MAX_ROWS_DEFAULT = 200

/** 末尾换行先摘出来单独判，剩下的才是"行序列" */
function splitBody(content: string): { lines: string[]; finalNewline: boolean } {
  if (content === '') return { lines: [], finalNewline: false }
  const finalNewline = content.endsWith('\n')
  const body = finalNewline ? content.slice(0, -1) : content
  return { lines: body.split('\n'), finalNewline }
}

/** 最短编辑距离的逐行对齐（LCS 回溯）。超过 LINE_LIMIT 行时调用方不会走到这里。 */
function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length
  const m = b.length
  // (n+1)×(m+1) 的计数表；行数列数都 ≤800 ⇒ 最多约 2.6MB，且有上限守卫
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i]! })
      i++
      j++
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      rows.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      rows.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++]! })
  while (j < m) rows.push({ kind: 'add', text: b[j++]! })
  return rows
}

/** 两侧都放不下的那一档：不假装对齐，只把两边长什么样摆出来 */
function coarseRows(prev: string[], next: string[]): DiffRow[] {
  return [...prev.slice(0, COARSE_HEAD).map((text) => ({ kind: 'del', text }) as DiffRow),
    ...next.slice(0, COARSE_HEAD).map((text) => ({ kind: 'add', text }) as DiffRow)]
}

/**
 * `prev === null` 表示文件还不存在（新建）；此时不写"删除行"，全算新增。
 */
export function buildFileDiff(
  prev: string | null,
  next: string,
  opts: { maxRows?: number } = {}
): FileDiff {
  const maxRows = opts.maxRows ?? DIFF_MAX_ROWS_DEFAULT
  const nextSplit = splitBody(next)
  const prevSplit = prev === null ? { lines: [] as string[], finalNewline: false } : splitBody(prev)
  const prevExists = prev !== null

  const finalNewline =
    prevExists && prevSplit.finalNewline !== nextSplit.finalNewline
      ? { prev: prevSplit.finalNewline, next: nextSplit.finalNewline }
      : null

  const coarse = prevSplit.lines.length + nextSplit.lines.length > LINE_LIMIT
  const aligned = coarse ? [] : lcsRows(prevSplit.lines, nextSplit.lines)

  // 末尾换行的差异要占一行，否则"改了但看起来没改"
  const newlineRows: DiffRow[] = finalNewline
    ? finalNewline.prev
      ? [{ kind: 'del', text: '\\ No newline at end of file' }]
      : [{ kind: 'add', text: '\\ No newline at end of file' }]
    : []

  const full = coarse
    ? [...coarseRows(prevSplit.lines, nextSplit.lines), ...newlineRows]
    : [...aligned, ...newlineRows]

  // newlineRows 已经在 full 里，计数就只数 full，别再补一次（补了会把"末尾换行"算两遍）
  const added = coarse ? nextSplit.lines.length : full.filter((r) => r.kind === 'add').length
  const removed = coarse ? prevSplit.lines.length : full.filter((r) => r.kind === 'del').length

  const truncated = full.length > maxRows
  const rows = truncated ? full.slice(0, maxRows) : full

  return {
    rows,
    added,
    removed,
    truncated,
    totalRows: full.length,
    prevLines: prevSplit.lines.length,
    nextLines: nextSplit.lines.length,
    prevExists,
    coarse,
    finalNewline
  }
}

/** 渲染用的文本：新增行前缀 `+`、删除行 `-`、未变行留空格。无颜色，所以主进程/渲染端都能用同一段。 */
export function diffToText(rows: DiffRow[]): string {
  return rows.map((r) => `${r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '} ${r.text}`).join('\n')
}
