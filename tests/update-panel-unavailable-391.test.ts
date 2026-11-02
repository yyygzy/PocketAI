// @vitest-environment node
// §391 闸门：UpdatePanel 的 statusInfoOf 在 'unavailable' 分支必须按 status?.error 有无分两档
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src/renderer/src/modules/settings/SettingsModule.tsx')
const lines = readFileSync(SRC, 'utf-8').split(/\r?\n/)

describe('§391 gate: unavailable 分支按 error 有无分两档', () => {
  // 找到 case 'unavailable' 那一行
  const idx = lines.findIndex((l) => l.includes("case 'unavailable'"))
  expect(idx).toBeGreaterThan(0)

  it('紧跟 case 的行读 status?.error（三元或 if），不是无条件的 upd.unavailable', () => {
    // 取 case 后面 3 行
    const next3 = lines.slice(idx + 1, idx + 4).join('\n')
    expect(next3).toMatch(/status\?*\.error/)
  })

  it('true 分支用 upd.notSupported', () => {
    const next3 = lines.slice(idx + 1, idx + 4).join('\n')
    expect(next3).toMatch(/upd\.notSupported/)
  })

  it('false 分支保留 upd.unavailable（真检了没更新那档还是绿的）', () => {
    const next3 = lines.slice(idx + 1, idx + 4).join('\n')
    expect(next3).toMatch(/upd\.unavailable/)
  })

  it('四语字典都有 upd.notSupported 键', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const dict = readFileSync(join(process.cwd(), `src/renderer/src/i18n/${lang}.ts`), 'utf-8')
      expect(dict).toContain("'upd.notSupported'")
    }
  })
})
