// messageRepo.truncateFrom 截断重跑测试
//
// 用内存 SQLite 验证：删除目标消息及同会话其后全部消息（按 rowid 插入顺序），
// 不影响其他会话；目标不存在时返回 0 且不删任何行。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mem = new Database(':memory:')
mem.exec(`
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    created_at INTEGER NOT NULL
  )
`)

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => mem } }))

import { messageRepo } from '../src/main/db/repositories/message.repo'

function idsOf(conv: string): string[] {
  return (mem.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY rowid').all(conv) as { id: string }[]).map((r) => r.id)
}

beforeEach(() => {
  mem.prepare('DELETE FROM messages').run()
  // 两个会话交错插入，验证截断严格按会话隔离
  const ins = mem.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
  ins.run('c1u1', 'c1', 'user', 'q1', 1000)
  ins.run('c2u1', 'c2', 'user', 'qa', 1001)
  ins.run('c1a1', 'c1', 'assistant', 'a1', 1002)
  ins.run('c1u2', 'c1', 'user', 'q2', 1003)
  ins.run('c2a1', 'c2', 'assistant', 'aa', 1004)
  ins.run('c1a2', 'c1', 'assistant', 'a2', 1005)
})

describe('messageRepo.truncateFrom', () => {
  it('删除目标及其后同会话全部消息，按插入顺序而非时间判断', () => {
    const deleted = messageRepo.truncateFrom('c1u2')
    expect(deleted).toBe(2) // c1u2 + c1a2
    expect(idsOf('c1')).toEqual(['c1u1', 'c1a1'])
  })

  it('不影响其他会话的消息（含更早/更晚插入的行）', () => {
    messageRepo.truncateFrom('c1u1')
    expect(idsOf('c1')).toEqual([])
    expect(idsOf('c2')).toEqual(['c2u1', 'c2a1'])
  })

  it('目标不存在时返回 0，不删除任何行', () => {
    const deleted = messageRepo.truncateFrom('nope')
    expect(deleted).toBe(0)
    expect((mem.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(6)
  })

  it('截断会话最后一条消息只删该行', () => {
    const deleted = messageRepo.truncateFrom('c2a1')
    expect(deleted).toBe(1)
    expect(idsOf('c2')).toEqual(['c2u1'])
  })
})
