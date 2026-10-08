import { describe, it, expect } from 'vitest'
import {
  parseChatGptExport,
  parseClaudeJsonl,
  detectExternalFormat,
  MAX_EXTERNAL_CONTENT_CHARS,
  MAX_EXTERNAL_MESSAGES_PER_CONV
} from '../src/shared/conversation-import-external'

// ---------- 构造工具 ----------
interface CgNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: {
    author?: { role?: string }
    create_time?: number | null
    content?: { content_type?: string; parts?: unknown }
    metadata?: { model_slug?: string } | null
  } | null
}

function cgConv(mapping: Record<string, CgNode>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([{ title: 'T', create_time: 999, current_node: null, mapping, ...extra }])
}

function textNode(
  id: string,
  parent: string | null,
  role: 'user' | 'assistant',
  text: string,
  opts: { children?: string[]; createTime?: number | null; model?: string; contentType?: string; parts?: unknown } = {}
): Record<string, CgNode> {
  return {
    [id]: {
      id,
      parent,
      ...(opts.children ? { children: opts.children } : {}),
      message: {
        author: { role },
        ...(opts.createTime !== undefined ? { create_time: opts.createTime } : {}),
        content: {
          content_type: opts.contentType ?? 'text',
          parts: opts.parts ?? [text]
        },
        ...(opts.model ? { metadata: { model_slug: opts.model } } : {})
      }
    }
  }
}

