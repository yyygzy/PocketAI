// reminder.repo 单元测试：行映射 + CRUD + 状态流转 + zod 入参校验（二道防线）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runMock = vi.fn<(sql: string, ...args: unknown[]) => { changes: number }>(() => ({ changes: 1 }))
const getMock = vi.fn<(sql: string, ...args: unknown[]) => unknown>(() => undefined)
const allMock = vi.fn<(sql: string, ...args: unknown[]) => unknown[]>(() => [])
const prepareMock = vi.fn<(sql: string) => { run: typeof runMock; get: typeof getMock; all: typeof allMock }>(() => ({
  run: runMock,
  get: getMock,
  all: allMock
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: prepareMock }) }
}))

import { reminderRepo, computeNextFireAt } from '../src/main/db/repositories/reminder.repo'

const row = {
  id: 'r1',
  text: '开会',
  fire_at: 1000,
  status: 'pending',
  conversation_id: 'c1',
  created_at: 500
}

beforeEach(() => {
  runMock.mockClear()
  getMock.mockClear()
  allMock.mockClear()
  prepareMock.mockClear()
  runMock.mockImplementation(() => ({ changes: 1 }))
  getMock.mockImplementation(() => undefined)
  allMock.mockImplementation(() => [])
})

describe('reminderRepo — CRUD 与状态流转', () => {
  it('create：写入 pending 并返回记录（conversationId 可空）', () => {
    getMock.mockImplementation(() => ({ ...row, conversation_id: null }))
    const rec = reminderRepo.create('  开会  ', 1000)
    expect(rec.text).toBe('开会')
    expect(rec.status).toBe('pending')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('INSERT INTO reminders')
    // INSERT 参数：[id, text, fire_at, status, conversation_id, created_at]
    expect(runMock.mock.calls[0]![1]).toBe('开会')
    expect(runMock.mock.calls[0]![2]).toBe(1000)
    expect(runMock.mock.calls[0]![3]).toBe('pending')
    expect(runMock.mock.calls[0]![4]).toBeNull()
  })

  it('create：空文本/超长 → ZodError', () => {
    expect(() => reminderRepo.create('', 1000)).toThrow()
    expect(() => reminderRepo.create('   ', 1000)).toThrow()
    expect(() => reminderRepo.create('x'.repeat(501), 1000)).toThrow()
  })

  it('listDue：按 fire_at 升序查 pending', () => {
    allMock.mockImplementation(() => [row])
    const out = reminderRepo.listDue(2000)
    expect(out).toHaveLength(1)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('fire_at<=')
    expect(sql).toContain('ORDER BY fire_at ASC')
    expect(allMock.mock.calls[0]![0]).toBe('pending')
    expect(allMock.mock.calls[0]![1]).toBe(2000)
  })

  it('listByStatus：非法 status → ZodError', () => {
    expect(() => reminderRepo.listByStatus('bogus' as never)).toThrow()
  })

  it('listHistory：只查 fired/missed/cancelled 三态，按 fire_at 倒序，默认 50 条', () => {
    allMock.mockImplementation(() => [{ ...row, status: 'fired' }])
    const out = reminderRepo.listHistory()
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe('fired')
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain("status IN ('fired','missed','cancelled')")
    expect(sql).toContain('ORDER BY fire_at DESC')
    expect(allMock.mock.calls[0]![0]).toBe(50)
  })

  it('listHistory：自定义 limit 透传', () => {
    reminderRepo.listHistory(100)
    expect(allMock.mock.calls[0]![0]).toBe(100)
  })

  it('markFired / markMissed：状态翻转', () => {
    reminderRepo.markFired('r1')
    expect(runMock.mock.calls[0]![0]).toBe('fired')
    reminderRepo.markMissed('r2')
    expect(runMock.mock.calls[1]![0]).toBe('missed')
  })

  it('cancel：仅 pending 可取消，changes=0 → false', () => {
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.cancel('r1')).toBe(false)
    expect(String(prepareMock.mock.calls[0]![0])).toContain("status='pending'")
    runMock.mockImplementation(() => ({ changes: 1 }))
    expect(reminderRepo.cancel('r1')).toBe(true)
  })

  it('countPending：返回条数', () => {
    getMock.mockImplementation(() => ({ n: 7 }))
    expect(reminderRepo.countPending()).toBe(7)
  })

  it('行映射：status 非法值兜底 pending，conversation_id null → null', () => {
    getMock.mockImplementation(() => ({ ...row, status: null, conversation_id: null }))
    const rec = reminderRepo.get('r1')
    expect(rec?.status).toBe('pending')
    expect(rec?.conversationId).toBeNull()
  })
})

