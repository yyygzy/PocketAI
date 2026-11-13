// P0-5 dry-run 回放：三组全等判据的采集与对比
//
// 判据原文（docs/product-plan-2026-11.md 第 3 节 P0-5）：
//   回放全程不执行工具，不产生文件系统写入、网络出口调用、数据库业务写入
//   （审计／日志写入需显式豁免并写明）；
//   断言＝回放前后文件树哈希、出口计数、业务表行数三组对比全等。
//
// 本文件只做**采集与对比**，不执行回放。三组口径（2026-11-14 产品确认）：
//  1. 业务表行数：`sqlite_master` 里所有用户表都算，只有下面 `DRY_RUN_EXEMPT_TABLES`
//     列出的审计／日志／成本账本被显式豁免；豁免必须写在这里，不能散落在测试里。
//  2. 文件树哈希：Agent 工作目录 + 应用数据目录（DATA_DIR）。数据库文件本身排除
//     （行数由第 1 组覆盖；WAL/shm 会因打开连接而变，拿它做断言只会制造假红）；
//     日志目录也排除，理由与表的豁免相同——日志写入是允许的，且必须写明。
//  3. 出口计数：`safe-fetch.ts` 的 `getOutboundRequestCount()`。口径是 safeFetch 发出的
//     请求（含重定向每跳）；直接 `fetch(` 调用点不在计数内，测试需另加桩证明回放链路零出口。
//
// 已知限制（不在这里偷偷补口径）：行数只能发现插入/删除，**发现不了原地 UPDATE**。
// 判据原文写的就是"行数"，要升级成表内容哈希需要产品另行确认，不能由实现方顺手扩大。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { walkEntries } from '../fs/dir-walk'
import { getOutboundRequestCount } from '../net/safe-fetch'
import { DATA_DIR, DB_PATH, LOGS_DIR } from '../portable'
import { dbService } from '../db/database'

/**
 * dry-run 断言里显式豁免的账本表（不在"业务表行数"组内）。
 * 每条都要写清理由：审计／日志／成本账本是回放允许写的唯一一类表，
 * 豁免它们是产品口径，不是为了把红测试弄绿。
 */
export const DRY_RUN_EXEMPT_TABLES: ReadonlyArray<{ name: string; reason: string }> = [
  { name: 'schema_migrations', reason: '迁移账本：结构版本元数据，不是业务数据' },
  { name: 'agent_traces', reason: '成本／诊断审计账本（每步一行，重跑会删改）' },
  { name: 'approval_events', reason: '审批审计账本（谁批的、批了多大范围）' },
  { name: 'mcp_call_log', reason: 'MCP 调用日志' },
  { name: 'skill_import_audits', reason: '技能导入审计' },
  { name: 'usage_events', reason: '成本账本（产品确认与审计/日志同列豁免）' }
]

const EXEMPT_TABLE_NAMES = new Set(DRY_RUN_EXEMPT_TABLES.map((t) => t.name))

export interface DryRunFileScope {
  /** 文件树根目录（绝对路径） */
  root: string
  /**
   * 相对 root 的排除项，`\\` 与 `/` 等价：
   * 以 `/` 结尾表示整棵目录，否则表示该文件（精确匹配，不按前缀吞掉同名前缀文件）。
   */
  exclude?: readonly string[]
}

export interface DryRunSafetyOptions {
  db: Database.Database
  fileScopes: readonly DryRunFileScope[]
  /** 出口计数来源；缺省用 safe-fetch 的进程内计数（测试可注入更宽的探针） */
  outboundCount?: () => number
}

export interface DryRunSafetySnapshot {
  /** 所有文件树根拼成的确定性哈希（相对路径 + 体积 + 内容 sha256） */
  fileTreeHash: string
  /** 参与哈希的文件数；0 也要能说明"扫到了空树"，不是"没扫" */
  fileCount: number
  outboundCount: number
  /** 表名 → 行数（已剔除豁免表） */
  tableRowCounts: Record<string, number>
}

export interface DryRunTableDiff {
  table: string
  before: number
  after: number
}

export interface DryRunSafetyDiff {
  fileTreeEqual: boolean
  outboundEqual: boolean
  tableRowsEqual: boolean
  allEqual: boolean
  before: DryRunSafetySnapshot
  after: DryRunSafetySnapshot
  /** 行数变化的表（只列变化项；全等时为空数组） */
  tableDiffs: DryRunTableDiff[]
}