// ---------- ChatGPT ----------
describe('parseChatGptExport', () => {
  it('current_node 回溯取主干：忽略编辑/重新生成的旁支', () => {
    // root → u1 → a1 → u2 → a2a(旧答案) / a2b(新答案，current)
    const mapping: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      ...textNode('u1', 'root', 'user', 'hi', { children: ['a1'], createTime: 1000 }),
      ...textNode('a1', 'u1', 'assistant', 'hello', { children: ['u2'], createTime: 1001, model: 'gpt-4o' }),
      ...textNode('u2', 'a1', 'user', 'q2', { children: ['a2a', 'a2b'], createTime: 1002 }),
      ...textNode('a2a', 'u2', 'assistant', 'old answer', { createTime: 1003 }),
      ...textNode('a2b', 'u2', 'assistant', 'new answer', { createTime: 1004 })
    }
    const r = parseChatGptExport(cgConv(mapping, { current_node: 'a2b' }))
    expect(r.conversations).toHaveLength(1)
    expect(r.conversations[0]!.messages.map((m) => m.content)).toEqual([
      'hi',
      'hello',
      'q2',
      'new answer'
    ])
  })

  it('无 current_node 时回退根节点沿 children[0] 下行', () => {
    const mapping: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      ...textNode('u1', 'root', 'user', 'ping', { children: ['a1'] }),
      ...textNode('a1', 'u1', 'assistant', 'pong')
    }
    const r = parseChatGptExport(cgConv(mapping))
    expect(r.conversations[0]!.messages.map((m) => m.content)).toEqual(['ping', 'pong'])
  })

  it('parent 环不致死循环（visited 终止）', () => {
    // A.parent=B, B.parent=A；current=A → 回溯 A,B 后撞环停止
    const mapping: Record<string, CgNode> = {
      ...textNode('A', 'B', 'user', 'aa'),
      ...textNode('B', 'A', 'assistant', 'bb')
    }
    const r = parseChatGptExport(cgConv(mapping, { current_node: 'A' }))
    expect(r.conversations[0]!.messages.map((m) => m.content).sort()).toEqual(['aa', 'bb'])
  })

  it('非文本 content_type 丢弃；parts 中的对象片段丢弃仅留字符串', () => {
    const mapping: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['m1', 'm2'], message: null },
      ...textNode('m1', 'root', 'user', 'image-msg', {
        children: ['m2'],
        contentType: 'multimodal_text',
        parts: [{ content_type: 'image_transcription', text: 'img' }, 'caption']
      }),
      ...textNode('m2', 'm1', 'user', 'mixed', {
        parts: ['plain', { type: 'image' }, 'tail']
      })
    }
    const r = parseChatGptExport(cgConv(mapping))
    // m1 非 text 类型整体丢弃；m2 仅取字符串片段
    expect(r.conversations[0]!.messages.map((m) => m.content)).toEqual(['plain\ntail'])
  })

  it('system/tool 角色丢弃，仅保留 user/assistant', () => {
    const mapping: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['s', 'u'], message: null },
      ...(textNode('s', 'root', 'assistant', 'sys', { children: ['u'] }) as Record<string, CgNode>)
    }
    // 手工塞 system 角色
    mapping.s!.message!.author!.role = 'system'
    Object.assign(mapping, textNode('u', 's', 'user', 'real'))
    const r = parseChatGptExport(cgConv(mapping))
    const msgs = r.conversations[0]!.messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toBe('real')
  })

  it('秒级 create_time 转毫秒；消息缺时间时用会话时间 + seq 保证唯一递增', () => {
    const mapping: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['u1', 'a1'], message: null },
      ...textNode('u1', 'root', 'user', 'a', { children: ['a1'], createTime: 1000 }),
      ...textNode('a1', 'u1', 'assistant', 'b', { createTime: null })
    }
    const r = parseChatGptExport(cgConv(mapping, { create_time: 999 }))
    const [m1, m2] = r.conversations[0]!.messages
    expect(m1!.createdAt).toBe(1_000_000) // 1000 秒 + seq 0
    expect(m2!.createdAt).toBe(999_001) // 会话 999 秒 + seq 1
  })

  it('缺标题用默认标题；无有效消息的会话计入 skipped', () => {
    const empty: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: [], message: null }
    }
    const good: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      ...textNode('u1', 'root', 'user', 'yo')
    }
    const r = parseChatGptExport(
      JSON.stringify([
        { mapping: empty },
        { title: '  ', create_time: 1, mapping: good },
        'not-an-object'
      ])
    )
    expect(r.conversations).toHaveLength(1)
    expect(r.conversations[0]!.title).toBe('ChatGPT 对话')
    expect(r.skippedConversationCount).toBe(2)
  })

  it('非法 JSON / 顶层非数组告警', () => {
    expect(parseChatGptExport('{bad').warnings[0]).toContain('JSON')
    expect(parseChatGptExport('{"x":1}').warnings[0]).toContain('数组')
  })

  it('单条内容超 100k 字符截断', () => {
    const mapping: Record<string, CgNode> = {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      ...textNode('u1', 'root', 'user', 'x'.repeat(MAX_EXTERNAL_CONTENT_CHARS + 1))
    }
    const r = parseChatGptExport(cgConv(mapping))
    expect(r.conversations[0]!.messages[0]!.content).toHaveLength(MAX_EXTERNAL_CONTENT_CHARS)
  })
})

