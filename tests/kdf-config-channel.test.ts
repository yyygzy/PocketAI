// SEC-32②：档位记录的落盘通道（config.json 主通道 + app_config 回退副本）
//
// 覆盖 app-config.repo 的 getKdfParams/setKdfParams/clearKdfParams。
// 关注点不是「能不能读写」，而是三条安全属性：
// 1. 主通道被编辑/还原成陌生档位时**不得**直接采用（大 N 会在同步解锁路径打爆主进程）
// 2. 写档位必须写坏不了同文件里的 salt / 恢复包（config.json 是多字段共用文件）
// 3. DB 回退副本读到后要回填文件，否则下次 boot（库未开）仍读不到
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// 探针/临时文件一律放工作区 gitignore 的 data/ 内
const TMP_DIR = join(process.cwd(), 'data', `tmp-kdf-channel-${randomBytes(4).toString('hex')}`)
const CONFIG_PATH = join(TMP_DIR, 'config.json')

function createMockDb() {
  const store = new Map<string, string>()
  return {
    getHandle: () => ({
      prepare: (sql: string) => ({
        get: (key: string) => (sql.startsWith('SELECT') && store.has(key) ? { value: store.get(key) } : undefined),
        run: (key: string, value?: string) => {
          if (sql.startsWith('INSERT')) store.set(key, value ?? '')
          else if (sql.startsWith('DELETE')) store.delete(key)
        }
      })
    }),
    store
  }
}

let mockDb: ReturnType<typeof createMockDb>

async function loadRepo() {
  vi.resetModules()
  mockDb = createMockDb()
  vi.doMock('../src/main/db/database', () => ({ dbService: mockDb }))
  vi.doMock('../src/main/portable', () => ({ CONFIG_PATH, DATA_DIR: TMP_DIR }))
  vi.doMock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const mod = await import('../src/main/db/repositories/app-config.repo')
  return mod.appConfigRepo
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('appConfigRepo 的档位通道', () => {
  it('无记录 ⇒ 历史档（升档功能上线前的所有库行为不变）', async () => {
    const repo = await loadRepo()
    expect(repo.getKdfParams()).toEqual({ N: 32768, r: 8, p: 1 })
  })

  it('config.json 写坏成陌生 N ⇒ 拒绝采用，回落历史档', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ kdfParams: { N: 2 ** 22, r: 8, p: 1 } }), 'utf8')
    const repo = await loadRepo()
    expect(repo.getKdfParams()).toEqual({ N: 32768, r: 8, p: 1 })
  })

  it('config.json 损坏 ⇒ 不抛错，按历史档处理', async () => {
    writeFileSync(CONFIG_PATH, '{ this is not json', 'utf8')
    const repo = await loadRepo()
    expect(repo.getKdfParams().N).toBe(32768)
  })

  it('setKdfParams 双写，且不覆盖同文件里的 salt', async () => {
    const repo = await loadRepo()
    repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })

    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    expect(cfg.kdfParams).toEqual({ N: 131072, r: 8, p: 1 })
    expect(cfg.masterPasswordSalt).toBe(Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64'))
    expect(mockDb!.store.get('master_kdf')).toContain('131072')
    expect(repo.getKdfParams().N).toBe(131072)
  })

  it('主通道被删（config.json 单独还原）⇒ 读 DB 副本并回填文件', async () => {
    const repo = await loadRepo()
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })
    rmSync(CONFIG_PATH)
    expect(repo.getKdfParams().N).toBe(131072) // 从 DB 副本读到
    expect(existsSync(CONFIG_PATH)).toBe(true) // 已回填，boot 预开库阶段不再扑空
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).kdfParams.N).toBe(131072)
  })

  it('clearKdfParams 双删，且保留 salt / 恢复包等其他字段', async () => {
    const repo = await loadRepo()
    repo.setMasterPasswordSalt(Buffer.alloc(16, 7))
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })
    repo.clearKdfParams()

    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    expect(cfg.kdfParams).toBeUndefined()
    expect(cfg.masterPasswordSalt).toBeTypeOf('string')
    expect(mockDb!.store.has('master_kdf')).toBe(false)
    expect(repo.getKdfParams().N).toBe(32768)
  })
})
