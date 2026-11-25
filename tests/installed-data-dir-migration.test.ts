// @vitest-environment node
// 安装版数据目录迁移：≤1.2.8 把数据放在安装目录 data/ 下，NSIS 覆盖安装会整目录重建，
// 于是 1.3.0 把落点改到 appData/Moxia/data 并做一次性迁移。这里用真实文件系统验证三条判据：
//   ① 复制 + 校验通过后才清理旧目录，且写 migrated-from.json；
//   ② 新位置已有数据时不再迁移、旧目录原样保留；
//   ③ 迁移失败时原数据完好、新位置不留半成品（不能把丢数据演成全新安装）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = vi.hoisted(() => ({ appData: '', exeDir: '', appPath: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      if (name === 'appData') return roots.appData
      if (name === 'exe') return path.join(roots.exeDir, 'Moxia.exe')
      return roots.appData
    },
    getAppPath: () => roots.appPath,
    getVersion: () => '1.3.0'
  }
}))

const savedEnv = { appRoot: process.env.POCKETAI_APP_ROOT, portable: process.env.PORTABLE_EXECUTABLE_DIR }
let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moxia-migrate-'))
  roots.appData = path.join(tmp, 'appdata')
  roots.exeDir = path.join(tmp, 'install')
  roots.appPath = path.join(tmp, 'app')
  fs.mkdirSync(roots.exeDir, { recursive: true })
  fs.mkdirSync(roots.appPath, { recursive: true })
  delete process.env.POCKETAI_APP_ROOT
  delete process.env.PORTABLE_EXECUTABLE_DIR
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  if (savedEnv.appRoot === undefined) delete process.env.POCKETAI_APP_ROOT
  else process.env.POCKETAI_APP_ROOT = savedEnv.appRoot
  if (savedEnv.portable === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR
  else process.env.PORTABLE_EXECUTABLE_DIR = savedEnv.portable
})

function seedLegacyData(): string {
  const legacy = path.join(roots.exeDir, 'data')
  fs.mkdirSync(path.join(legacy, 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'app.db'), 'SQLite format 3\0fake-db-content')
  fs.writeFileSync(path.join(legacy, 'config.json'), '{"ui":{"theme":"deep-ocean"}}')
  fs.writeFileSync(path.join(legacy, 'attachments', 'kb-doc.txt'), '知识库文档痕迹')
  return legacy
}

async function loadModule() {
  return await import('../src/main/portable')
}

describe('安装版数据目录迁移', () => {
  it('复制校验通过后清理旧目录并写迁移标记', async () => {
    const legacy = seedLegacyData()
    const m = await loadModule()

    expect(m.DATA_DIR).toBe(path.join(roots.appData, 'Moxia', 'data'))
    const result = m.migrateInstalledDataDir()

    expect(result).not.toBeNull()
    expect(result?.removedLegacy).toBe(true)
    expect(fs.existsSync(path.join(m.DATA_DIR, 'app.db'))).toBe(true)
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'app.db'), 'utf8')).toBe('SQLite format 3\0fake-db-content')
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'attachments', 'kb-doc.txt'), 'utf8')).toBe('知识库文档痕迹')
    expect(fs.existsSync(path.join(m.DATA_DIR, 'migrated-from.json'))).toBe(true)
    expect(fs.existsSync(path.join(m.DATA_DIR, '.migrating'))).toBe(false)
    expect(fs.existsSync(legacy)).toBe(false)
    expect(result?.files).toBe(3)
  })

  it('迁移时不覆盖目标已建的 Electron 缓存，也不搬运旧缓存', async () => {
    const legacy = seedLegacyData()
    fs.mkdirSync(path.join(legacy, 'userdata', 'GPUCache'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'userdata', 'GPUCache', 'stale-cache'), 'old-cache')
    const m = await loadModule()

    fs.mkdirSync(path.join(m.DATA_DIR, 'userdata', 'GPUCache'), { recursive: true })
    fs.writeFileSync(path.join(m.DATA_DIR, 'userdata', 'GPUCache', 'live-cache'), 'current-cache')

    const result = m.migrateInstalledDataDir()

    expect(result?.files).toBe(3)
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'app.db'), 'utf8')).toBe('SQLite format 3\0fake-db-content')
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'userdata', 'GPUCache', 'live-cache'), 'utf8')).toBe('current-cache')
    expect(fs.existsSync(path.join(m.DATA_DIR, 'userdata', 'GPUCache', 'stale-cache'))).toBe(false)
  })

  it('新位置已有数据库时跳过迁移，旧目录原样保留', async () => {
    const legacy = seedLegacyData()
    const m = await loadModule()
    fs.mkdirSync(m.DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(m.DATA_DIR, 'app.db'), 'new-install-db')

    expect(m.migrateInstalledDataDir()).toBeNull()
    expect(fs.readFileSync(path.join(m.DATA_DIR, 'app.db'), 'utf8')).toBe('new-install-db')
    expect(fs.existsSync(path.join(legacy, 'app.db'))).toBe(true)
  })

  it('新位置无法创建时抛错，旧数据完好且不留半成品', async () => {
    const legacy = seedLegacyData()
    const m = await loadModule()
    // 让 appData 的父路径是个文件 → mkdir(DATA_DIR) 必失败
    fs.writeFileSync(roots.appData, 'not-a-dir')

    expect(() => m.migrateInstalledDataDir()).toThrow(/数据迁移失败/)
    expect(fs.readFileSync(path.join(legacy, 'app.db'), 'utf8')).toBe('SQLite format 3\0fake-db-content')
    expect(fs.existsSync(path.join(legacy, 'attachments', 'kb-doc.txt'))).toBe(true)
  })

  it('便携形态（PORTABLE_EXECUTABLE_DIR）不迁移，数据仍落在 exe 旁', async () => {
    seedLegacyData()
    process.env.PORTABLE_EXECUTABLE_DIR = roots.exeDir
    vi.resetModules()
    const m = await loadModule()

    expect(m.DATA_DIR).toBe(path.join(roots.exeDir, 'data'))
    expect(m.migrateInstalledDataDir()).toBeNull()
    expect(fs.existsSync(path.join(roots.exeDir, 'data', 'app.db'))).toBe(true)
  })
})
