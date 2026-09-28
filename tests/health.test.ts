// health 平台管家核心测试
//
// 覆盖 src/main/health/health.ts 三个方法：
// - report：DB 完整性（PRAGMA ok/异常）、孤儿消息/chunk 统计、各计数、attachments 目录大小
//   （目录不存在 / 正常累计 / 单文件 stat 抛错跳过 / readdir 抛错兜底）
// - cleanup：孤儿删除 changes、VACUUM 前后字节差（路径不存在 → 0；exec 抛错忽略）
// - vacuum：同 cleanup 的字节差逻辑
//
// 策略：
// - vi.hoisted 集中 mocks + vi.mock dbService / portable / node:fs
// - mock db 用 SQL normalize（空白折叠）后按特征匹配返回行/changes
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HealthService, healthService } from '../src/main/health/health'

// ---------- mock 工厂 ----------

const mocks = vi.hoisted(() => {
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
  return {
    // PRAGMA integrity_check 返回值
    integrity: 'ok',
    // 各 SQL 特征 → 返回行
    rows: {
      orphanMessages: { c: 5 },
      orphanChunks: { c: 3 },
      kbCount: { c: 2 },
      totalMessages: { c: 100 },
      totalConversations: { c: 10 }
    } as Record<string, unknown>,
    // cleanup 两条 DELETE 的 changes
    changes: { delMessages: 5, delChunks: 3 } as Record<string, number>,
    execError: null as Error | null,
    // 文件系统
    attDirExists: true,
    dbFileExists: true,
    attFiles: ['a.png', 'b.pdf'] as string[],
    attFileSizes: [100, 250] as number[],
    statThrowsIndex: -1, // 第几个文件 statSync 抛错（-1 不抛）
    beforeSize: 1000,
    afterSize: 700,
    vacuumed: false, // exec('VACUUM') 成功后置位，statSync(DB_PATH) 据此返回 after
    reset() {
      this.integrity = 'ok'
      this.rows = {
        orphanMessages: { c: 5 },
        orphanChunks: { c: 3 },
        kbCount: { c: 2 },
        totalMessages: { c: 100 },
        totalConversations: { c: 10 }
      }
      this.changes = { delMessages: 5, delChunks: 3 }
      this.execError = null
      this.attDirExists = true
      this.dbFileExists = true
      this.attFiles = ['a.png', 'b.pdf']
      this.attFileSizes = [100, 250]
      this.statThrowsIndex = -1
      this.beforeSize = 1000
      this.afterSize = 700
      this.vacuumed = false
    },
    // 组装 mock db handle
    makeDb() {
      const m = this
      return {
        prepare(sql: string) {
          const n = normalize(sql)
          if (n.startsWith('PRAGMA integrity_check')) {
            return { get: () => ({ integrity_check: m.integrity }) }
          }
          // DELETE 判定必须在孤儿 SELECT 之前：其子查询同样含 JOIN 特征
          if (n.startsWith('DELETE FROM messages')) {
            return { run: () => ({ changes: m.changes.delMessages }) }
          }
          if (n.startsWith('DELETE FROM kb_chunks')) {
            return { run: () => ({ changes: m.changes.delChunks }) }
          }
          if (n.includes('FROM messages m') && n.includes('LEFT JOIN conversations')) {
            return { get: () => m.rows.orphanMessages }
          }
          if (n.includes('FROM kb_chunks kc') && n.includes('LEFT JOIN kb_documents')) {
            return { get: () => m.rows.orphanChunks }
          }
          if (n.includes('FROM knowledge_bases')) return { get: () => m.rows.kbCount }
          if (n.includes('FROM messages')) return { get: () => m.rows.totalMessages }
          if (n.includes('FROM conversations')) return { get: () => m.rows.totalConversations }
          throw new Error(`未匹配的 SQL: ${n}`)
        },
        exec: (sql: string) => {
          if (m.execError) throw m.execError
          if (normalize(sql) === 'VACUUM') m.vacuumed = true
        }
      }
    }
  }
})

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => mocks.makeDb() }
}))

vi.mock('../src/main/portable', () => ({
  DB_PATH: 'C:\\fake\\data\\app.db',
  DATA_DIR: 'C:\\fake\\data'
}))

