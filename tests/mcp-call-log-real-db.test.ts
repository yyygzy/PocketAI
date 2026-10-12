// 真库往返：**不 mock 数据库**，直接开一份临时 SQLite 文件走完写入→关库→重开→读出
//
// 为什么要有这条：mcp-call-log-repo 的单测把 dbService 整个桩掉了，于是 B32「跨重启仍可读」
// 与 B33「脱敏发生在写库之前」在 CI 里其实谁都没证过——面板上的 title 只能靠人眼。
// 这里用真库真文件把两条钉死，并且直接查**磁盘字节**里有没有那串假密钥。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-call-log-db'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { mcpCallLogRepo } from '../src/main/db/repositories/mcp-call-log.repo'
import { summarizeMcpArgs, summarizeMcpResult } from '../src/main/mcp/call-summary'

/** 明显的假密钥，只为验证它不会以原文落盘 */
const FAKE_KEY = 'sk-abcdefghijklmnop1234567890'

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('MCP 调用记录真库往返（B32 / B33）', () => {
  it('密钥形状的值先脱敏再落盘：磁盘字节里搜不到原文，重开库仍读得到该行', () => {
    dbService.open()
    dbService.runMigrations()

    mcpCallLogRepo.append({
      serverId: 'srv-real-1',
      tool: 'create_entities',
      ok: true,
      durationMs: 42,
      argsPreview: summarizeMcpArgs({ name: FAKE_KEY, token: FAKE_KEY }),
      resultPreview: summarizeMcpResult({ text: 'created 1 entity' }),
      error: null
    })

    // ① 落盘前就脱敏：整份 db 文件的字节里不该出现原文。
    //    必须先 checkpoint——WAL 模式下新行留在 app.db-wal，直接读主文件会扫到空库假绿。
    dbService.getHandle().pragma('wal_checkpoint(TRUNCATE)')
    const raw = fs.readFileSync(P.db).toString('latin1')
    expect(raw).toContain('create_entities') // 反向确认：行确实在这个文件里，不是空库假绿
    expect(raw).not.toContain(FAKE_KEY)
    expect(raw).toContain('[redacted]')

    // ② 关库重开（等价于应用重启）后仍读得到，且过滤与条数口径不变
    dbService.close()
    dbService.open()
    dbService.runMigrations()

    const all = mcpCallLogRepo.list(null, 50)
    expect(all).toHaveLength(1)
    expect(all[0]!.serverId).toBe('srv-real-1')
    expect(all[0]!.tool).toBe('create_entities')
    expect(all[0]!.ok).toBe(true)
    expect(all[0]!.argsPreview).toContain('[redacted]')
    expect(all[0]!.argsPreview ?? '').not.toContain(FAKE_KEY)
    expect(mcpCallLogRepo.list('other-server', 50)).toHaveLength(0)
  })

  it('反向对照：绕过脱敏直接写，同样的字节扫描就搜得到 ⇒ 上面那条断言有牙齿', () => {
    dbService.open()
    dbService.runMigrations()
    mcpCallLogRepo.append({
      serverId: 'srv-control',
      tool: 'control_no_redact',
      ok: true,
      durationMs: 1,
      argsPreview: `{"name":"${FAKE_KEY}"}`,
      resultPreview: null,
      error: null
    })
    dbService.getHandle().pragma('wal_checkpoint(TRUNCATE)')
    const raw = fs.readFileSync(P.db).toString('latin1')
    expect(raw).toContain('control_no_redact')
    expect(raw).toContain(FAKE_KEY)
    mcpCallLogRepo.clear('srv-control')
  })

  it('环形裁剪在真库里也生效：同一 server 只留 KEEP_PER_SERVER 条', () => {
    dbService.open()
    dbService.runMigrations()
    for (let i = 0; i < 205; i++) {
      mcpCallLogRepo.append({
        serverId: 'srv-real-2',
        tool: `t${i}`,
        ok: true,
        durationMs: 1,
        argsPreview: null,
        resultPreview: null,
        error: null
      })
    }
    const rows = mcpCallLogRepo.list('srv-real-2', 1000)
    expect(rows.length).toBeLessThanOrEqual(200)
    // 留下的是最近的（t204 在、t0 已被裁掉）
    expect(rows.some((r) => r.tool === 't204')).toBe(true)
    expect(rows.some((r) => r.tool === 't0')).toBe(false)
  })

  it('按 server 清空只删自己那份（B34：另一个 server 的行必须原样还在）', () => {
    dbService.open()
    dbService.runMigrations()
    const seed = (serverId: string, n: number): void => {
      for (let i = 0; i < n; i++) {
        mcpCallLogRepo.append({
          serverId,
          tool: `tool-${i}`,
          ok: true,
          durationMs: 1,
          argsPreview: null,
          resultPreview: null,
          error: null
        })
      }
    }
    seed('srv-a', 3)
    seed('srv-b', 5)

    expect(mcpCallLogRepo.clear('srv-a')).toBe(3)
    expect(mcpCallLogRepo.list('srv-a', 100)).toEqual([])
    // 反向对照：没被点到的那个 server 不该被牵连
    expect(mcpCallLogRepo.list('srv-b', 100)).toHaveLength(5)

    // 选「全部」才动得到剩下的（面板上那是另一个选项）。
    // 计数按当下实际行数断言：本文件前面几条用例还留着 srv-real-2 的环形样本。
    const remaining = mcpCallLogRepo.list(undefined, 10_000).length
    expect(remaining).toBeGreaterThan(5)
    expect(mcpCallLogRepo.clear()).toBe(remaining)
    expect(mcpCallLogRepo.list('srv-b', 100)).toEqual([])
  })
})