describe('reminderRepo.update — 编辑 pending', () => {
  it('空 fields → false，不查 DB', () => {
    expect(reminderRepo.update('r1', {})).toBe(false)
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('仅改 text：SET text=?, WHERE status=pending，返回 true', () => {
    expect(reminderRepo.update('r1', { text: '新内容' })).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('SET text=?')
    expect(sql).toContain("status='pending'")
    expect(runMock.mock.calls[0]![0]).toBe('新内容')
    expect(runMock.mock.calls[0]![1]).toBe('r1')
  })

  it('仅改 fireAt：SET fire_at=?', () => {
    expect(reminderRepo.update('r1', { fireAt: 9999 })).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('fire_at=?')
    expect(runMock.mock.calls[0]![0]).toBe(9999)
  })

  it('repeatRule=null：清除循环变一次性，SET repeat_rule=NULL', () => {
    expect(reminderRepo.update('r1', { repeatRule: null })).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('repeat_rule=?')
    expect(runMock.mock.calls[0]![0]).toBeNull()
  })

  it('repeatRule=daily：写入 JSON 字符串', () => {
    expect(reminderRepo.update('r1', { repeatRule: { kind: 'daily', intervalDays: 3 } })).toBe(true)
    expect(runMock.mock.calls[0]![0]).toBe('{"kind":"daily","intervalDays":3}')
  })

  it('三字段合改：SET 三个字段', () => {
    expect(
      reminderRepo.update('r1', {
        text: '合改',
        fireAt: 12345,
        repeatRule: { kind: 'weekly', weekdays: [1, 3] }
      })
    ).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('text=?')
    expect(sql).toContain('fire_at=?')
    expect(sql).toContain('repeat_rule=?')
    expect(runMock.mock.calls[0]![0]).toBe('合改')
    expect(runMock.mock.calls[0]![1]).toBe(12345)
    expect(runMock.mock.calls[0]![2]).toBe('{"kind":"weekly","weekdays":[1,3]}')
    expect(runMock.mock.calls[0]![3]).toBe('r1')
  })

  it('changes=0（非 pending 行）→ false', () => {
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.update('r1', { text: 'x' })).toBe(false)
  })
})

describe('reminderRepo.reschedule — 终态行手动改期（历史 tab 的「改期」入口）', () => {
  const SQL = "UPDATE reminders SET status=?, fire_at=?, repeat_rule=? WHERE id=?"

  it('带规则改期：写回 pending + 新时间 + 规则 JSON', () => {
    expect(reminderRepo.reschedule('r1', 5000, { kind: 'daily', intervalDays: 2 })).toBe(true)
    expect(prepareMock.mock.calls[0]![0]).toBe(SQL)
    expect(runMock.mock.calls[0]).toEqual(['pending', 5000, '{"kind":"daily","intervalDays":2}', 'r1'])
  })

  it('不传规则会把 repeat_rule 写成 NULL —— 调用方（改期弹窗）必须自己带上原规则', () => {
    reminderRepo.reschedule('r1', 5000)
    expect(runMock.mock.calls[0]![2]).toBeNull()
  })

  it('WHERE 只按 id、不带状态条件：这正是 fired/cancelled 行也能改回 pending 的原因', () => {
    reminderRepo.reschedule('r1', 5000, { kind: 'monthly', dayOfMonth: 1 })
    const sql = prepareMock.mock.calls[0]![0]
    // SET 里当然有 status=?，要看的是 WHERE 段
    expect(sql.split('WHERE')[1]!.trim()).toBe('id=?')
  })

  it('记录不存在（changes=0）→ false', () => {
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.reschedule('nope', 5000)).toBe(false)
  })

  it('非法 id 走 schema 二道防线（抛错而不是拼进 SQL）', () => {
    expect(() => reminderRepo.reschedule('', 5000)).toThrow()
    expect(() => reminderRepo.reschedule('r1', 0)).not.toThrow()
  })
})

