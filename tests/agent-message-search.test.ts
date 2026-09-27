// 会话内消息搜索纯函数测试
import { describe, it, expect } from 'vitest'
import { searchAgentMessages, type AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'

function user(id: string, text: string): AgentMessage {
  return { id, role: 'user', text }
}
function assistant(id: string, text: string): AgentMessage {
  return { id, role: 'assistant', text }
}
function tool(id: string, name: string, content: string): AgentMessage {
  return {
    id,
    role: 'tool',
    text: '',
    toolResult: { toolCallId: id + '-c', name, content }
  }
}

const msgs: AgentMessage[] = [
  user('u1', '帮我总结一下项目结构'),
  assistant('a1', '项目包含 src 和 tests 两个目录'),
  tool('t1', 'read_file', 'package.json contents here'),
  assistant('a2', 'README 里也有结构说明')
]

describe('searchAgentMessages', () => {
  it('空查询返回空数组', () => {
    expect(searchAgentMessages(msgs, '')).toEqual([])
    expect(searchAgentMessages(msgs, '   ')).toEqual([])
  })

  it('空消息列表返回空数组', () => {
    expect(searchAgentMessages([], 'x')).toEqual([])
  })

  it('大小写不敏感', () => {
    expect(searchAgentMessages(msgs, 'README').map((h) => h.id)).toEqual(['a2'])
    expect(searchAgentMessages(msgs, 'readme').map((h) => h.id)).toEqual(['a2'])
  })

  it('子串匹配，按时间顺序返回并带正确 index', () => {
    const hits = searchAgentMessages(msgs, '结构')
    expect(hits.map((h) => h.id)).toEqual(['u1', 'a2'])
    expect(hits[0]?.index).toBe(0)
    expect(hits[1]?.index).toBe(3)
  })

  it('命中角色正确', () => {
    const h = searchAgentMessages(msgs, '总结')
    expect(h[0]?.role).toBe('user')
  })

  it('工具卡可按工具名/输出内容命中', () => {
    expect(searchAgentMessages(msgs, 'read_file').map((h) => h.id)).toEqual(['t1'])
    expect(searchAgentMessages(msgs, 'package.json').map((h) => h.id)).toEqual(['t1'])
  })

  it('无命中返回空数组', () => {
    expect(searchAgentMessages(msgs, '不存在的关键词xyz')).toEqual([])
  })

  it('查询首尾空白被裁剪', () => {
    expect(searchAgentMessages(msgs, '  README ').map((h) => h.id)).toEqual(['a2'])
  })
})
