// 真文件端到端：calendar_read 对超大 .ics 的「跳过并报告」（B10 / SEC-28）
//
// 已有的 calendar-ics.test.ts 把 fs 整个桩掉测 `readIcsContent` 抛错——那证的是"闸门函数"，
// 没证"工具真的把这条错误聚合进 readErrors 并照常返回其余日历"。B10 那行验收要看的就是后者。
// 这里不桩 fs：临时目录里真写一个 9MB 的 .ics 和一个正常 .ics，调真 execute()。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const store = vi.hoisted(() => ({ current: {} as Record<string, string> }))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => store.current[k] ?? null,
    set: (k: string, v: string) => {
      store.current[k] = v
    },
    delete: (k: string) => {
      delete store.current[k]
    }
  }
}))

import { calendarReadTool } from '../src/main/tools/calendar-ics'

const base = process.env.TEMP || process.env.TMP || '/tmp'
const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
const DIR = base + sep + 'pocketai-calendar-ics-size'
const OK_FILE = path.join(DIR, 'ok.ics')
const BIG_FILE = path.join(DIR, 'big.ics')

// 一个不带日期的最小 VEVENT：range=all 时必然命中，避免用例依赖系统时间
const OK_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:1@probe',
  'DTSTART:20260101T090000Z',
  'SUMMARY:探针事件',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

function usePaths(paths: string[]): void {
  store.current = {
    'agent.calendar_enabled': '1',
    'agent.calendar_ics_paths': JSON.stringify(paths)
  }
}

beforeAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(OK_FILE, OK_ICS)
  // 9MB > 8MB 上限；内容是不是合法 ICS 无关紧要——闸门在读取之前就应拦下
  fs.writeFileSync(BIG_FILE, Buffer.alloc(9 * 1024 * 1024, 0x41))
})

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('calendar_read 的 8MB 闸（真文件）', () => {
  it('超大文件被跳过并计入 readErrors，其余日历照常返回', async () => {
    usePaths([OK_FILE, BIG_FILE])
    const res = JSON.parse(await calendarReadTool.execute({ range: 'all' }, {} as never)) as {
      count: number
      events: Array<{ summary: string }>
      readErrors?: string[]
    }
    expect(res.count).toBe(1)
    expect(res.events[0]?.summary).toBe('探针事件')
    expect(res.readErrors).toHaveLength(1)
    expect(res.readErrors![0]).toContain(BIG_FILE)
    expect(res.readErrors![0]).toMatch(/超过 8MB 上限，已跳过/)
  })

  it('反向对照：只有正常日历时不应出现 readErrors（上一条不是恒真）', async () => {
    usePaths([OK_FILE])
    const res = JSON.parse(await calendarReadTool.execute({ range: 'all' }, {} as never)) as {
      count: number
      readErrors?: string[]
    }
    expect(res.count).toBe(1)
    expect(res.readErrors).toBeUndefined()
  })

  it('路径不存在也只报错，不整批失败', async () => {
    usePaths([OK_FILE, path.join(DIR, 'missing.ics')])
    const res = JSON.parse(await calendarReadTool.execute({ range: 'all' }, {} as never)) as {
      count: number
      readErrors?: string[]
    }
    expect(res.count).toBe(1)
    expect(res.readErrors).toHaveLength(1)
  })
})