function normalizeRel(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function isExcluded(rel: string, exclude: readonly string[] | undefined): boolean {
  if (!exclude || exclude.length === 0) return false
  const r = normalizeRel(rel)
  for (const raw of exclude) {
    const rule = normalizeRel(raw)
    if (rule === '') continue
    if (rule.endsWith('/')) {
      const dir = rule.slice(0, -1)
      if (r === dir || r.startsWith(rule)) return true
    } else if (r === rule) {
      return true
    }
  }
  return false
}

function sha256File(abs: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

/**
 * 文件树哈希。任一文件读不出来就抛错——半份扫描不能拿来证明"全等"。
 * 根不存在时写入 `missing` 标记：根从"不存在"变成"存在"也必须被哈希发现。
 */
export function hashDryRunFileTree(scopes: readonly DryRunFileScope[]): {
  hash: string
  fileCount: number
} {
  const lines: string[] = []
  let fileCount = 0
  scopes.forEach((scope, index) => {
    const root = path.resolve(scope.root)
    let exists = false
    try {
      exists = fs.statSync(root).isDirectory()
    } catch {
      exists = false
    }
    if (!exists) {
      lines.push(`${index}|!:missing`)
      return
    }
    const entries: Array<{ rel: string; bytes: number; mtimeMs: number }> = []
    const status = walkEntries(root, root, entries, 'all')
    if (status !== 'ok') {
      throw new Error(`文件树扫描未完成（${status}）：${root}`)
    }
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    for (const entry of entries) {
      if (isExcluded(entry.rel, scope.exclude)) continue
      const abs = path.join(root, entry.rel)
      lines.push(`${index}|${normalizeRel(entry.rel)}|${entry.bytes}|${sha256File(abs)}`)
      fileCount++
    }
  })
  const hash = crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
  return { hash, fileCount }
}

/** 业务表行数：用户表全集 − 显式豁免表 */
export function countDryRunBusinessTableRows(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name`
    )
    .all() as Array<{ name: string }>
  const counts: Record<string, number> = {}
  for (const row of rows) {
    if (EXEMPT_TABLE_NAMES.has(row.name)) continue
    const quoted = `"${row.name.replaceAll('"', '""')}"`
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }
    counts[row.name] = n.n
  }
  return counts
}

export function captureDryRunSafetySnapshot(opts: DryRunSafetyOptions): DryRunSafetySnapshot {
  const { hash, fileCount } = hashDryRunFileTree(opts.fileScopes)
  return {
    fileTreeHash: hash,
    fileCount,
    outboundCount: (opts.outboundCount ?? getOutboundRequestCount)(),
    tableRowCounts: countDryRunBusinessTableRows(opts.db)
  }
}

/** 默认口径：Agent 工作目录 + DATA_DIR，排除 DB 文件与日志目录 */
export function defaultDryRunSafetyOptions(workspaceDir?: string | null): DryRunSafetyOptions {
  const dbName = path.basename(DB_PATH)
  const logsRel = path.relative(DATA_DIR, LOGS_DIR).replaceAll('\\', '/')
  const scopes: DryRunFileScope[] = [
    {
      root: DATA_DIR,
      exclude: [
        dbName,
        `${dbName}-wal`,
        `${dbName}-shm`,
        `${dbName}-journal`,
        logsRel ? `${logsRel}/` : 'logs/'
      ]
    }
  ]
  if (workspaceDir) scopes.push({ root: workspaceDir })
  return { db: dbService.getHandle(), fileScopes: scopes }
}

export function diffDryRunSafety(
  before: DryRunSafetySnapshot,
  after: DryRunSafetySnapshot
): DryRunSafetyDiff {
  const tables = new Set([
    ...Object.keys(before.tableRowCounts),
    ...Object.keys(after.tableRowCounts)
  ])
  const tableDiffs: DryRunTableDiff[] = []
  for (const table of [...tables].sort()) {
    const b = before.tableRowCounts[table] ?? 0
    const a = after.tableRowCounts[table] ?? 0
    if (a !== b) tableDiffs.push({ table, before: b, after: a })
  }
  const fileTreeEqual = before.fileTreeHash === after.fileTreeHash
  const outboundEqual = before.outboundCount === after.outboundCount
  const tableRowsEqual = tableDiffs.length === 0
  return {
    fileTreeEqual,
    outboundEqual,
    tableRowsEqual,
    allEqual: fileTreeEqual && outboundEqual && tableRowsEqual,
    before,
    after,
    tableDiffs
  }
}
