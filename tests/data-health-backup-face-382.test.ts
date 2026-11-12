// V4-Iter-382（缺陷 hunt 候选 §381-⑥）：数据健康那一读把「口令有密文却解不开」也算成"已配置"。
//
// 病灶＝`data-health.ts` 里 `configured = !!loadWebDAVConfig()`：`loadWebDAVConfig` 在解不开时
// 把**原始密文**原样带回（非空），所以那一判在这一档读到 true。屏上（`DataHealthPanel.tsx` 那行
// 「定时备份」）于是说「已开启，每 N 小时」／「已配置，定时未开启」，而 warn 只由
// `!configured || !enabled` 决定＝这一档不 warn。真伤害＝下一次备份必在鉴权那步失败，
// 而这一格是用户对"云备份到底还在不在工作"的主要读数口。
//
// 取法换成 `readWebDAVConfig()`＝判据排在密文被覆盖成明文**之前**（§381 的同一条纪律；
// 拿解密后的值再判一遍会把恰以 `v1:` 开头的明文误报成解不开）。
//
// 本文件只管**决策与契约**（三档各自落到哪两个字段）；屏上那一格已随「备份状态三行」下线，
// 同一件事的可见面改由 `tests/stale-read-notice-345.test.tsx` 与备份卡片承接；
// 结构纪律在 `tests/webdav-configured-face-gate-382.test.ts`。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 一份可改的读结果（三档各演一遍）。全局打桩＝beforeEach 装、这里由 reset 归位
// §386 起这一读带第三颗 flag（那一行存在却解析不出来），桩形状要跟着齐（缺它＝真源码读到 undefined）
const M = vi.hoisted(() => ({
  read: { cfg: null as unknown, passwordUndecryptable: false, configUnreadable: false },
  schedule: {
    enabled: false,
    intervalHours: 6,
    retentionCount: 3,
    lastRunAt: null as number | null,
    lastOkAt: null as number | null,
    lastResult: null as null | { ok: boolean; at: number; error?: string | null }
  },
  reset() {
    this.read = { cfg: null, passwordUndecryptable: false, configUnreadable: false }
    this.schedule = {
      enabled: false,
      intervalHours: 6,
      retentionCount: 3,
      lastRunAt: null,
      lastOkAt: null,
      lastResult: null
    }
  }
}))

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const root = base + sep + 'pocketai-dh382'
  process.env.POCKETAI_APP_ROOT = root
  return { root, data: root + sep + 'data' }
})

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => P.root, getPath: () => P.root } }))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({ kbDocRepo: { listAll: () => [] } }))
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { list: () => [] } }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: { get: () => undefined, set: () => {} } }))
vi.mock('../src/main/backup/backup-service', () => ({
  // 改前的形状只有这一读；留着它是"桩形状"的一半——真读了 readWebDAVConfig，桩必须也给
  loadWebDAVConfig: () => M.read.cfg,
  readWebDAVConfig: () => M.read
}))
vi.mock('../src/main/backup/backup-scheduler', () => ({ getBackupSchedule: () => M.schedule }))
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
  // 只清自己这份 scratch root；失败不掩盖结论
  try {
    fs.rmSync(P.root, { recursive: true, force: true })
  } catch {
    /* scratch 残留由 CI 的临时目录承担 */
  }
})

