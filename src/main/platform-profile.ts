// P2 平台差异配置：data/profiles/<platform>/override.json。
// 放在独立模块，避免 app-config.repo 的「配置读写单一出口」静态闸门被 profile 文件 IO 干扰。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as portable from './portable'

function profileDataDir(): string {
  const globals = globalThis as Record<string, unknown>
  const globalDir = globals.__POCKETAI_DATA_DIR__
  if (typeof globalDir === 'string' && globalDir) return globalDir
  try {
    const mocked = (portable as unknown as Record<string, unknown>).DATA_DIR
    if (typeof mocked === 'string') return mocked
  } catch {
    // 部分 vitest mock 只导出 DB_PATH 等子集，读取缺失导出会抛；忽略即可
  }
  if (process.env.POCKETAI_DATA_DIR) return process.env.POCKETAI_DATA_DIR
  return join(process.cwd(), 'data')
}

export function profileOverrideFile(): string {
  return join(profileDataDir(), 'profiles', process.platform, 'override.json')
}

export function readProfileOverrides(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(profileOverrideFile(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function writeProfileOverrides(overrides: Record<string, string>): void {
  const file = profileOverrideFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(overrides, null, 2), 'utf8')
}
