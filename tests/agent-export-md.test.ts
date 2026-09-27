// Agent 消息 → Markdown 序列化测试
import { describe, it, expect } from 'vitest'
import { agentMessagesToMarkdown, type AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'

function user(id: string, text: string, extras: Partial<AgentMessage> = {}): AgentMessage {
  return { id, role: 'user', text, ...extras }
}
function assistant(id: string, text: string, extras: Partial<AgentMessage> = {}): AgentMessage {
  return { id, role: 'assistant', text, ...extras }
}
function tool(id: string, extras: Partial<AgentMessage> = {}): AgentMessage {
  return { id, role: 'tool', text: '', ...extras }
}

describe('agentMessagesToMarkdown', () => {
  it('只有标题（空消息）', () => {
    expect(agentMessagesToMarkdown([], '测试')).toBe('# 测试\n')
  })

  it('用户/助手消息带角色标题与分隔线', () => {
    const md = agentMessagesToMarkdown(
      [user('u1', '你好'), assistant('a1', '你好，有什么可以帮你？')],
      '标题'
    )
    expect(md).toContain('# 标题')
    expect(md).toContain('## 👤 用户')
    expect(md).toContain('你好')
    expect(md).toContain('## 🤖 助手')
    expect(md).toContain('你好，有什么可以帮你？')
    // 两条消息两段分隔
    expect(md.match(/---/g)).toHaveLength(2)
  })

  it('流式占位空助手卡被跳过', () => {
    const md = agentMessagesToMarkdown([assistant('a0', '')], '标题')
    expect(md).not.toContain('## 🤖 助手')
    expect(md).toBe('# 标题\n')
  })

  it('工具卡输出工具名/参数/结果，参数 JSON 美化', () => {
    const md = agentMessagesToMarkdown(
      [
        tool('t1', {
          toolResult: {
            toolCallId: 'c1',
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
            content: 'file body'
          }
        })
      ],
      '标题'
    )
    expect(md).toContain('## 🔧 工具：read_file')
    expect(md).toContain('```json')
    expect(md).toContain('"path": "a.txt"')
    expect(md).toContain('file body')
  })

  it('工具参数非法 JSON 原样保留', () => {
    const md = agentMessagesToMarkdown(
      [tool('t1', { toolResult: { toolCallId: 'c1', name: 'x', arguments: 'not-json', content: 'r' } })],
      '标题'
    )
    expect(md).toContain('not-json')
  })

  it('工具错误结果带错误标记', () => {
    const md = agentMessagesToMarkdown(
      [tool('t1', { toolResult: { toolCallId: 'c1', name: 'x', content: 'boom', isError: true } })],
      '标题'
    )
    expect(md).toContain('结果（错误）')
    expect(md).toContain('boom')
  })

  it('无 toolResult 时回退用 toolCall 的名称与参数', () => {
    const md = agentMessagesToMarkdown(
      [tool('t1', { toolCall: { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } } })],
      '标题'
    )
    expect(md).toContain('## 🔧 工具：shell')
  })

  it('附件以列表列出，图片标注', () => {
    const md = agentMessagesToMarkdown(
      [
        user('u1', '看图', {
          attachments: [
            { type: 'image', name: 'a.png', mimeType: 'image/png', size: 1, data: 'x' },
            { type: 'text', name: 'b.txt', mimeType: 'text/plain', size: 1, data: 'y' }
          ]
        })
      ],
      '标题'
    )
    expect(md).toContain('📎 a.png（图片）')
    expect(md).toContain('📎 b.txt')
  })

  it('失败的助手卡带失败提示', () => {
    const md = agentMessagesToMarkdown([assistant('a1', '出错了', { isError: true })], '标题')
    expect(md).toContain('⚠️')
  })

  it('正文首尾空白被裁剪', () => {
    const md = agentMessagesToMarkdown([user('u1', '  hi  ')], '标题')
    expect(md).toContain('\nhi\n')
  })
})