describe('reminderRepo.rescheduleNext — 一键重新安排 missed 循环', () => {
  it('记录不存在 → { ok: false }', () => {
    getMock.mockImplementation(() => undefined)
    expect(reminderRepo.rescheduleNext('r1')).toEqual({ ok: false })
  })

  it('一次性提醒（无 repeatRule）→ { ok: false }', () => {
    getMock.mockImplementation(() => ({ ...row, repeat_rule: null, status: 'missed' }))
    expect(reminderRepo.rescheduleNext('r1')).toEqual({ ok: false })
  })

  it('daily 循环：按 computeNextFireAt 重算 next，且**必须追平到 now 之后**（§332）', () => {
    getMock.mockImplementation(() => ({
      ...row,
      fire_at: 1000,
      status: 'missed',
      repeat_rule: '{"kind":"daily","intervalDays":1}'
    }))
    const before = Date.now()
    const out = reminderRepo.rescheduleNext('r1')
    expect(out.ok).toBe(true)
    // §332 之前这一条钉的是 `86401000`——那是**过去时刻**，主进程把它原样写回 pending，
    // 调度器下一个 30s tick 又算"到期"，于是一条早就错过的日提醒会连环弹通知直到追平。
    // 口径改成：结果严格 > now，且仍踩在原来的日周期上（不许顺手漂到别的时刻）。
    const nextFireAt = out.fireAt as number
    expect(nextFireAt).toBeGreaterThan(before)
    expect((nextFireAt - 1000) % 86_400_000).toBe(0)
    // reschedule 走 run：参数 (status='pending', fireAt, ruleJson, id)
    expect(runMock.mock.calls[0]![0]).toBe('pending')
    expect(runMock.mock.calls[0]![1]).toBe(nextFireAt)
    expect(runMock.mock.calls[0]![2]).toBe('{"kind":"daily","intervalDays":1}')
    expect(runMock.mock.calls[0]![3]).toBe('r1')
  })

  it('reschedule 返回 false（changes=0）→ { ok: false }', () => {
    getMock.mockImplementation(() => ({
      ...row,
      repeat_rule: '{"kind":"daily","intervalDays":1}'
    }))
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.rescheduleNext('r1')).toEqual({ ok: false })
  })
})

