// 执行后变更清单（P0-3b）——纯 fs + 临时目录，不碰库/Electron
//
// 覆盖：新增/修改/删除、mtime-only 口径、三道闸（文件数/哈希字节/耗时）整次降级、
// 前后扫失败两种口径、二进制/超大标注、JSON 上限兜底。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  beginWorkspaceChangeAudit,
  finishWorkspaceChangeAudit,
  serializeWorkspaceChangeSet,
  mergeWorkspaceChangeSets,
  buildStepChangeSet,
  CHANGE_SET_LIMITS,
  type ChangeSetLimits
} from '../src/main/agent/workspace-changes'
import type { WorkspaceChangeSet } from '../src/shared/types'

let dir = ''

function abs(rel: string): string {
  return path.join(dir, rel)
}

function write(rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), content)
}

/** 显式设置 mtime（秒级浮点），避免不同文件系统的写入时间精度差异 */
function touch(rel: string, mtimeSec: number): void {
  fs.utimesSync(abs(rel), mtimeSec, mtimeSec)
}

function limits(patch: Partial<ChangeSetLimits>): ChangeSetLimits {
  return { ...CHANGE_SET_LIMITS, ...patch }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-ws-changes-'))
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('变更检测', () => {
  it('新增 / 修改（大小变） / 删除各一条，计数与大小正确', () => {
    write('keep.txt', 'unchanged')
    write('b.txt', 'bb')
    write('c.txt', 'ccc')
    touch('keep.txt', 1_700_000_000)
    touch('b.txt', 1_700_000_000)
    touch('c.txt', 1_700_000_000)

    const audit = beginWorkspaceChangeAudit(dir)!
    write('d.txt', 'dddd')
    write('b.txt', 'bbbbbb')
    fs.rmSync(abs('c.txt'))
    const cs = finishWorkspaceChangeAudit(audit)

    expect(cs.status).toBe('ok')
    expect(cs.counts).toEqual({ added: 1, modified: 1, deleted: 1 })
    const byPath = new Map(cs.entries.map((e) => [e.path, e]))
    expect(byPath.get('d.txt')).toMatchObject({ kind: 'added', size: 4 })
    expect(byPath.get('b.txt')).toMatchObject({ kind: 'modified', size: 6 })
    expect(byPath.get('c.txt')).toMatchObject({ kind: 'deleted', size: 3, content: 'not-compared' })
    // 文本变更项会取指纹；删除项不可能比对
    expect(byPath.get('d.txt')!.content).toBe('hashed')
    expect(byPath.get('d.txt')!.afterSha).toMatch(/^[0-9a-f]{64}$/)
    expect(byPath.get('c.txt')!.afterSha).toBeUndefined()
  })

  it('大小未变但 mtime 变 ⇒ 能识别为 modified，但如实标 mtime-only（没有变更前内容可比）', () => {
    write('same.txt', 'aaaa')
    touch('same.txt', 1_700_000_000)
    const audit = beginWorkspaceChangeAudit(dir)!
    write('same.txt', 'bbbb')
    touch('same.txt', 1_700_000_100)
    const cs = finishWorkspaceChangeAudit(audit)

    expect(cs.status).toBe('ok')
    expect(cs.entries).toHaveLength(1)
    expect(cs.entries[0]).toMatchObject({ path: 'same.txt', kind: 'modified', size: 4, content: 'mtime-only' })
  })

  it('大小与 mtime 都没变 ⇒ 不产生条目', () => {
    write('stable.txt', 'stable')
    touch('stable.txt', 1_700_000_000)
    const audit = beginWorkspaceChangeAudit(dir)!
    const cs = finishWorkspaceChangeAudit(audit)

    expect(cs.status).toBe('ok')
    expect(cs.entries).toEqual([])
    expect(cs.counts).toEqual({ added: 0, modified: 0, deleted: 0 })
  })

  it('二进制文件不取内容，标 binary', () => {
    write('bin.dat', Buffer.from([0, 1, 2, 3]))
    const audit = beginWorkspaceChangeAudit(dir)!
    write('bin2.dat', Buffer.from([0, 65, 66]))
    const cs = finishWorkspaceChangeAudit(audit)
    const e = cs.entries.find((x) => x.path === 'bin2.dat')!
    expect(e.content).toBe('binary')
    expect(e.afterSha).toBeUndefined()
  })

  it('超过单文件哈希上限 ⇒ 标 too-large（未取内容）', () => {
    const audit = beginWorkspaceChangeAudit(dir, limits({ maxHashFileBytes: 4 }))!
    write('big.txt', '12345')
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs.entries[0]).toMatchObject({ path: 'big.txt', content: 'too-large' })
    expect(cs.entries[0]!.afterSha).toBeUndefined()
  })

  it('默认跳过 .git / node_modules：写入这些目录不产生条目（属已声明盲区）', () => {
    write('src/keep.ts', 'x')
    const audit = beginWorkspaceChangeAudit(dir)!
    write('node_modules/pkg/index.js', 'y'.repeat(100))
    write('.git/objects/aa', 'z')
    write('src/new.ts', 'n')
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs.entries.map((e) => e.path)).toEqual(['src/new.ts'])
  })

  it('路径里的密钥形态也被脱敏（与 trace 参数同一套规则）', () => {
    const audit = beginWorkspaceChangeAudit(dir)!
    write('token=abc123.txt', 'x')
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs.entries[0]!.path).toBe('token=[redacted]')
  })
})

