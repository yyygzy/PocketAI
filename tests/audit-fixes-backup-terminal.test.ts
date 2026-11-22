// 第二批审查项回归：
//  M3 增量恢复替换 DB 后漏清 app_config 内存缓存
//  M4 全量恢复对「有 manifest 但缺 app.db」的备份报告假成功
//  M8 终端 cwd 只校验存在/目录，未校验可写性（与发布说明承诺不符）
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('M3/M4 · 备份恢复', () => {
  it('增量恢复在 writeFileSync 替换 DB 之后调用 clearAppConfigCache()', () => {
    const src = readFileSync('src/main/backup/backup-service.ts', 'utf8')
    const i = src.indexOf('writeFileSync(DB_PATH, dbRes.data)')
    const j = src.indexOf('clearAppConfigCache()', i)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    // 必须落在同一个 try 块内（替换之后、catch 之前）
    expect(src.slice(i, j)).not.toMatch(/\}\s*catch/)
  })

  it('全量恢复缺 app.db 时直接失败，不再报告成功', () => {
    const src = readFileSync('src/main/backup/backup-service.ts', 'utf8')
    const i = src.indexOf("const dbInBackup = join(tmp, 'app.db')")
    expect(i).toBeGreaterThan(-1)
    const segment = src.slice(i, i + 500)
    expect(segment).toMatch(/!existsSync\(dbInBackup\)/)
    expect(segment).toMatch(/备份包缺少 app\.db/)
    expect(segment).toMatch(/return result/)
  })
})

describe('M8 · 终端 cwd 可写性', () => {
  it('resolveTerminalCwd 对每个候选做 W_OK 探测', () => {
    const src = readFileSync('src/main/terminal/terminal-service.ts', 'utf8')
    expect(src).toMatch(/accessSync\(c, constants\.W_OK\)/)
    expect(src).toMatch(/import \{ accessSync, constants, statSync \} from 'node:fs'/)
  })
})