describe('computeNextFireAt — monthly 月末回落', () => {
  const day = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h, 0, 0, 0).getTime()

  it('普通号数直接进下一个自然月的同一天', () => {
    const next = computeNextFireAt(day(2026, 0, 15), { kind: 'monthly', dayOfMonth: 15 }, day(2026, 0, 15))
    expect(new Date(next)).toEqual(new Date(2026, 1, 15, 9, 0, 0, 0))
  })

  it('31 号在短月回落到月末，但下个月仍回到 31 号（旧实现 min(day,28) 会从此卡在 28 号）', () => {
    const rule = { kind: 'monthly', dayOfMonth: 31 } as const
    const feb = computeNextFireAt(day(2026, 0, 31), rule, day(2026, 1, 1))
    expect(new Date(feb).getDate()).toBe(28) // 2026 非闰年，2 月只到 28
    const mar = computeNextFireAt(feb, rule, feb)
    expect(new Date(mar).getMonth()).toBe(2)
    expect(new Date(mar).getDate()).toBe(31) // 不能被粘在 28 号
  })

  it('闰年 2 月取 29 号', () => {
    const next = computeNextFireAt(day(2024, 0, 31), { kind: 'monthly', dayOfMonth: 31 }, day(2024, 1, 1))
    expect(new Date(next)).toEqual(new Date(2024, 1, 29, 9, 0, 0, 0))
  })

  it('30 号在 2 月回落、在 4 月也回落、其余月照旧', () => {
    const rule = { kind: 'monthly', dayOfMonth: 30 } as const
    expect(new Date(computeNextFireAt(day(2026, 0, 30), rule, day(2026, 1, 1))).getDate()).toBe(28)
    const apr = computeNextFireAt(day(2026, 2, 30), rule, day(2026, 3, 1))
    expect(new Date(apr)).toEqual(new Date(2026, 3, 30, 9, 0, 0, 0))
  })

  it('跨年进位（12 月的下一次是次年 1 月）', () => {
    const next = computeNextFireAt(day(2026, 11, 10), { kind: 'monthly', dayOfMonth: 5 }, day(2026, 11, 20))
    expect(new Date(next)).toEqual(new Date(2027, 0, 5, 9, 0, 0, 0))
  })

  it('时分秒沿用上一次触发的墙钟时间', () => {
    const prev = new Date(2026, 0, 31, 21, 45, 30, 0).getTime()
    const next = computeNextFireAt(prev, { kind: 'monthly', dayOfMonth: 15 }, prev)
    const d = new Date(next)
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([21, 45, 30])
  })

  it('候选仍 ≤ now 时逐月递推（补录/长期休眠后醒来）', () => {
    const rule = { kind: 'monthly', dayOfMonth: 31 } as const
    const next = computeNextFireAt(day(2026, 0, 31), rule, day(2026, 5, 1))
    const d = new Date(next)
    expect(d.getTime()).toBeGreaterThan(day(2026, 5, 1))
    expect([d.getMonth(), d.getDate()]).toEqual([5, 30]) // 6 月没有 31 号 → 6/30
  })

  it('now 远在 14 年后：递推不设步数上限，仍落到 now 那个月（§332 改前只递推 8 次⇒那种跨度交出去仍是过去时刻）', () => {
    const far = day(2040, 0, 1)
    const next = computeNextFireAt(day(2026, 0, 31), { kind: 'monthly', dayOfMonth: 31 }, far)
    expect(Number.isFinite(next)).toBe(true)
    expect(next, '追平是这句的本意：远在 14 年后的 now 也必须拿到 now 之后的时刻').toBeGreaterThan(far)
    expect(new Date(next)).toEqual(new Date(2040, 0, 31, 9, 0, 0, 0)) // 落在 now 那个月的号数，不多跳
    expect(next).toBeLessThan(far + 2 * 86_400_000 * 31)
  })
})

