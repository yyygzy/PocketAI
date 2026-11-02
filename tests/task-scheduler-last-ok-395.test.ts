// V4-Iter-395（缺陷 hunt §391 候选 ⑤）：定时维护任务的「上次运行」时间戳在成功与失败两种收尾里都写
// （`runTask` 的 `finally { setLastRun }`），所以数据健康面板把它摆成一行时间＝向用户说「这件事成了」，
// 而真相可能是一次都没成（备份校验每 24h 撞一次 WebDAV 错，屏上却只有一条越来越新的正常时间）。
//
// 修法＝成功/失败各写一颗 `task.<key>.last_ok`（'1'/'0'），时间戳照旧写在 finally——
// 两颗字段各说各的事：`last_run_at` 说「什么时候跑过」，`last_ok` 说「那一次成没成」。
//
// 本文件只管生产侧那一读一写；契约三档在 `data-health-task-last-ok-395.test.ts`，
// 屏上的脸在 `renderer-task-last-ok-face-395.test.tsx`，结构纪律在 `task-last-ok-gate-395.test.ts`。
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: new Map<string, string>(),
  webdavCfg: null as unknown,
  downloads: 0,
  // 增量索引的正文：缺 db.sha256 ⇒ 任务体抛错＝「跑过但失败」那一档的真实来路
  downloadRaw: Buffer.from(JSON.stringify({ kind: 'inc' })),
  warns: [] as string[],
  reset() {
    this.config.clear()
    this.webdavCfg = null
    this.downloads = 0
    this.downloadRaw = Buffer.from(JSON.stringify({ kind: 'inc' }))
    this.warns = []
  }
}))

vi.mock('../src/main/db/database', () => ({ dbService: { isOpen: () => true } }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => mocks.config.get(key) ?? null,
    set: (key: string, value: string) => { mocks.config.set(key, value) }
  }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: { listAll: () => [], setStatus: () => {} }
}))
vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PENC1:',
  readWebDAVConfig: () => ({ cfg: mocks.webdavCfg, passwordUndecryptable: false, configUnreadable: false }),
  toCreds: (cfg: unknown) => ({ cfg }),
  listWebDAVBackups: async () => [
    { name: 'pocketai-inc-20260927.json', mtime: Date.UTC(2026, 8, 27) }
  ],
  isEncryptedBlob: () => false,
  decryptBackup: (b: Buffer) => b
}))
vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: async () => {
    mocks.downloads++
    return mocks.downloadRaw
  }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => { mocks.warns.push(args.map(String).join(' ')) },
    debug: () => {},
    error: () => {}
  })
}))

import { tick, stopTaskScheduler } from '../src/main/backup/task-scheduler'

beforeEach(() => mocks.reset())
afterEach(() => stopTaskScheduler())

describe('① 失败那一跑：时间戳照写，但 last_ok 必须说"没成"', () => {
  it('任务体抛错 ⇒ last_run_at 有值（跑过）＋ last_ok = 0（那次没成）', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    await tick()
    expect(mocks.downloads).toBe(1)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(0)
    expect(mocks.config.get('task.backup_verify.last_ok')).toBe('0')
  })

  it('正向对照：任务体正常收尾 ⇒ last_ok = 1（两档不许写成同一个值）', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    await tick() // 第一跑：坏索引 ⇒ 0
    expect(mocks.config.get('task.backup_verify.last_ok')).toBe('0')
    // 换成一份有效的增量索引，再跑第二趟（未到 24h ⇒ 手工回填时间戳把它叫成"到点"）
    mocks.downloadRaw = Buffer.from(JSON.stringify({ kind: 'inc', db: { sha256: 'abc' } }))
    mocks.config.set('task.backup_verify.last_run_at', String(Date.now() - 25 * 3600 * 1000))
    await tick()
    expect(mocks.config.get('task.backup_verify.last_ok'), `现数 warn：${JSON.stringify(mocks.warns)}`).toBe('1')
  })
})

describe('② 没配 WebDAV 那一档：跳过＝这一发没报错，不等于"校验通过"', () => {
  it('真没配过 ⇒ 任务体安静 return（不抛）⇒ last_ok 落在 1，面板那句措辞因此是「未报错」而不是「成功」', async () => {
    mocks.webdavCfg = null
    await tick()
    expect(mocks.downloads).toBe(0)
    // 这一颗写 1 的语义＝「本轮没抛错」。跳过的一跑没验任何东西，所以屏上那句不许说"校验成功"——
    // 措辞与这条语义同源钉死，见 §D 闸门（两颗键的 zh/en 各一句）。
    expect(mocks.config.get('task.backup_verify.last_ok')).toBe('1')
  })
})

describe('③ kb_health_check 同一条链', () => {
  it('无文档的一跑也写 last_ok = 1（否则面板这一格永远是"不知道"）', async () => {
    await tick()
    expect(Number(mocks.config.get('task.kb_health_check.last_run_at'))).toBeGreaterThan(0)
    expect(mocks.config.get('task.kb_health_check.last_ok')).toBe('1')
  })

  it('改前形状的反向对照：只写 last_run_at 的那一版分不出成败——本批把两颗字段拆开后各写各的', async () => {
    await tick()
    const keys = [...mocks.config.keys()].filter((k) => k.startsWith('task.kb_health_check.'))
    expect(keys.sort()).toEqual(['task.kb_health_check.last_ok', 'task.kb_health_check.last_run_at'])
  })
})