describe('三道闸：任一超限整次降级，不留半份清单', () => {
  it('文件数超限 ⇒ degraded too-many-files，entries 为空', () => {
    write('a.txt', 'a')
    write('b.txt', 'b')
    write('c.txt', 'c')
    const audit = beginWorkspaceChangeAudit(dir, limits({ maxScanFiles: 2 }))!
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs).toMatchObject({ status: 'degraded', degradedReason: 'too-many-files', entries: [] })
  })

  it('哈希总字节超限 ⇒ degraded too-many-bytes，entries 为空', () => {
    const audit = beginWorkspaceChangeAudit(dir, limits({ maxHashTotalBytes: 4 }))!
    write('x.txt', '0123456789')
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs).toMatchObject({ status: 'degraded', degradedReason: 'too-many-bytes', entries: [] })
  })

  it('耗时超限 ⇒ degraded timeout，entries 为空', () => {
    write('a.txt', 'a')
    const audit = beginWorkspaceChangeAudit(dir, limits({ scanBudgetMs: -1 }))!
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs).toMatchObject({ status: 'degraded', degradedReason: 'timeout', entries: [] })
  })

  it('变更条数超限 ⇒ degraded too-many-changes，不截断成前 N 条', () => {
    const audit = beginWorkspaceChangeAudit(dir, limits({ maxChangedEntries: 1 }))!
    write('a.txt', 'a')
    write('b.txt', 'b')
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs).toMatchObject({ status: 'degraded', degradedReason: 'too-many-changes', entries: [] })
  })

  it('JSON 上限兜底 ⇒ 同样整次降级，不落半份', () => {
    const cs = {
      status: 'ok' as const,
      entries: [{ path: 'a.txt', kind: 'added' as const, size: 1, content: 'hashed' as const }],
      counts: { added: 1, modified: 0, deleted: 0 },
      scanMs: 3
    }
    const json = serializeWorkspaceChangeSet(cs, limits({ maxJsonChars: 10 }))
    expect(JSON.parse(json)).toMatchObject({ status: 'degraded', entries: [], degradedReason: 'too-many-changes' })
  })
})

describe('扫描失败不静默', () => {
  it('前扫失败（目录不存在）⇒ degraded before-scan-failed', () => {
    const missing = path.join(dir, 'nope')
    const audit = beginWorkspaceChangeAudit(missing)!
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs).toMatchObject({ status: 'degraded', degradedReason: 'before-scan-failed', entries: [] })
  })

  it('后扫失败（目录被移除）⇒ degraded after-scan-failed，不是"没有变更"', () => {
    write('a.txt', 'a')
    const audit = beginWorkspaceChangeAudit(dir)!
    fs.rmSync(dir, { recursive: true, force: true })
    const cs = finishWorkspaceChangeAudit(audit)
    expect(cs).toMatchObject({ status: 'degraded', degradedReason: 'after-scan-failed', entries: [] })
    // 目录已删，afterEach 的 rm 不再需要
    dir = ''
  })
})

describe('未设工作目录时不产出清单（NULL 与"没有变更"分开）', () => {
  it('空/null/undefined → null handle', () => {
    expect(beginWorkspaceChangeAudit('')).toBeNull()
    expect(beginWorkspaceChangeAudit('   ')).toBeNull()
    expect(beginWorkspaceChangeAudit(null)).toBeNull()
    expect(beginWorkspaceChangeAudit(undefined)).toBeNull()
  })
})

/** 一个 ok / degraded 清单的最小手搓形状（聚合口径不依赖真实扫描） */
function set(
  entries: WorkspaceChangeSet['entries'],
  patch: Partial<WorkspaceChangeSet> = {}
): WorkspaceChangeSet {
  const counts = { added: 0, modified: 0, deleted: 0 }
  for (const e of entries) counts[e.kind]++
  return { status: 'ok', entries, counts, scanMs: 5, ...patch }
}

describe('单步聚合：多条已批准的调用 → 一份清单', () => {
  it('多条 ok 合并；同路径只留最早那次观测，计数按去重后重算', () => {
    const a = set([{ path: 'x.txt', kind: 'added', size: 1, content: 'hashed' }])
    const b = set([
      { path: 'x.txt', kind: 'modified', size: 9, content: 'hashed' },
      { path: 'y.txt', kind: 'deleted', size: 3, content: 'not-compared' }
    ])
    const merged = mergeWorkspaceChangeSets([a, b])
    expect(merged.status).toBe('ok')
    expect(merged.entries).toHaveLength(2)
    expect(merged.entries[0]).toMatchObject({ path: 'x.txt', kind: 'added', size: 1 })
    expect(merged.counts).toEqual({ added: 1, modified: 0, deleted: 1 })
    expect(merged.scanMs).toBe(10)
  })

  it('任一降级 ⇒ 整步降级，且不带任何半份条目', () => {
    const ok = set([{ path: 'a.txt', kind: 'added', size: 1, content: 'hashed' }])
    const bad = set([], { status: 'degraded', degradedReason: 'timeout' })
    const merged = mergeWorkspaceChangeSets([ok, bad])
    expect(merged).toMatchObject({ status: 'degraded', degradedReason: 'timeout', entries: [] })
    expect(merged.counts).toEqual({ added: 0, modified: 0, deleted: 0 })
  })

  it('自动放行且无已批准调用 ⇒ 明确写"未记录"（auto-allowed-not-recorded），不是 NULL', () => {
    const json = buildStepChangeSet([], true)!
    expect(JSON.parse(json)).toMatchObject({
      status: 'degraded',
      degradedReason: 'auto-allowed-not-recorded',
      entries: []
    })
  })

  it('既无已批准调用、也无自动放行的目标工具 ⇒ undefined（NULL＝没这一步的事）', () => {
    expect(buildStepChangeSet([], false)).toBeUndefined()
  })
})