// §332 R4：三档循环规则的「追平」口径。改前只有 monthly 一支在递推，daily／weekly 连注释里
// 那句「结果必须 > now」都没兑现（`scheduler.ts:29` 把过去时刻原样写回 pending ⇒ 连环弹通知）。
describe('computeNextFireAt — §332 三档都要追平到 now 之后', () => {
  const DAY = 86_400_000
  const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h, 0, 0, 0).getTime()

  it('daily 错过 10 天 ⇒ 追平到 now 之后，且仍踩在原来的日周期上', () => {
    const now = at(2026, 9, 20, 18)
    const prev = at(2026, 9, 10, 9) // 10 天前的那一次触发
    const next = computeNextFireAt(prev, { kind: 'daily', intervalDays: 1 }, now)
    expect(next).toBeGreaterThan(now)
    expect((next - prev) % DAY, '不许顺手漂到别的时刻：仍与 prev 同一天周期网格').toBe(0)
    expect(next - now, '追平后最多再等一个周期').toBeLessThanOrEqual(DAY)
    expect(new Date(next).getHours(), '墙钟 9 点还是 9 点').toBe(9)
  })

  it('daily intervalDays=3 错过 20 天 ⇒ 按 3 天网格追平', () => {
    const now = at(2026, 9, 20, 18)
    const prev = at(2026, 8, 30, 9)
    const next = computeNextFireAt(prev, { kind: 'daily', intervalDays: 3 }, now)
    expect(next).toBeGreaterThan(now)
    expect((next - prev) % (3 * DAY)).toBe(0)
    expect(next - now).toBeLessThanOrEqual(3 * DAY)
  })

  it('daily 一年没开机 ⇒ 照样追平（改前根本没有追平这一步，交出去的就是一年前那个过去时刻）', () => {
    const now = at(2027, 9, 20, 18)
    const prev = at(2026, 9, 20, 9)
    const next = computeNextFireAt(prev, { kind: 'daily', intervalDays: 1 }, now)
    expect(next).toBeGreaterThan(now)
    expect(next - now).toBeLessThanOrEqual(DAY)
    // 这一条跨年，不钉网格／墙钟：三档都是 ms 递推，带夏令时的机器上跨年本来就差一小时
    // （R8 那条 DST 只记档未修，别把它的现状当成契约钉住）
  })

  it('边界：候选恰好等于 now ⇒ 严格大于 now（"到点"与"已过点"不能留给下一个 tick 连环弹）', () => {
    const now = at(2026, 9, 20, 18)
    const prev = now - DAY // daily：candidate = prev + DAY = now
    const next = computeNextFireAt(prev, { kind: 'daily', intervalDays: 1 }, now)
    expect(next).toBeGreaterThan(now)
    expect(next).toBe(now + DAY)
  })

  it('weekly [周五] 错过两周多 ⇒ 追平后仍是周五、同一墙钟时刻，且最多再等一周', () => {
    const now = at(2026, 9, 20, 18) // 2026-10-20 是周二
    const prev = at(2026, 9, 2, 9) // 两周半前的周五（整段在同一次夏令时区间内，跨年那条不钉墙钟）
    expect(new Date(prev).getDay()).toBe(5)
    const next = computeNextFireAt(prev, { kind: 'weekly', weekdays: [5] }, now)
    expect(next).toBeGreaterThan(now)
    const d = new Date(next)
    expect(d.getDay(), '周五的提醒不许追平到别的日子').toBe(5)
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 0])
    expect(next - now).toBeLessThanOrEqual(7 * DAY)
  })

  it('weekly 空 weekdays（脏规则）⇒ 退化成 7 天周期，同样必须 > now', () => {
    const now = at(2026, 9, 20, 18)
    const prev = now - 30 * DAY
    const next = computeNextFireAt(prev, { kind: 'weekly', weekdays: [] }, now)
    expect(next).toBeGreaterThan(now)
    expect(next - now).toBeLessThanOrEqual(7 * DAY)
  })

  it('monthly 停机关了半年 ⇒ 追平到 now 之后所在的那个月，号数照旧', () => {
    const now = at(2026, 9, 20, 18)
    const prev = at(2026, 3, 15, 9) // 半年前的 15 号
    const next = computeNextFireAt(prev, { kind: 'monthly', dayOfMonth: 15 }, now)
    expect(next).toBeGreaterThan(now)
    const d = new Date(next)
    expect([d.getMonth(), d.getDate()], 'now 在 10 月 20 日、15 号已过 ⇒ 跳到 11 月 15 日').toEqual([10, 15])
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 0])
  })

  it('三档共同的反向钉：结果永远不可能 ≤ now（追平后立刻"到期"＝连环弹通知）', () => {
    const now = Date.now()
    const cases: Array<{ prev: number; rule: Parameters<typeof computeNextFireAt>[1] }> = [
      { prev: now - 400 * DAY, rule: { kind: 'daily', intervalDays: 1 } },
      { prev: now - 400 * DAY, rule: { kind: 'weekly', weekdays: [1, 3, 5] } },
      { prev: now - 400 * DAY, rule: { kind: 'monthly', dayOfMonth: 29 } }
    ]
    for (const c of cases) {
      const next = computeNextFireAt(c.prev, c.rule, now)
      expect(next, `规则 ${JSON.stringify(c.rule)} 交出过去时刻`).toBeGreaterThan(now)
    }
  })
})
