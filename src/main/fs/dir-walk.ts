// 目录树遍历（唯一实现）：数据健康面板与执行后变更清单共用。
//
// 从 steward/data-health 抽出来是因为引擎侧（变更清单）只该拉这条遍历，不该顺着 data-health
// 把知识库/备份/审批仓库整条依赖链都拽进启动路径。抽取后仍然只有**一套**遍历实现。

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { isBrowserProfilePath } from '../../shared/data-dirs'

export interface WalkFileEntry {
  /** 相对 base 的路径（/ 分隔） */
  rel: string
  bytes: number
  mtimeMs: number
}

/** `mode`：数据健康要把 Chromium 档案树分桶；任意工作目录用 `all`（不过滤） */
export type WalkMode = 'skipProfile' | 'onlyProfile' | 'all'

export type WalkStatus = 'ok' | 'too-many-files' | 'deadline'

export interface WalkOptions {
  maxFiles?: number
  /** 绝对时间戳（Date.now() + 预算），到点即停 */
  deadlineMs?: number
  /** 按目录名整棵跳过（任意层级）；数据健康不传，变更清单传 .git/node_modules */
  skipDirNames?: readonly string[]
}

/**
 * 递归收集目录下全部文件的相对路径/体积/mtime；单项 stat 失败忽略。
 * 命中 `maxFiles` 或超过 `deadlineMs` 立刻停手并返回对应状态——
 * 调用方必须把这种结果当"没扫完"，不能拿半份结果当全量。
 */
export function walkEntries(
  dir: string,
  base: string,
  out: WalkFileEntry[],
  mode: WalkMode,
  opts: WalkOptions = {}
): WalkStatus {
  const maxFiles = opts.maxFiles ?? Infinity
  const deadline = opts.deadlineMs ?? Infinity
  const skipDirNames = new Set(opts.skipDirNames ?? [])
  let count = 0
  let stop: Exclude<WalkStatus, 'ok'> | null = null

  const visit = (current: string): void => {
    if (stop) return
    if (Date.now() > deadline) { stop = 'deadline'; return }
    let items: import('node:fs').Dirent[]
    try {
      items = readdirSync(current, { withFileTypes: true })
    } catch {
      return // 目录不存在/不可读 → 该桶按 0 处理（外层用 stat 判"根目录不可读"）
    }
    for (const it of items) {
      if (stop) return
      if (Date.now() > deadline) { stop = 'deadline'; return }
      const full = path.join(current, it.name)
      const rel = path.relative(base, full).replaceAll('\\', '/')
      const profile = isBrowserProfilePath(rel)
      if (mode === 'skipProfile' && profile) continue
      if (mode === 'onlyProfile' && !profile) continue
      if (it.isDirectory()) {
        if (skipDirNames.has(it.name)) continue
        visit(full)
      } else if (it.isFile()) {
        count++
        if (count > maxFiles) { stop = 'too-many-files'; return }
        try {
          const st = statSync(full)
          out.push({ rel, bytes: st.size, mtimeMs: st.mtimeMs })
        } catch { /* 竞态删除/权限 → 跳过该文件 */ }
      }
    }
  }

  visit(dir)
  return stop ?? 'ok'
}
