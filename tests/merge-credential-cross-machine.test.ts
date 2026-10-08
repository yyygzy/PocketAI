// SEC-30 跨机合并的真实凭据后果（把台账里「未实测」的那条变成实测）
//
// 这一份不做字符串断言，而是走真密钥 + 真 AES-GCM：
// 用 A/B 两个主密码派生两把字段密钥，分别把凭据加密进「本机库」和「云端库」，
// 跑完 overwriteTable 后**以 A 机身份**去解密，验证三件事：
// 1. 本机已有行：合并后仍能用本机密钥解开（修复生效）
// 2. 云端独有行：解不开但密文本身完好（换回 B 密钥可解）⇒ 表现是「需重填」而非崩溃
// 3. 对照组：不传 preserveColumns 时本机行的 Key 直接消失（这就是本次要修的缺陷）
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))
vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: vi.fn(),
  downloadRemoteFile: vi.fn()
}))
vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PKBK1',
  isEncryptedBlob: () => false,
  decryptBackup: vi.fn(),
  deriveBackupDbKey: vi.fn(),
  toCreds: (cfg: unknown) => cfg,
  isSafeZipEntryName: () => true,
  containsSymlink: () => false,
  BackupDecryptError: class extends Error {}
}))

import { overwriteTable } from '../src/main/backup/merge-service'
import { masterKeyManager } from '../src/main/crypto/master-key'
import { encryptApiKeys, decryptApiKeys, encryptSecretMap, decryptSecretMap } from '../src/main/crypto/field-encrypt'

const PROVIDER_SCHEMA = `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT,
    base_url TEXT,
    api_key_encrypted TEXT
  );
`

// 两台机器各持一把稳定密钥（用 setRawKey 固定，避免每次派生都换盐）
const keyA = randomBytes(32) // 目标机（当前操作这台）
const keyB = randomBytes(32) // 源机（做备份那台）

/**
 * 以某台机器的身份加密。密钥必须在**调用时**切换——
 * encryptApiKeys/encryptSecretMap 是读全局 masterKeyManager 的，
 * 提前取出函数引用会在别的机器密钥下执行（第一版就踩了这个坑）。
 */
function machine(key: Buffer): {
  keys: (k: string[]) => string
  map: (m: Record<string, string>) => string
} {
  return {
    keys: (k) => {
      masterKeyManager.setRawKey(key)
      return encryptApiKeys(k)
    },
    map: (m) => {
      masterKeyManager.setRawKey(key)
      return encryptSecretMap(m)
    }
  }
}

function seedProvider(db: Database.Database, id: string, name: string, cipher: string) {
  db.prepare('INSERT INTO providers (id, name, base_url, api_key_encrypted) VALUES (?, ?, ?, ?)')
    .run(id, name, 'https://example.com/v1', cipher)
}

function row(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id) as Record<string, unknown> | undefined
}

describe('跨机合并后的凭据可解性（真密钥实测）', () => {
  it('本机行保留本机密文可继续解；云端独有行解不开但密文完好；对照组会丢 Key', () => {
    const a = machine(keyA)
    const b = machine(keyB)
    const localKeyCipher = a.keys(['local-machine-key-AAAA'])
    const cloudSharedCipher = b.keys(['source-machine-key-BBBB'])
    const cloudOnlyCipher = b.keys(['source-machine-key-CCCC'])
    const localHeaders = a.map({ Authorization: 'Bearer local' })
    const cloudHeaders = b.map({ Authorization: 'Bearer source' })

    // 自检：两把密钥确实互不可解（否则整份测试没有意义）
    masterKeyManager.setRawKey(keyA)
    expect(decryptApiKeys(cloudOnlyCipher)).toEqual([])
    masterKeyManager.setRawKey(keyB)
    expect(decryptApiKeys(localKeyCipher)).toEqual([])

    const local = new Database(':memory:')
    local.exec(PROVIDER_SCHEMA)
    local.exec(`CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, env TEXT, headers TEXT);`)
    seedProvider(local, 'P1', '本机旧名字', localKeyCipher)
    local.prepare('INSERT INTO mcp_servers (id, name, env, headers) VALUES (?,?,?,?)')
      .run('M1', '本机旧名', a.map({ TOKEN: 'local-token' }), localHeaders)

    const cloud = new Database(':memory:')
    cloud.exec(PROVIDER_SCHEMA)
    cloud.exec(`CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, env TEXT, headers TEXT);`)
    seedProvider(cloud, 'P1', '源机新名字', cloudSharedCipher)
    seedProvider(cloud, 'P2', '源机新增', cloudOnlyCipher)
    cloud.prepare('INSERT INTO mcp_servers (id, name, env, headers) VALUES (?,?,?,?)')
      .run('M1', '源机新名', b.map({ TOKEN: 'source-token' }), cloudHeaders)

    // 合并发生在目标机（密钥 = A）
    masterKeyManager.setRawKey(keyA)
    overwriteTable(local, cloud, 'providers', { preserveColumns: ['api_key_encrypted'] })
    overwriteTable(local, cloud, 'mcp_servers', { preserveColumns: ['env', 'headers'] })

    // 1. 本机已有行：非凭据列被云端覆盖，凭据列仍能用本机密钥解开
    const p1 = row(local, 'P1')
    expect(p1?.name).toBe('源机新名字')
    expect(decryptApiKeys(p1?.api_key_encrypted as string)).toEqual(['local-machine-key-AAAA'])
    const m1 = local.prepare('SELECT * FROM mcp_servers WHERE id=?').get('M1') as Record<string, unknown>
    expect(m1.name).toBe('源机新名')
    expect(decryptSecretMap(m1.env as string)).toEqual({ TOKEN: 'local-token' })
    expect(decryptSecretMap(m1.headers as string)).toEqual({ Authorization: 'Bearer local' })

    // 2. 云端独有行：目标机解不开（fail-closed 表现为空），但换回源机密钥可解 ⇒ 密文没坏
    const p2Cipher = row(local, 'P2')?.api_key_encrypted as string
    expect(decryptApiKeys(p2Cipher)).toEqual([])
    masterKeyManager.setRawKey(keyB) // 换回源机身份再解，证明密文本身完好
    expect(decryptApiKeys(p2Cipher)).toEqual(['source-machine-key-CCCC'])
    masterKeyManager.setRawKey(keyA)

    // 3. 对照组：不保留凭据列时，本机行的 Key 在目标机直接消失（本次修复针对的缺陷）
    const local2 = new Database(':memory:')
    local2.exec(PROVIDER_SCHEMA)
    seedProvider(local2, 'P1', '本机旧名字', localKeyCipher)
    overwriteTable(local2, cloud, 'providers')
    expect(row(local2, 'P1')?.name).toBe('源机新名字')
    expect(decryptApiKeys(row(local2, 'P1')?.api_key_encrypted as string)).toEqual([])
  })
})