// ---------- Claude JSONL ----------
describe('parseClaudeJsonl', () => {
  it('网页端：顶层 content 字符串 + ISO 时间 + model', () => {
    const text = [
      JSON.stringify({ type: 'user', content: '你好', timestamp: '2024-01-02T03:04:05.000Z' }),
      JSON.stringify({
        type: 'assistant',
        content: [{ type: 'text', text: '嗨' }, { type: 'thinking', thinking: '...' }],
        model: 'claude-3-opus'
      })
    ].join('\n')
    const r = parseClaudeJsonl(text, 'chat-export')
    expect(r.conversations).toHaveLength(1)
    const conv = r.conversations[0]!
    expect(conv.title).toBe('chat-export')
    expect(conv.source).toBe('claude')
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages[0]!.content).toBe('你好')
    expect(conv.messages[0]!.createdAt).toBe(Date.parse('2024-01-02T03:04:05.000Z'))
    expect(conv.messages[1]!.content).toBe('嗨') // thinking 块丢弃
    expect(conv.messages[1]!.model).toBe('claude-3-opus')
  })

  it('CLI：message.content 双嵌套 + 秒级时间戳', () => {
    const text = [
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'text', text: 'q' }],
          timestamp: 1_700_000_000
        }
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } })
    ].join('\n')
    const r = parseClaudeJsonl(text, 'cli')
    expect(r.conversations[0]!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'q'],
      ['assistant', 'a']
    ])
    expect(r.conversations[0]!.createdAt).toBe(1_700_000_000_000)
  })

  it('tool_result / isMeta / system / 坏行全部跳过不阻断', () => {
    const lines = [
      '{broken json',
      '',
      JSON.stringify({ type: 'system', content: 'sys' }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        content: [{ type: 'text', text: 'meta-ctrl' }]
      }),
      JSON.stringify({
        type: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'res' }] }]
      }),
      JSON.stringify({ type: 'assistant', content: 'real answer' })
    ]
    const r = parseClaudeJsonl(lines.join('\n'), 'f')
    expect(r.conversations[0]!.messages).toHaveLength(1)
    expect(r.conversations[0]!.messages[0]!.content).toBe('real answer')
  })

  it('混合块只取 text；图片块丢弃', () => {
    const row = {
      type: 'assistant',
      content: [
        { type: 'text', text: 'p1' },
        { type: 'image', source: {} },
        { type: 'text', text: 'p2' }
      ]
    }
    const r = parseClaudeJsonl(JSON.stringify(row), 'f')
    expect(r.conversations[0]!.messages[0]!.content).toBe('p1\np2')
  })

  it('无有效消息返回 skipped=1', () => {
    const r = parseClaudeJsonl('garbage\n\n', 'f')
    expect(r.conversations).toEqual([])
    expect(r.skippedConversationCount).toBe(1)
  })

  it('空文件名回退默认标题', () => {
    const r = parseClaudeJsonl(JSON.stringify({ type: 'user', content: 'x' }), '   ')
    expect(r.conversations[0]!.title).toBe('Claude 对话')
  })

  it('单条内容截断到 100k', () => {
    const row = JSON.stringify({ type: 'user', content: 'y'.repeat(MAX_EXTERNAL_CONTENT_CHARS + 5) })
    const r = parseClaudeJsonl(row, 'f')
    expect(r.conversations[0]!.messages[0]!.content).toHaveLength(MAX_EXTERNAL_CONTENT_CHARS)
  })

  it(`消息数达上限 ${MAX_EXTERNAL_MESSAGES_PER_CONV} 截断并告警`, () => {
    const lines: string[] = []
    for (let i = 0; i < MAX_EXTERNAL_MESSAGES_PER_CONV + 5; i++) {
      lines.push(JSON.stringify({ type: 'user', content: `m${i}` }))
    }
    const r = parseClaudeJsonl(lines.join('\n'), 'f')
    expect(r.conversations[0]!.messages).toHaveLength(MAX_EXTERNAL_MESSAGES_PER_CONV)
    expect(r.warnings.join('\n')).toContain('上限')
  })
})

// ---------- 格式探测 ----------
describe('detectExternalFormat', () => {
  it('ChatGPT 数组含 mapping', () => {
    expect(detectExternalFormat(JSON.stringify([{ title: 'x', mapping: {} }]))).toBe('chatgpt')
  })

  it('Claude JSONL（顶层对象起首也能识别）', () => {
    expect(detectExternalFormat('{"type":"user","content":"hi"}\n')).toBe('claude-jsonl')
  })

  it('前导非 JSON 行后在 20 行内出现 Claude 事件', () => {
    const prefixes = Array.from({ length: 5 }, (_, i) => `noise line ${i}`)
    const text = [...prefixes, JSON.stringify({ type: 'assistant', message: {} })].join('\n')
    expect(detectExternalFormat(text)).toBe('claude-jsonl')
  })

  it('JSON 数组但无 mapping → null', () => {
    expect(detectExternalFormat('[{"foo":1}]')).toBeNull()
  })

  it('无关文本 → null', () => {
    expect(detectExternalFormat('hello world\nplain text')).toBeNull()
  })
})
