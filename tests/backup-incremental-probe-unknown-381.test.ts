// §381（候选 #5）：远端去重探测「没跑成」那一档不许被记成「远端没有」
//
// 缺陷形状（探针实测，见台账）：`remoteExists` 的 catch 把超时／5xx／鉴权抖动一律塌成 `false`，
// 于是 `uploadBlob` 走重传。屏上那两个数字本身没说谎（那一片确实又传了一次），
// 谎在「跳过 0 个」——它把「我们没问出来」画成「远端一份都没有」，去重失效这件事全程无声。
//
// 策略：真跑 `createWebDAVIncrementalBackup`（真读库文件、真算 sha256、真组索引），
// 只把网络层（webdav-client）换成可控三态的桩——三态的语义正在那一层。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'

const P = vi.hoisted(() => {
  const root = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp'
  const base = `${root}/pocketai-381b-${process.pid}-${Date.now()}`
  return { base, db: `${base}/app.db`, att: `${base}/attachments` }
})

/** 网络层桩：每个远端名给哪一档，由用例现设 */
const net = vi.hoisted(() => ({
  states: new Map<string, 'exists' | 'absent' | 'unknown'>(),
  default: 'absent' as 'exists' | 'absent' | 'unknown',
  uploads: [] as string[],
  existsCalls: 0,
  throwOnExists: false
}))

vi.mock('../src/main/portable', () => ({ DB_PATH: P.db, ATTACHMENTS_DIR: P.att }))
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ pragma: () => [] }) }
}))
// 明文档（getDbKey()=null）：本枚只判计数口径，加密链 §375/§323 早有专测
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getDbKey: () => null,
    getFieldKey: () => Buffer.alloc(32, 1),
    isDbEncrypted: () => false,
    hasKey: () => false
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} },
  clearAppConfigCache: () => {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))
vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async () => ({ ok: true }),
  uploadBuffer: async (_c: unknown, _d: Buffer, name: string) => { net.uploads.push(name) },
  downloadFile: async () => Buffer.alloc(0),
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async (_c: unknown, rel: string) => {
    net.existsCalls += 1
    if (net.throwOnExists) throw new Error('探测层自己抛了')
    return net.states.get(rel) ?? net.default
  },
  uploadRemoteBuffer: async (_c: unknown, _d: Buffer, rel: string) => { net.uploads.push(rel) },
  downloadRemoteFile: async () => Buffer.alloc(0)
}))

import { createWebDAVIncrementalBackup, blobRelName, sha256Hex } from '../src/main/backup/backup-service'

const CFG = {
  url: 'https://dav.example.com/remote.php/dav/files/me',
  username: 'me',
  passwordCipher: 'plain-password',
  directory: 'pocketai'
}

const A1 = Buffer.from('attachment-one-bytes')
const A2 = Buffer.from('attachment-two-bytes')
const rel = (prefix: 'db' | 'att', buf: Buffer): string =>
  blobRelName(prefix, sha256Hex(buf), false)

beforeAll(() => {
  mkdirSync(P.att, { recursive: true })
  writeFileSync(P.db, Buffer.from('synthetic-db-content-for-381'))
  writeFileSync(`${P.att}/a1.bin`, A1)
  writeFileSync(`${P.att}/a2.bin`, A2)
})

afterAll(() => {
  rmSync(P.base, { recursive: true, force: true })
})

beforeEach(() => {
  net.states.clear()
  net.default = 'absent'
  net.uploads.length = 0
  net.existsCalls = 0
  net.throwOnExists = false
})

describe('remoteExists 三态：探测没跑成＝单独一档', () => {
  it('全部确认已有 ⇒ 只有 DB 那一片重传（内容每次都变），附件两个都记进跳过、未知数为 0', async () => {
    const dbRel = rel('db', readFileSync(P.db))
    net.states.set(dbRel, 'absent')
    net.states.set(rel('att', A1), 'exists')
    net.states.set(rel('att', A2), 'exists')
    const r = await createWebDAVIncrementalBackup(CFG)
    expect(r.blobsSkipped).toBe(2)
    expect(r.blobsUploaded).toBe(1)
    expect(r.blobsProbeUnknown).toBe(0)
    expect(r.attachmentsTotal).toBe(2)
  })

  it('探测没跑成的那一片：照样重传（安全），但**不**进 blobsSkipped，而计进 blobsProbeUnknown', async () => {
    net.default = 'absent'
    net.states.set(rel('att', A1), 'unknown')
    net.states.set(rel('att', A2), 'exists')
    const r = await createWebDAVIncrementalBackup(CFG)
    expect(r.blobsSkipped, '没问出来的一片不许算去重命中').toBe(1)
    expect(r.blobsProbeUnknown, '那一档必须单独数得出来').toBe(1)
    expect(r.blobsUploaded).toBe(2) // DB + a1（unknown 走重传）
    expect(r.bytesUploaded, '重传了就真花了带宽，字节数要把它算进去').toBeGreaterThan(0)
    expect(net.uploads).toContain(rel('att', A1))
  })

  it('反向对照：全塌成 unknown（旧写法里的 false 那种一发）＝skipped 归零、unknown 三个都在屏上说得出来', async () => {
    net.default = 'unknown'
    const r = await createWebDAVIncrementalBackup(CFG)
    expect(r.blobsSkipped).toBe(0)
    expect(r.blobsProbeUnknown).toBe(3)
    expect(r.blobsUploaded).toBe(3)
  })

  it('探测层真抛出（没被包成 unknown）⇒ 整发失败，不静默续跑', async () => {
    net.throwOnExists = true
    await expect(createWebDAVIncrementalBackup(CFG)).rejects.toThrow('探测层自己抛了')
  })

  it('索引里那片 unknown 仍按内容寻址的名字记账（重传＝同名单份，不留两个引用）', async () => {
    net.default = 'unknown'
    const r = await createWebDAVIncrementalBackup(CFG)
    expect(net.uploads.filter((u) => u.startsWith('blobs/'))).toHaveLength(3)
    expect(r.filename.startsWith('pocketai-inc-')).toBe(true)
    expect(net.uploads).toContain(r.filename)
  })
})
