// V4-Iter-395（缺陷 hunt §391 候选 ⑤）：数据健康报告里维护任务那一组只有时间戳，
// 而那个键（`task.<key>.last_run_at`）在成功与失败两种收尾里都写 ⇒ 契约层分不清三档到货。
//
// 本文件只管契约：`tasks.*LastOk` 三档各自落到哪（true／false／null），以及 null 不许被折成 false
// （§375 那一族的老形状：读不出来＝没有；这里反过来＝「旧数据没记过」不许说成「上次失败」，
//  否则升级后第一次面板打开，两条任务都会红着说"上次运行失败"，而那一次其实什么都没跑过判断）。
//
// 生产侧的写入在 `task-scheduler-last-ok-395.test.ts`；屏上的脸在 `renderer-task-last-ok-face-395.test.tsx`；
// 结构纪律在 `task-last-ok-gate-395.test.ts`。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const M = vi.hoisted(() => ({
  // app_config 的一张内存表：任务的两颗键都从这里读
  config: new Map<string, string>(),
  reset() { this.config.clear() }
}))

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const root = base + sep + 'pocketai-dh395'
  process.env.POCKETAI_APP_ROOT = root
  return { root, data: root + sep + 'data' }
})

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => P.root, getPath: () => P.root } }))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({ kbDocRepo: { listAll: () => [] } }))
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { list: () => [] } }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => M.config.get(key) ?? null,
    set: (key: string, value: string) => { M.config.set(key, value) }
  }
}))
vi.mock('../src/main/db/repositories/agent-trace.repo', () => ({
  agentTraceRepo: { countForHealth: () => ({ rows: 0, maxRowsInOneConversation: 0 }) }
}))
vi.mock('../src/main/backup/backup-service', () => ({
  readWebDAVConfig: () => ({ cfg: null, passwordUndecryptable: false, configUnreadable: false })
}))
vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => ({
    enabled: false, intervalHours: 6, retentionCount: 3,
    lastRunAt: null, lastOkAt: null, lastResult: null
  })
}))
vi.mock('../src/main/knowledge/kb-health', () => ({
  getKbIntegrityReport: () => ({ orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] }),
  getVectorIndexStats: () => ({ count: 0, dims: [] })
}))

import { getDataHealthReport } from '../src/main/steward/data-health'

beforeAll(() => {
  fs.mkdirSync(P.data, { recursive: true })
  fs.writeFileSync(path.join(P.data, 'app.db'), 'x')
})
afterAll(() => {
  try {
    fs.rmSync(P.root, { recursive: true, force: true })
  } catch {
    /* scratch 残留由 CI 的临时目录承担 */
  }
})

const AT = 1_730_000_000_000

/** 只把 tasks 那一组取出来比，其余字段与本批无关 */
const tasksOf = () => getDataHealthReport().tasks

describe('① 三档到货三档契约（两条任务同一条链，逐条演）', () => {
  it('成功的一跑 ⇒ kbHealthCheckLastOk = true，且时间戳照旧带出', () => {
    M.reset()
    M.config.set('task.kb_health_check.last_run_at', String(AT))
    M.config.set('task.kb_health_check.last_ok', '1')
    const t = tasksOf()
    expect(t.kbHealthCheckLastRunAt).toBe(AT)
    expect(t.kbHealthCheckLastOk).toBe(true)
  })

  it('失败的一跑 ⇒ kbHealthCheckLastOk = false（改前这一档与上一档在契约层算同一个数）', () => {
    M.reset()
    M.config.set('task.kb_health_check.last_run_at', String(AT))
    M.config.set('task.kb_health_check.last_ok', '0')
    const t = tasksOf()
    expect(t.kbHealthCheckLastRunAt).toBe(AT)
    expect(t.kbHealthCheckLastOk).toBe(false)
  })

  it('旧数据（这一版之前跑过，只写时间戳）⇒ null，不是 false（不把"没记过"说成"上次失败"）', () => {
    M.reset()
    M.config.set('task.kb_health_check.last_run_at', String(AT))
    expect(tasksOf().kbHealthCheckLastOk).toBeNull()
  })

  it('backup_verify 那一颗同一条链：0 ⇒ false、1 ⇒ true、缺 ⇒ null', () => {
    M.reset()
    M.config.set('task.backup_verify.last_run_at', String(AT))
    expect(tasksOf().backupVerifyLastOk).toBeNull()
    M.config.set('task.backup_verify.last_ok', '0')
    expect(tasksOf().backupVerifyLastOk).toBe(false)
    M.config.set('task.backup_verify.last_ok', '1')
    expect(tasksOf().backupVerifyLastOk).toBe(true)
  })

  it('从未运行（两颗键都没有）⇒ 时间戳 null ＋ lastOk null（两个字段各说各的事，不许一栏顶掉另一栏）', () => {
    M.reset()
    const t = tasksOf()
    expect(t.kbHealthCheckLastRunAt).toBeNull()
    expect(t.kbHealthCheckLastOk).toBeNull()
    expect(t.backupVerifyLastRunAt).toBeNull()
    expect(t.backupVerifyLastOk).toBeNull()
  })

  it('脏值（既不是 1 也不是 0）⇒ null：这一读只认两个记号，其余一律"不知道"', () => {
    M.reset()
    M.config.set('task.kb_health_check.last_ok', 'true')
    expect(tasksOf().kbHealthCheckLastOk).toBeNull()
  })

  it('反向对照：那颗只绑在另一条任务上（两条不许互相顶替）', () => {
    M.reset()
    M.config.set('task.kb_health_check.last_ok', '0')
    const t = tasksOf()
    expect(t.kbHealthCheckLastOk).toBe(false)
    expect(t.backupVerifyLastOk).toBeNull()
  })
})
