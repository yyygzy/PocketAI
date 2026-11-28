// SEC-16-09：日历 .ics 写入通道走 path-token
//
// 三个验收面：
// ① 渲染层传任意绝对路径（不经对话框）被拒——resolveIcsPathTokens 对非本进程签发的
//    句柄一律解析不出，裸绝对路径混在 token 数组里也进不了清单；
// ② token 流程可保存成功——issuePathToken 签发 → peek 解析 → cleanIcsCandidates 清洗 → 落库；
// ③ schema 校验与审批披露字段（buildCalendarApprovalPreview）。
//
// 边界桩：electron（portable-paths 惰性用到）与 app-config.repo（换 Map 存储，避免起真库）。
// dialog-path-token 是纯内存模块（node:crypto），真用不桩——被测对象就是它。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({}))

const kv = new Map<string, string>()
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => kv.get(key) ?? null,
    set: (key: string, value: string) => {
      kv.set(key, value)
    }
  }
}))

import { IPC } from '../src/shared/types'
import { calendarConfigSchema } from '../src/shared/schemas/agent'
import {
  resolveIcsPathTokens,
  cleanIcsCandidates,
  setCalendarConfig,
  getCalendarConfig,
  buildCalendarApprovalPreview
} from '../src/main/tools/calendar-ics'
import { issuePathToken, peekPathToken, dropPathToken, resetPathTokensForTest } from '../src/main/ipc/dialog-path-token'

beforeEach(() => {
  kv.clear()
  resetPathTokensForTest()
})

describe('① 渲染层传任意绝对路径被拒', () => {
  it('裸绝对路径不是本进程签发的句柄 ⇒ 解析不出来，一个都进不了清单', () => {
    const r = resolveIcsPathTokens(['C:\\Users\\x\\secret.ics', '/etc/passwd.ics', '/home/u/diary.ics'])
    expect(r.paths).toEqual([])
    expect(r.unknownCount).toBe(3)
  })

  it('真 token 与伪造路径混在一批 ⇒ 只收真的，伪造的计入 unknownCount', () => {
    const token = issuePathToken('C:\\cal\\a.ics')
    const r = resolveIcsPathTokens([token, 'C:\\Users\\x\\secret.ics'])
    expect(r.paths).toEqual(['C:\\cal\\a.ics'])
    expect(r.unknownCount).toBe(1)
  })

  it('非字符串项（注入对象/数字）同样被拒，不抛', () => {
    expect(resolveIcsPathTokens([{ path: 'C:\\x.ics' }, 42, null])).toEqual({ paths: [], unknownCount: 3 })
    expect(resolveIcsPathTokens(undefined)).toEqual({ paths: [], unknownCount: 0 })
  })
})

describe('② token 流程可保存成功', () => {
  it('对话框签发的 token → 解析 → 保存，回读清单里有真实路径', () => {
    const token = issuePathToken('C:\\cal\\meeting.ics')
    const { paths } = resolveIcsPathTokens([token])
    const next = setCalendarConfig({ enabled: true, addPaths: paths })
    expect(next.enabled).toBe(true)
    expect(next.paths).toEqual(['C:\\cal\\meeting.ics'])
    // 兼容口径：getCalendarConfig 读回的就是这份（旧库路径照常可读）
    expect(getCalendarConfig().paths).toEqual(['C:\\cal\\meeting.ics'])
  })

  it('peek 不消费：保存失败前可整批重试；成功 drop 后 token 一次作废', () => {
    const token = issuePathToken('C:\\cal\\a.ics')
    expect(peekPathToken(token)).toBe('C:\\cal\\a.ics')
    expect(peekPathToken(token)).toBe('C:\\cal\\a.ics') // 重试复用同一份
    dropPathToken(token)
    expect(peekPathToken(token)).toBeNull()
    expect(resolveIcsPathTokens([token]).unknownCount).toBe(1)
  })

  it('清洗规则沿用：非 .ics 拒、与已存清单去重、上限 10 条', () => {
    const existing = ['C:\\cal\\a.ics']
    expect(cleanIcsCandidates(['C:\\cal\\b.txt', 'C:\\cal\\c.ics'], existing)).toEqual(['C:\\cal\\c.ics'])
    expect(cleanIcsCandidates(['C:\\cal\\A.ICS'], existing)).toEqual([]) // 大小写不敏感去重
    const eleven = Array.from({ length: 11 }, (_, i) => `C:\\cal\\f${i}.ics`)
    expect(cleanIcsCandidates(eleven, [])).toHaveLength(10)
  })

  it('removePaths 按解析后的绝对路径移除（Windows 不分大小写）', () => {
    setCalendarConfig({ addPaths: ['C:\\cal\\a.ics', 'C:\\cal\\b.ics'] })
    const next = setCalendarConfig({ removePaths: ['c:\\cal\\A.ICS'] })
    expect(next.paths).toEqual(['C:\\cal\\b.ics'])
  })
})

describe('③ schema 校验与审批披露', () => {
  it('calendarConfigSchema 收 token 数组与 removePaths', () => {
    const ok = calendarConfigSchema.safeParse({ enabled: true, paths: [issuePathToken('C:\\cal\\a.ics')], removePaths: ['C:\\cal\\b.ics'] })
    expect(ok.success).toBe(true)
  })

  it('超长 token / 非字符串 / 超过 20 项被 schema 拒（真实 .ics 路径在 token 闸再拦一道）', () => {
    expect(calendarConfigSchema.safeParse({ paths: ['x'.repeat(65)] }).success).toBe(false)
    expect(calendarConfigSchema.safeParse({ paths: [123] }).success).toBe(false)
    const many = Array.from({ length: 21 }, () => 'tok')
    expect(calendarConfigSchema.safeParse({ paths: many }).success).toBe(false)
    // 注：裸绝对路径短于 65 字符时能过 schema 形状——但 resolveIcsPathTokens 那道闸才是权威（见 ①）
  })

  it('审批披露字段：将读取 N 个日历文件（只给文件名，不给目录）', () => {
    const p = buildCalendarApprovalPreview({ enabled: true, paths: ['C:\\cal\\a.ics', 'C:\\cal\\b.ics'] })
    expect(p.fields).toEqual([{ key: 'calendar_files', value: '2 个：a.ics、b.ics' }])
  })

  it('清单为空时明说「不会读取任何文件」，不摆空字段', () => {
    const p = buildCalendarApprovalPreview({ enabled: false, paths: [] })
    expect(p.fields[0]!.value).toContain('不会读取任何文件')
  })
})

// 钉住契约：AGENT_PICK_ICS_FILE 回包形状（token + fileName，不再有 path）
describe('IPC 常量与回包契约', () => {
  it('AGENT_PICK_ICS_FILE / AGENT_SET_CALENDAR_CONFIG 通道名不变（渲染层桩按此对齐）', () => {
    expect(IPC.AGENT_PICK_ICS_FILE).toBe('agent:pick-ics-file')
    expect(IPC.AGENT_SET_CALENDAR_CONFIG).toBe('agent:set-calendar-config')
  })
})
