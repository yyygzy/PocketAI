// @vitest-environment node
// 启动清扫 stale streaming 占位消息测试（缺陷：进程崩溃/被杀后 messages 表留下
// status='streaming' 的行，没有任何终态兜底，Chat 视图重载后永远渲染「输入中」）。
//
// 钉住的行为：
//  ① sweepStaleStreamingMessages() 把 streaming → error；
//  ② done/error 等正常终态不受影响；
//  ③ 时机约束：该方法只能由启动路径（boot 开库 / 解锁后开库）调用，
//     不得挂进 runMigrations（它运行期可被 IPC/备份恢复触发，会误杀活流）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-sweep-streaming'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'

function statusOf(id: string): string {
  const row = dbService.getHandle().prepare('SELECT status FROM messages WHERE id=?').get(id) as
    | { status: string }
    | undefined
  return row?.status ?? ''
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  const db = dbService.getHandle()
  db.prepare(
    "INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('c1','t','idle',1,1)"
  ).run()
  const ins = db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES (?,?,?,?,?,?)'
  )
  // 上次进程生命周期里没写完终态的占位
  ins.run('m-stream', 'c1', 'assistant', '半截回复', 'streaming', 2)
  ins.run('m-done', 'c1', 'assistant', '正常回复', 'done', 3)
  ins.run('m-user', 'c1', 'user', '提问', 'done', 1)
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('sweepStaleStreamingMessages — 启动一次性清扫中断的流式占位', () => {
  it('streaming 行被标记为 error', () => {
    dbService.sweepStaleStreamingMessages()
    expect(statusOf('m-stream')).toBe('error')
  })

  it('正常终态行不受影响', () => {
    expect(statusOf('m-done')).toBe('done')
    expect(statusOf('m-user')).toBe('done')
  })

  it('幂等：再扫一次无变化、不报错', () => {
    expect(() => dbService.sweepStaleStreamingMessages()).not.toThrow()
    expect(statusOf('m-stream')).toBe('error')
  })
})
