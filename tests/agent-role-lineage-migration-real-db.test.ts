// 角色归因与子会话归属（migration v48，V4-Iter-143）——真库 + 真 runMigrations()
//
// 为什么必须真库：这一批改的是**表结构与读取映射**，手抄 fixture 的建表语句抄对了就绿、
// 抄错了也绿（版本号撞车、ALTER 漏一条都测不到）——同 v46 那条教训（agent-trace-split-real-db.test.ts）。
//
// 三条要钉住的语义（都来自 2026-10-15 决策②「子代理用独立会话」）：
//  · 角色只有 `conversations.role_key` 一个家（方案初稿把 role_key 放在 traces 上，那是决策没定时的形状；
//    两处都放＝同一份口径写两处，改一处等于把缺陷挪个地方）；
//  · `agent_traces.parent_request_id` 只承载"我的父运行是谁"，成本按整棵编排树聚合；
//  · **零行为变化**：旧行与现网会话读成 null，列表/聚合一字不变，子运行的账不许并进父会话的会话级统计。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-role-lineage'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'

const NEW_COLS = {
  conversations: ['parent_conversation_id', 'role_key'],
  agent_traces: ['parent_request_id']
} as const

function columns(table: keyof typeof NEW_COLS): string[] {
  return (dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

/**
 * 造一个"还没跑过 v48"的库：拿 sqlite_master 里**真实**的建表语句去掉这三列后重建，
 * 再把原有行搬回来、索引重建，最后只退回 v48 那一条迁移记录。
 * 三件事刻意不做：① 不手抄旧 DDL（抄一份三年前的结构＝假绿）；② 不退 `version = 48` 之外的
 * 任何一条（ALTER TABLE ADD COLUMN 不可重入，退多了下一条迁移当场崩 —— v47 时就真炸过）；
 * ③ 不丢数据：`DROP TABLE` 会连行一起删，第一版就是这么把"旧行"自己删掉的，
 * 于是那条断言其实什么都没验。真实升级是"老库原地长出新列"，所以行必须搬回来。
 */
function rewindToBeforeV48(): void {
  const db = dbService.getHandle()
  for (const [table, names] of Object.entries(NEW_COLS)) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
      .all(table) as Array<{ sql: string }>
    const { sql } = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', table) as { sql: string }

    let legacy = sql
    for (const n of names) {
      // SQLite 把 ALTER ADD COLUMN 的列**追加在建表语句右括号之前**（形如 `..., role_key TEXT)`），
      // 不是插进表体里 —— 第一版按"整行定义"匹配，当场红。
      const re = new RegExp(`,\\s*"?${n}"?\\s+TEXT`, 'i')
      expect(legacy, `没在 ${table} 的建表语句里找到列 ${n}：\n${sql}`).toMatch(re)
      legacy = legacy.replace(re, '')
    }
    expect(legacy).not.toMatch(/parent_conversation_id|role_key|parent_request_id/)

    db.exec(`DROP TABLE ${table}`)
    db.exec(legacy)
    if (rows.length > 0) {
      const kept = Object.keys(rows[0]!).filter((k) => !(names as readonly string[]).includes(k))
      const stmt = db.prepare(
        `INSERT INTO ${table} (${kept.join(', ')}) VALUES (${kept.map(() => '?').join(', ')})`
      )
      for (const r of rows) stmt.run(...kept.map((k) => r[k] as string | number | null))
    }
    for (const i of idx) db.exec(i.sql)
  }
  db.exec('DELETE FROM schema_migrations WHERE version = 48')
}

let PARENT_CONV = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  PARENT_CONV = conversationRepo.create({ title: '父会话', assistantId: 'a1' }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('v48 结构', () => {
  it('全新库跑完迁移：三列都在，且 schema_migrations 记的是这一条的名字', () => {
    expect(columns('conversations')).toEqual(expect.arrayContaining([...NEW_COLS.conversations]))
    expect(columns('agent_traces')).toEqual(expect.arrayContaining([...NEW_COLS.agent_traces]))
    const row = dbService
      .getHandle()
      .prepare('SELECT name FROM schema_migrations WHERE version = ?')
      .get(48) as { name: string } | undefined
    expect(row?.name).toBe('agent_role_lineage')
  })

  it('PRAGMA 给的类型是 TEXT 且可空（没有 NOT NULL、也没有默认值——旧行必须是 NULL 而不是空串）', () => {
    const info = (table: keyof typeof NEW_COLS, col: string) =>
      dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all().find((c: any) => c.name === col)
    for (const [table, names] of Object.entries(NEW_COLS) as Array<[keyof typeof NEW_COLS, readonly string[]]>) {
      for (const n of names) {
        const c = info(table, n) as any
        expect(c.type).toBe('TEXT')
        expect(c.notnull).toBe(0)
        expect(c.dflt_value).toBeNull()
      }
    }
  })

  it('升级路径：把表退回 v47 形状 + 塞旧行 ⇒ 迁移补列，旧行读成 null 而不是崩', () => {
    // 旧数据：一条没有父的会话 + 一条不属于任何委派的 trace
    const legacyConv = conversationRepo.create({ title: '老会话', assistantId: 'a-old' }).id
    agentTraceRepo.insert({ requestId: 'r-legacy', conversationId: legacyConv, stepIndex: 0, stepType: 'llm', durationMs: 500, status: 'success' })

    rewindToBeforeV48()
    dbService.runMigrations()

    expect(columns('conversations')).toEqual(expect.arrayContaining([...NEW_COLS.conversations]))
    const back = conversationRepo.get(legacyConv)!
    expect(back.title).toBe('老会话')
    expect(back.parentConversationId).toBeNull()
    expect(back.roleKey).toBeNull()
    const tr = agentTraceRepo.latestTracesByConversation(legacyConv)[0]!
    expect(tr.requestId).toBe('r-legacy')
    expect(tr.parentRequestId).toBeNull()
    // 列表没被新列影响（反向对照：老会话仍在，且仍读得出 null 归属）
    expect(conversationRepo.list('a-old').map((c) => c.id)).toContain(legacyConv)
  })

  it('重复跑迁移不会再 ALTER（版本门挡着，不然 duplicate column 当场崩）', () => {
    expect(() => dbService.runMigrations()).not.toThrow()
  })
})

describe('读写往返（144 的写入方要用到的语义，现在就钉住）', () => {
  it('子会话归属与角色：写进去能原样读回，关库重开仍在', () => {
    const child = conversationRepo.create({ title: '子会话：资料检索', assistantId: 'a1' }).id
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET parent_conversation_id=?, role_key=? WHERE id=?')
      .run(PARENT_CONV, 'researcher', child)

    const back = conversationRepo.get(child)!
    expect(back.parentConversationId).toBe(PARENT_CONV)
    expect(back.roleKey).toBe('researcher')

    dbService.close()
    dbService.open()
    expect(conversationRepo.get(child)).toMatchObject({ parentConversationId: PARENT_CONV, roleKey: 'researcher' })
  })

  it('trace 的 parentRequestId 经 repo.insert 落库并读回；不传就是 null（不是空串）', () => {
    const childConv = conversationRepo.create({ title: '子会话：写作', assistantId: 'a1' }).id
    agentTraceRepo.insert({
      requestId: 'r-child',
      conversationId: childConv,
      parentRequestId: 'r-controller',
      stepIndex: 0,
      stepType: 'llm',
      durationMs: 900,
      tokenUsage: 300,
      status: 'success'
    })
    agentTraceRepo.insert({ requestId: 'r-parent', conversationId: PARENT_CONV, stepIndex: 0, stepType: 'llm', durationMs: 100, status: 'success' })

    const childRow = agentTraceRepo.listByRequest('r-child')[0]!
    expect(childRow.parentRequestId).toBe('r-controller')
    // 反向对照：没传的那条不许被写成 ''，必须是 null——否则 144 分不清"没父"与"父 id 是空串"
    expect(agentTraceRepo.listByRequest('r-parent')[0]!.parentRequestId).toBeNull()
    expect(conversationRepo.get(childConv)!.roleKey).toBeNull()
  })

  it('父会话的会话级统计不被子运行计入（独立会话的代价就是账本天然分开；这条是 146 成本轴的底座）', () => {
    const before = agentTraceRepo.sessionStatsByConversation(PARENT_CONV)!
    const childConv = conversationRepo.create({ title: '子会话：审校', assistantId: 'a1' }).id
    agentTraceRepo.insert({ requestId: 'r-child2', conversationId: childConv, parentRequestId: 'r-parent', stepIndex: 0, stepType: 'llm', durationMs: 99999, tokenUsage: 88888, status: 'success' })

    const after = agentTraceRepo.sessionStatsByConversation(PARENT_CONV)!
    expect(after).toEqual(before)
    // 子会话自己那摊账独立可见
    expect(agentTraceRepo.sessionStatsByConversation(childConv)).toMatchObject({ runCount: 1, totalTokens: 88888 })
  })

  it('latestRequestId 仍只认"最近一次运行"：带父的行不改变取法（这一列不参与排序/过滤）', () => {
    const conv = conversationRepo.create({ title: '归属不影响聚合', assistantId: 'a1' }).id
    agentTraceRepo.insert({ requestId: 'first', conversationId: conv, stepIndex: 0, stepType: 'llm', durationMs: 10, status: 'success' })
    // 同毫秒时靠 rowid 兜底：后插入的那条才是"最近一次"
    agentTraceRepo.insert({ requestId: 'second', conversationId: conv, parentRequestId: 'first', stepIndex: 0, stepType: 'llm', durationMs: 40, status: 'success' })
    expect(agentTraceRepo.latestStatsByConversation(conv)).toMatchObject({ totalDurationMs: 40, stepCount: 1 })
  })
})
