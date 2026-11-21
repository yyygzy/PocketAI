// @vitest-environment node
// P2 平台 profile：共享配置在 app_config，平台差异写 profiles/<platform>/override.json。
// 验证 override 优先、删除 override 回落共享值、且 override 不写进 app_config。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = vi.hoisted(() => ({ tmp: '' }))
const savedEnv = process.env.POCKETAI_DATA_DIR
let repo: typeof import('../src/main/db/repositories/app-config.repo')['appConfigRepo']
let selectCount: () => number

beforeEach(async () => {
  roots.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moxia-profile-'))
  process.env.POCKETAI_DATA_DIR = path.join(roots.tmp, 'data')
  const store = new Map<string, string>()
  let count = 0
  selectCount = () => count
  vi.resetModules()
  vi.doMock('../src/main/db/database', () => ({
    dbService: {
      getHandle: () => ({
        prepare: (sql: string) => ({
          get: (key: string) => {
            if (sql.startsWith('SELECT')) count++
            return store.has(key) ? { value: store.get(key) } : undefined
          },
          run: (key: string, value?: string) => {
            if (sql.startsWith('INSERT')) store.set(key, value ?? '')
            else if (sql.startsWith('DELETE')) store.delete(key)
          }
        })
      })
    }
  }))
  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getAppPath: () => roots.tmp,
      getPath: () => roots.tmp,
      getVersion: () => '1.3.0'
    }
  }))
  repo = (await import('../src/main/db/repositories/app-config.repo')).appConfigRepo
})

afterEach(() => {
  fs.rmSync(roots.tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.POCKETAI_DATA_DIR
  else process.env.POCKETAI_DATA_DIR = savedEnv
})

describe('平台 profile 覆盖（P2）', () => {
  it('未覆盖时 getEffective 读共享配置', () => {
    repo.set('theme', 'ocean')
    expect(repo.getEffective('theme')).toBe('ocean')
    expect(repo.listProfileOverrides()).toEqual({})
  })

  it('覆盖值优先于共享配置，且不会写进 app_config', () => {
    repo.set('mcp.command', 'node')
    repo.setOverride('mcp.command', '/usr/bin/node20')

    expect(repo.getEffective('mcp.command')).toBe('/usr/bin/node20')
    expect(repo.get('mcp.command')).toBe('node')

    const file = path.join(
      process.env.POCKETAI_DATA_DIR!,
      'profiles',
      process.platform,
      'override.json'
    )
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    expect(raw['mcp.command']).toBe('/usr/bin/node20')
    expect(selectCount()).toBe(0) // set 已同步缓存，getEffective 命中 override，均无额外查库
  })

  it('删除覆盖后回落到共享配置', () => {
    repo.set('proxy', 'http://shared')
    repo.setOverride('proxy', 'http://platform-only')
    expect(repo.getEffective('proxy')).toBe('http://platform-only')

    repo.setOverride('proxy', null)
    expect(repo.getEffective('proxy')).toBe('http://shared')
    expect(repo.listProfileOverrides()).toEqual({})
  })
})