describe('数据健康的备份那一格：三档要分得开', () => {
  it('没配过 ⇒ configured:false、passwordUndecryptable:false（两个字段各说各的事）', () => {
    M.reset()
    const r = getDataHealthReport()
    expect(r.backup.configured).toBe(false)
    expect(r.backup.passwordUndecryptable).toBe(false)
  })

  it('配过、口令解得开 ⇒ configured:true、那一颗 false（正向对照：别把正常那档也报成坏）', () => {
    M.reset()
    M.read = { cfg: { url: 'https://dav.example.com', username: 'u', passwordCipher: '明文口令' }, passwordUndecryptable: false, configUnreadable: false }
    M.schedule = { ...M.schedule, enabled: true }
    const r = getDataHealthReport()
    expect(r.backup.configured).toBe(true)
    expect(r.backup.passwordUndecryptable).toBe(false)
    expect(r.backup.enabled).toBe(true)
  })

  it('有配置、口令解不开 ⇒ configured:true 且 passwordUndecryptable:true（改前这一档只有前半）', () => {
    M.reset()
    M.read = { cfg: { url: 'https://dav.example.com', username: 'u', passwordCipher: 'v1:旧钥密文' }, passwordUndecryptable: true, configUnreadable: false }
    M.schedule = { ...M.schedule, enabled: true }
    const r = getDataHealthReport()
    expect(r.backup.configured).toBe(true)
    expect(r.backup.passwordUndecryptable).toBe(true)
  })

  it('解不开那一档仍然把上次的真实失败带着（lastError 没被新字段替掉＝两件事同屏各说各的）', () => {
    M.reset()
    M.read = { cfg: { url: 'https://dav.example.com', username: 'u', passwordCipher: 'v1:旧钥密文' }, passwordUndecryptable: true, configUnreadable: false }
    M.schedule = { ...M.schedule, enabled: true, lastRunAt: 123, lastResult: { ok: false, at: 123, error: '401 Unauthorized' } }
    const r = getDataHealthReport()
    expect(r.backup.passwordUndecryptable).toBe(true)
    expect(r.backup.lastError).toBe('401 Unauthorized')
    expect(r.backup.lastOkAt).toBe(null)
  })
})

// §386：那一行**存在却解析不出来**（整库恢复把 app_config 整表换成备份里那份坏行）是第三档。
// 改前它塌进 `cfg:null`＝与「没配过」共用一个出口，屏上说「未配置」、设置页摆空表单，
// 点保存正好把那份坏行覆盖掉。生产侧这一读现在把三档分开交出去。
describe('§386 第三档：坏行要单独说话，且不与另两档互相顶', () => {
  it('那一行读不出来 ⇒ configured:false 且 configUnreadable:true（屏侧按后者画第三张脸）', () => {
    M.reset()
    M.read = { cfg: null, passwordUndecryptable: false, configUnreadable: true }
    const r = getDataHealthReport()
    expect(r.backup.configured).toBe(false)
    expect(r.backup.configUnreadable).toBe(true)
    expect(r.backup.passwordUndecryptable).toBe(false)
  })

  it('反向对照：真没配过 ⇒ 那颗 false（合法状态不许被画成"配置坏了"）', () => {
    M.reset()
    const r = getDataHealthReport()
    expect(r.backup.configured).toBe(false)
    expect(r.backup.configUnreadable).toBe(false)
  })

  it('反向对照：口令解不开那一档 ⇒ 那颗也 false（两档共用 cfg:null 会串味）', () => {
    M.reset()
    M.read = { cfg: { url: 'https://dav.example.com', username: 'u', passwordCipher: 'v1:旧钥密文' }, passwordUndecryptable: true, configUnreadable: false }
    const r = getDataHealthReport()
    expect(r.backup.passwordUndecryptable).toBe(true)
    expect(r.backup.configUnreadable).toBe(false)
  })

  it('坏行那一档把上次的真实失败带着（lastError 与新字段各说各的事，同屏两句都要在）', () => {
    M.reset()
    M.read = { cfg: null, passwordUndecryptable: false, configUnreadable: true }
    M.schedule = { ...M.schedule, enabled: true, lastRunAt: 123, lastResult: { ok: false, at: 123, error: 'WebDAV 配置那一行读不出来' } }
    const r = getDataHealthReport()
    expect(r.backup.configUnreadable).toBe(true)
    expect(r.backup.lastError).toBe('WebDAV 配置那一行读不出来')
  })
})
