// @vitest-environment node
// 路径相对化（P1）：入库写 token，读取按当前数据根还原；URL/裸命令/相对参数必须原样保留。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = vi.hoisted(() => ({ appData: '', exeDir: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      if (name === 'appData') return roots.appData
      if (name === 'exe') return path.join(roots.exeDir, 'Moxia.exe')
      return roots.appData
    },
    getAppPath: () => roots.exeDir,
    getVersion: () => '1.3.0'
  }
}))

const savedEnv = process.env.POCKETAI_DATA_DIR
let tmp: string
let paths: typeof import('../src/main/portable-paths')

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moxia-paths-'))
  roots.appData = path.join(tmp, 'appdata')
  roots.exeDir = path.join(tmp, 'drive')
  process.env.POCKETAI_DATA_DIR = path.join(tmp, 'drive', 'data')
  vi.resetModules()
  // portable 加载后会把 DATA_DIR/APP_ROOT 写到 globalThis，portable-paths 惰性读取
  await import('../src/main/portable')
  paths = await import('../src/main/portable-paths')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.POCKETAI_DATA_DIR
  else process.env.POCKETAI_DATA_DIR = savedEnv
})

describe('共享数据路径序列化（P1）', () => {
  it('数据根下绝对路径 → token → 当前根绝对路径', () => {
    const abs = path.join(process.env.POCKETAI_DATA_DIR!, 'attachments', 'a.pdf')
    const stored = paths.serializeSharedPath(abs)
    expect(stored).toBe('${DATA_DIR}/attachments/a.pdf')
    expect(paths.resolveSharedPath(stored)).toBe(abs)
  })

  it('APP_ROOT 下路径用 APP_ROOT token', () => {
    const abs = path.join(roots.exeDir, 'runtime', 'server.exe')
    const stored = paths.serializeSharedPath(abs)
    expect(stored).toBe('${APP_ROOT}/runtime/server.exe')
    expect(paths.resolveSharedPath(stored)).toBe(abs)
  })

  it('旧 appData/Moxia/data 绝对路径按 Moxia/data 段重绑定到当前数据根', () => {
    const legacy = path.join(roots.appData, 'Moxia', 'data', 'attachments', 'old.pdf')
    expect(paths.resolveSharedPath(legacy)).toBe(
      path.join(process.env.POCKETAI_DATA_DIR!, 'attachments', 'old.pdf')
    )
  })

  it('URL、裸命令和相对参数不被误改', () => {
    const values = ['https://example.com/a.pdf', 'node', 'server.js', '-m', 'C:\\tools\\x.exe']
    for (const v of values) {
      expect(paths.serializeSharedPath(v)).toBe(v)
      expect(paths.resolveSharedPath(v)).toBe(v)
    }
  })

  it('列表序列化/反序列化成对可用', () => {
    const abs = [
      path.join(process.env.POCKETAI_DATA_DIR!, 'a.txt'),
      'node',
      path.join(roots.exeDir, 'tool')
    ]
    const stored = paths.serializeSharedPathList(abs)
    expect(stored).toEqual(['${DATA_DIR}/a.txt', 'node', '${APP_ROOT}/tool'])
    expect(paths.resolveSharedPathList(stored)).toEqual([abs[0], 'node', abs[2]])
  })

  it('token 中的 .. 不会逃出数据根', () => {
    expect(paths.resolveSharedPath('${DATA_DIR}/../../secret')).toBe(
      path.resolve(process.env.POCKETAI_DATA_DIR!)
    )
  })
})