vi.mock('node:fs', () => ({
  existsSync: (p: string | Buffer) =>
    String(p).endsWith('attachments') ? mocks.attDirExists : mocks.dbFileExists,
  readdirSync: () => {
    if (!mocks.attDirExists) throw new Error('目录不存在')
    return mocks.attFiles
  },
  statSync: (p: string | Buffer) => {
    if (String(p).endsWith('app.db')) {
      return { size: mocks.vacuumed ? mocks.afterSize : mocks.beforeSize }
    }
    const name = String(p).split('\\').pop() ?? ''
    const idx = mocks.attFiles.indexOf(name)
    if (idx === mocks.statThrowsIndex) throw new Error('stat 失败')
    return { size: mocks.attFileSizes[idx] ?? 0 }
  }
}))

beforeEach(() => mocks.reset())

// ---------- report ----------

describe('HealthService.report 健康报告', () => {
  it('DB 完整性 ok：dbIntegrity.ok=true 且 details 透传', () => {
    const r = new HealthService().report()
    expect(r.dbIntegrity).toEqual({ ok: true, details: 'ok' })
  })

  it('DB 完整性异常：ok=false 且 details 透传异常信息', () => {
    mocks.integrity = '*** in database ***'
    const r = new HealthService().report()
    expect(r.dbIntegrity).toEqual({ ok: false, details: '*** in database ***' })
  })

  it('孤儿与计数聚合正确', () => {
    const r = new HealthService().report()
    expect(r.orphanMessages).toBe(5)
    expect(r.orphanChunks).toBe(3)
    expect(r.kbCount).toBe(2)
    expect(r.totalMessages).toBe(100)
    expect(r.totalConversations).toBe(10)
  })

  it('attachments 目录不存在：totalAttachmentsBytes=0', () => {
    mocks.attDirExists = false
    const r = new HealthService().report()
    expect(r.totalAttachmentsBytes).toBe(0)
  })

  it('attachments 目录正常：累计各文件大小', () => {
    const r = new HealthService().report()
    expect(r.totalAttachmentsBytes).toBe(350)
  })

  it('单文件 stat 抛错：跳过该文件继续累计', () => {
    mocks.statThrowsIndex = 1 // b.pdf stat 失败
    const r = new HealthService().report()
    expect(r.totalAttachmentsBytes).toBe(100)
  })

  it('单例 healthService 与类实例行为一致', () => {
    expect(healthService.report()).toEqual(new HealthService().report())
  })
})

// ---------- cleanup ----------

describe('HealthService.cleanup 垃圾清理', () => {
  it('正常：删除孤儿数取 changes，vacuumedBytes = before - after', () => {
    const r = new HealthService().cleanup()
    expect(r.removedOrphanMessages).toBe(5)
    expect(r.removedOrphanChunks).toBe(3)
    expect(r.vacuumedBytes).toBe(300)
  })

  it('DB 文件不存在：before/after 均为 0，vacuumedBytes=0', () => {
    mocks.dbFileExists = false
    const r = new HealthService().cleanup()
    expect(r.vacuumedBytes).toBe(0)
  })

  it('VACUUM 抛错：忽略，仍返回删除结果；文件未变差值为 0', () => {
    mocks.execError = new Error('VACUUM 失败')
    const r = new HealthService().cleanup()
    expect(r.removedOrphanMessages).toBe(5)
    expect(r.removedOrphanChunks).toBe(3)
    expect(r.vacuumedBytes).toBe(0)
  })

  it('VACUUM 后反而变大：vacuumedBytes 兜底 0 不为负', () => {
    mocks.beforeSize = 500
    mocks.afterSize = 800
    const r = new HealthService().cleanup()
    expect(r.vacuumedBytes).toBe(0)
  })
})

// ---------- vacuum ----------

describe('HealthService.vacuum 手动压缩', () => {
  it('正常：返回 before - after 字节差', () => {
    expect(new HealthService().vacuum()).toBe(300)
  })

  it('DB 文件不存在：返回 0', () => {
    mocks.dbFileExists = false
    expect(new HealthService().vacuum()).toBe(0)
  })

  it('VACUUM 抛错：忽略并返回 0（文件未变）', () => {
    mocks.execError = new Error('VACUUM 失败')
    expect(new HealthService().vacuum()).toBe(0)
  })
})
