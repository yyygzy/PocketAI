// @vitest-environment node
// 共享数据根（P0）：pocketai.json 标记让安装版/便携版都指向移动硬盘上同一份 data/。
// 优先级：POCKETAI_DATA_DIR > 标记 > POCKETAI_APP_ROOT > 开发态 > 便携 > appData 回退。
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

const savedEnv = {
  appRoot: process.env.POCKETAI_APP_ROOT,
  portable: process.env.PORTABLE_EXECUTABLE_DIR,
  dataDir: process.env.POCKETAI_DATA_DIR
}
let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moxia-shared-root-'))
  roots.appData = path.join(tmp, 'appdata')
  roots.exeDir = path.join(tmp, 'drive', 'apps', 'Moxia')
  roots.appPath = path.join(tmp, 'app')
  fs.mkdirSync(roots.exeDir, { recursive: true })
  fs.mkdirSync(roots.appPath, { recursive: true })
  delete process.env.POCKETAI_APP_ROOT
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.POCKETAI_DATA_DIR
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  const restore = (key: 'appRoot' | 'portable' | 'dataDir', name: string) => {
    if (savedEnv[key] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[key]
  }
  restore('appRoot', 'POCKETAI_APP_ROOT')
  restore('portable', 'PORTABLE_EXECUTABLE_DIR')
  restore('dataDir', 'POCKETAI_DATA_DIR')
})

async function loadPortable() {
  return await import('../src/main/portable')
}

function writeMarker(dir: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, 'pocketai.json'), JSON.stringify(body), 'utf8')
}

describe('共享数据根发现（P0）', () => {
  it('安装版在 exe 同目录发现标记时，数据落到标记指定的 dataDir', async () => {
    writeMarker(roots.exeDir, { version: 1, dataDir: 'data' })
    const m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(roots.exeDir, 'data'))
    expect(m.migrateInstalledDataDir()).toBeNull()
  })

  it('标记在父目录时向上查找也能命中（NSIS 装在共享根子目录）', async () => {
    const driveRoot = path.dirname(path.dirname(roots.exeDir))
    writeMarker(driveRoot, { version: 1, dataDir: 'shared-data' })
    const m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(driveRoot, 'shared-data'))
  })

  it('POCKETAI_DATA_DIR 显式指定时优先于标记', async () => {
    writeMarker(roots.exeDir, { version: 1, dataDir: 'data' })
    process.env.POCKETAI_DATA_DIR = path.join(tmp, 'explicit')
    const m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(tmp, 'explicit'))
  })

  it('无效标记（版本不支持 / dataDir 逃逸）被忽略，回退到 appData', async () => {
    writeMarker(roots.exeDir, { version: 2, dataDir: 'data' })
    let m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(roots.appData, 'Moxia', 'data'))

    vi.resetModules()
    writeMarker(roots.exeDir, { version: 1, dataDir: '../outside' })
    m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(roots.appData, 'Moxia', 'data'))
  })

  it('没有标记时保持旧语义：便携走 exe 旁，安装版走 appData', async () => {
    let m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(roots.appData, 'Moxia', 'data'))

    vi.resetModules()
    process.env.PORTABLE_EXECUTABLE_DIR = roots.exeDir
    m = await loadPortable()
    expect(m.DATA_DIR).toBe(path.join(roots.exeDir, 'data'))
  })
})
