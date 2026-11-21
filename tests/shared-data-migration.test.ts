// @vitest-environment node
// P3 双向迁移：配置共享根后，把本机 appData/Moxia/data 复制进共享 data/；
// 源端保留（拔盘后本机仍可用），目标已有数据时跳过。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = vi.hoisted(() => ({ tmp: '', appData: '' }))
const saved = {
  dataDir: process.env.POCKETAI_DATA_DIR,
  appRoot: process.env.POCKETAI_APP_ROOT
}

beforeEach(() => {
  roots.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moxia-shared-migrate-'))
  roots.appData = path.join(roots.tmp, 'appdata')
  delete process.env.POCKETAI_APP_ROOT
  process.env.POCKETAI_DATA_DIR = path.join(roots.tmp, 'drive', 'data')
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(roots.tmp, { recursive: true, force: true })
  for (const [key, value] of [['dataDir', saved.dataDir], ['appRoot', saved.appRoot]] as const) {
    const name = key === 'dataDir' ? 'POCKETAI_DATA_DIR' : 'POCKETAI_APP_ROOT'
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function mockElectron() {
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getAppPath: () => path.join(roots.tmp, 'app'),
      getPath: (name: string) => (name === 'appData' ? roots.appData : roots.tmp),
      getVersion: () => '1.3.0'
    }
  }))
}

function seedInstalled(): string {
  const dir = path.join(roots.appData, 'Moxia', 'data')
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'app.db'), 'SQLite format 3\0shared-migrate')
  fs.writeFileSync(path.join(dir, 'config.json'), '{"ui":{"theme":"ocean"}}')
  fs.writeFileSync(path.join(dir, 'attachments', 'doc.txt'), 'shared attachment')
  return dir
}

async function loadPortable() {
  mockElectron()
  return await import('../src/main/portable')
}

describe('本机数据迁往共享数据根（P3）', () => {
  it('复制并校验后写迁移标记，源端保留', async () => {
    const installed = seedInstalled()
    const m = await loadPortable()
    const result = m.migrateInstalledDataToSharedDir()

    expect(result).not.toBeNull()
    expect(result?.removedLegacy).toBe(false)
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'app.db'), 'utf8')).toBe('SQLite format 3\0shared-migrate')
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'attachments', 'doc.txt'), 'utf8')).toBe('shared attachment')
    expect(fs.existsSync(path.join(installed, 'app.db'))).toBe(true)
    const marker = JSON.parse(fs.readFileSync(path.join(m.DATA_DIR, 'migrated-from.json'), 'utf8')) as Record<string, unknown>
    expect(marker.kind).toBe('installed-to-shared')
    expect(fs.existsSync(path.join(m.DATA_DIR, '.migrating'))).toBe(false)

    // 幂等：目标已有数据时不再迁移
    expect(m.migrateInstalledDataToSharedDir()).toBeNull()
  })

  it('未配置共享根时不迁本机数据', async () => {
    delete process.env.POCKETAI_DATA_DIR
    process.env.POCKETAI_APP_ROOT = path.join(roots.tmp, 'app')
    seedInstalled()
    const m = await loadPortable()
    expect(m.migrateInstalledDataToSharedDir()).toBeNull()
  })
})
