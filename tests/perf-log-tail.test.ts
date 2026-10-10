// 日志尾部读取：跨会话慢事件统计的唯一数据来源（只读，不碰真实 data/）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureLogDir, readLogTail } from '../src/main/logger'

let dir: string

function writeLog(name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf8')
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-log-tail-'))
})

afterAll(() => {
  // 复原到不可写目录，避免后续用例误读临时日志
  configureLogDir(path.join(dir, 'gone'))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('readLogTail', () => {
  it('先 old 后 current，按时间先后拼接', () => {
    writeLog('main.old.log', '2026-10-09 08:00:00 INFO  [perf] [perf] kb.ingest: 100ms\n')
    writeLog('main.log', '2026-10-10 08:00:00 INFO  [perf] [perf] kb.retrieve: 200ms\n')
    configureLogDir(dir)
    const lines = readLogTail()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('kb.ingest')
    expect(lines[1]).toContain('kb.retrieve')
  })

  it('从尾部截取时丢弃首行（半行不是完整事件）', () => {
    writeLog('main.old.log', '')
    writeLog('main.log', `AAAAAAAA 2026-10-01 08:00:00 INFO  [x] padding\n2026-10-10 08:00:00 INFO  [perf] [perf] kb.ingest: 1ms\n`)
    configureLogDir(dir)
    const keepLast = 70
    const lines = readLogTail(keepLast)
    expect(lines.every((l) => /^\d{4}-\d{2}-\d{2}/.test(l))).toBe(true)
    expect(lines.some((l) => l.includes('AAAA'))).toBe(false)
    expect(lines.some((l) => l.includes('kb.ingest'))).toBe(true)
  })

  it('超限上限被夹住，绝不把整块日志读进内存', () => {
    writeLog('main.log', 'x'.repeat(2 * 1024 * 1024))
    configureLogDir(dir)
    const lines = readLogTail(10 * 1024 * 1024)
    expect(lines.join('').length).toBeLessThanOrEqual(256 * 1024)
  })

  it('日志文件不存在 / 目录不可用时返回空数组，不抛错', () => {
    configureLogDir(path.join(dir, 'missing-dir'))
    expect(readLogTail()).toEqual([])
  })

  it('空文件与只有空行都不产出内容', () => {
    writeLog('main.old.log', '')
    writeLog('main.log', '\n\n   \n')
    configureLogDir(dir)
    expect(readLogTail()).toEqual([])
  })
})
