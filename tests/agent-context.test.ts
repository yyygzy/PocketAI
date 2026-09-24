// Agent 引擎纯函数测试（上下文重建 / 附件注入 / 工具结果压缩 / 死循环签名 / 历史摘要）
//
// 覆盖 src/main/agent/engine.ts 的导出纯函数：
// - buildContext：DB 历史 → LLM 上下文（P0 回归：工具轮后的 assistant 最终回答必须进上下文；
//   中止/出错残留的悬空 tool_calls 必须剥离，避免严格 OpenAI 兼容端 400）
// - injectAttachments：文本/图片附件注入
// - compressToolResult：工具结果智能压缩
// - computeToolSignature：工具调用签名（排序无关性）
// - buildHistorySummary：规则摘要
//
// 策略：engine.ts 顶层 import 重依赖（providerManager/dbService/ragService/toolRegistry 等），
// 全部 mock 掉避免模块加载初始化；被测函数本身均为纯函数。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => ({ streamChat: async () => ({ content: '' }) }) }
}))
vi.mock('../src/main/knowledge/rag', () => ({
  ragService: { retrieve: async () => ({ chunks: [] }), buildContext: () => '' }
}))
vi.mock('../src/main/tools/registry', () => ({
  toolRegistry: {
    filterByPermissions: () => [],
    formatForPrompt: () => '',
    classify: () => ({ decision: 'deny', reason: 'UNKNOWN_TOOL' }),
    execute: async () => ({ toolCallId: '', name: '', content: '', isError: true }),
    getSchema: () => undefined
  },
  // badArgsError 为纯字符串函数，与 src/main/tools/registry.ts 实现保持一致；
  // 此处锁定 [BAD_ARGS] 前缀契约（engine 的修正引导检测依赖该前缀）。
  badArgsError: (argsJson: string, detail: string) => {
    const raw = argsJson ? argsJson.slice(0, 200) : '(空)'
    return `[BAD_ARGS] 参数 JSON 解析失败：${detail}\n原始参数：${raw}\n请修正 JSON 格式（确保引号、逗号、括号正确）后重新调用该工具，不要使用相同的错误参数。`
  }
}))
vi.mock('../src/main/tools/fs-tools', () => ({
  getWorkspaceDir: () => '',
  resolveWorkspacePath: (p: string) => p
}))
vi.mock('../src/main/assistant/skills', () => ({ buildSkillsContext: () => '' }))

import type { MessageRecord, ChatAttachment, ToolCall, ToolResult } from '../src/shared/types'
import type { AdapterChatMessage } from '../src/main/providers/types'
import {
  buildContext,
  compressToolResult,
  computeToolSignature,
  buildHistorySummary,
  shouldSkipPlanning,
  estimateTokens,
  cutToTokens
} from '../src/main/agent/engine'
import {
  injectAttachments,
  appendTextAttachments,
  buildImageParts
} from '../src/main/chat/context-attachments'
import { badArgsError } from '../src/main/tools/registry'

let seq = 0
function msg(partial: Partial<MessageRecord> & { role: MessageRecord['role']; content: string }): MessageRecord {
  seq++
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    provider: null,
    model: null,
    parentId: null,
    createdAt: seq,
    status: 'done',
    ...partial
  }
}

function toolMsg(toolCallId: string, name: string, content = '工具结果'): MessageRecord {
  const tr: ToolResult = { toolCallId, name, content, isError: false }
  return msg({ role: 'tool', content: JSON.stringify(tr) })
}

function toolCalls(id: string, name = 'web_search', args = '{"q":"test"}'): string {
  const calls: ToolCall[] = [{ id, type: 'function', function: { name, arguments: args } }]
  return JSON.stringify(calls)
}

describe('buildContext — 工具轮 assistant 消息还原（P0 回归）', () => {
  it('单轮多步 Agent：tool 之后的最终回答进上下文，不再被跳过', () => {
    const history = [
      msg({ role: 'user', content: '帮我查X' }),
      msg({ role: 'assistant', content: '', toolCalls: toolCalls('tc1') }),
      toolMsg('tc1', 'web_search', '搜索结果...'),
      msg({ role: 'assistant', content: 'X 的查询结果是...' })
    ]
    const out = buildContext(history)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(out[3]!.content).toBe('X 的查询结果是...')
  })

  it('两轮 Agent 对话：第二轮上下文包含第一轮完整问答，角色交替合法', () => {
    const history = [
      msg({ role: 'user', content: '第一问' }),
      msg({ role: 'assistant', content: '', toolCalls: toolCalls('tc1') }),
      toolMsg('tc1', 'web_search'),
      msg({ role: 'assistant', content: '第一答' }),
      msg({ role: 'user', content: '第二问' })
    ]
    const out = buildContext(history)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    // tool 消息后必须紧跟 assistant，不能直接跟 user（严格 API 校验）
    expect(out[2]!.role === 'tool' && out[3]!.role === 'assistant').toBe(true)
  })
})

describe('buildContext — 悬空 tool_calls 剥离', () => {
  it('部分 tool_call 有结果：仅保留已应答的调用', () => {
    const calls: ToolCall[] = [
      { id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"q":"a"}' } },
      { id: 'tc2', type: 'function', function: { name: 'calculator', arguments: '1+1' } }
    ]
    const history = [
      msg({ role: 'user', content: '问' }),
      msg({ role: 'assistant', content: '', toolCalls: JSON.stringify(calls) }),
      toolMsg('tc1', 'web_search'),
      msg({ role: 'assistant', content: '答' })
    ]
    const out = buildContext(history)
    const asst = out[1]!
    expect(asst.tool_calls).toHaveLength(1)
    expect(asst.tool_calls![0]!.id).toBe('tc1')
  })

  it('tool_calls 全部无结果（中止残留）：整体剥离，消息降级为纯文本 assistant', () => {
    const history = [
      msg({ role: 'user', content: '问' }),
      msg({ role: 'assistant', content: '部分思考', toolCalls: toolCalls('tc9') }),
      msg({ role: 'user', content: '下一问' })
    ]
    const out = buildContext(history)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[1]!.tool_calls).toBeUndefined()
    expect(out[1]!.content).toBe('部分思考')
  })

  it('tool 结果消息存在但 toolCallId 不匹配：对应调用被剥离', () => {
    const history = [
      msg({ role: 'user', content: '问' }),
      msg({ role: 'assistant', content: '', toolCalls: toolCalls('tcA') }),
      toolMsg('tcB', 'web_search')
    ]
    const out = buildContext(history)
    expect(out[1]!.tool_calls).toBeUndefined()
  })
})

describe('buildContext — 基础行为', () => {
  it('systemPrompt 非空时插入 system 消息，空串/空白不插入', () => {
    const history = [msg({ role: 'user', content: '你好' })]
    expect(buildContext(history, 'sys')[0]!.role).toBe('system')
    expect(buildContext(history, '  ')[0]!.role).toBe('user')
    expect(buildContext(history)[0]!.role).toBe('user')
  })

  it('status 非 done 的消息被跳过', () => {
    const history = [
      msg({ role: 'user', content: '问' }),
      msg({ role: 'assistant', content: '流式中', status: 'streaming' as MessageRecord['status'] }),
      msg({ role: 'assistant', content: '失败', status: 'error' as MessageRecord['status'] })
    ]
    const out = buildContext(history)
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('问')
  })

  it('tool 消息找不到匹配的 assistant.tool_calls 时跳过（避免 API 报错）', () => {
    const history = [
      msg({ role: 'user', content: '问' }),
      msg({ role: 'assistant', content: '直接回答' }),
      toolMsg('tcX', 'web_search'),
      msg({ role: 'user', content: '再问' })
    ]
    const out = buildContext(history)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('仅最后一条带图 user 消息携带 base64，更早的图片用占位符', () => {
    const img = (name: string): ChatAttachment => ({ type: 'image', name, data: `data:image/png;base64,${name}`, mimeType: 'image/png', size: 100 })
    const history = [
      msg({ role: 'user', content: '看图1', attachments: [img('old')] }),
      msg({ role: 'assistant', content: '图1描述' }),
      msg({ role: 'user', content: '看图2', attachments: [img('new')] })
    ]
    const out = buildContext(history)
    const early = out[0]!
    const latest = out[2]!
    expect(typeof early.content).toBe('string')
    expect(String(early.content)).toContain('[图片: old]')
    expect(Array.isArray(latest.content)).toBe(true)
    const parts = latest.content as Array<{ type: string }>
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
  })
})

describe('injectAttachments', () => {
  it('文本附件追加到最后一条 user 消息', () => {
    const messages: AdapterChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: '问题' }
    ]
    const atts: ChatAttachment[] = [{ type: 'text', name: 'a.txt', data: '附件内容', mimeType: 'text/plain', size: 12 }]
    injectAttachments(messages, atts)
    expect(messages[1]!.content).toContain('问题')
    expect(messages[1]!.content).toContain('--- a.txt ---')
    expect(messages[1]!.content).toContain('附件内容')
  })

  it('图片附件构建 multimodal content', () => {
    const messages: AdapterChatMessage[] = [{ role: 'user', content: '看图' }]
    const atts: ChatAttachment[] = [{ type: 'image', name: 'p.png', data: 'data:image/png;base64,xxx', mimeType: 'image/png', size: 100 }]
    injectAttachments(messages, atts)
    const parts = messages[0]!.content as Array<{ type: string }>
    expect(Array.isArray(parts)).toBe(true)
    expect(parts[0]!.type).toBe('text')
    expect(parts[1]!.type).toBe('image_url')
  })

  it('无附件时不动消息', () => {
    const messages: AdapterChatMessage[] = [{ role: 'user', content: '原样' }]
    injectAttachments(messages, undefined)
    expect(messages[0]!.content).toBe('原样')
  })
})

describe('appendTextAttachments — 文本附件拼接（收口层）', () => {
  it('空附件返回原文', () => {
    expect(appendTextAttachments('原文', [])).toBe('原文')
  })

  it('多附件按顺序拼接为 --- name --- 区块', () => {
    const atts: ChatAttachment[] = [
      { type: 'text', name: 'a.txt', data: '内容A', mimeType: 'text/plain', size: 3 },
      { type: 'text', name: 'b.md', data: '内容B', mimeType: 'text/markdown', size: 3 }
    ]
    const out = appendTextAttachments('原文', atts)
    expect(out).toBe('原文\n\n--- a.txt ---\n内容A\n\n--- b.md ---\n内容B')
  })
})

describe('buildImageParts — 图片 multimodal parts（收口层）', () => {
  it('text 在前，图片映射为 image_url', () => {
    const atts: ChatAttachment[] = [
      { type: 'image', name: 'p1.png', data: 'data:image/png;base64,1', mimeType: 'image/png', size: 1 },
      { type: 'image', name: 'p2.png', data: 'data:image/png;base64,2', mimeType: 'image/png', size: 1 }
    ]
    const parts = buildImageParts('看图', atts)
    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ type: 'text', text: '看图' })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,1' } })
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,2' } })
  })
})

describe('badArgsError — BAD_ARGS 富文本收口', () => {
  it('[BAD_ARGS] 前缀 + 原始参数 + 修正引导', () => {
    const out = badArgsError('{"q":"x"', 'Unexpected end')
    expect(out.startsWith('[BAD_ARGS]')).toBe(true)
    expect(out).toContain('参数 JSON 解析失败：Unexpected end')
    expect(out).toContain('原始参数：{"q":"x"')
    expect(out).toContain('不要使用相同的错误参数')
  })

  it('空参数显示 (空)；超长参数截断到 200 字符', () => {
    expect(badArgsError('', 'err')).toContain('原始参数：(空)')
    const long = 'x'.repeat(300)
    const out = badArgsError(long, 'err')
    expect(out).toContain('原始参数：' + 'x'.repeat(200))
    expect(out).not.toContain('x'.repeat(201))
  })
})

describe('shouldSkipPlanning — 规划跳过启发式', () => {
  it('无可用工具：无论输入长短都跳过（规划无意义）', () => {
    expect(shouldSkipPlanning('帮我分析这份财报数据并给出详细建议', 0)).toBe(true)
    expect(shouldSkipPlanning('你好', 0)).toBe(true)
  })

  it('有工具 + 短单行输入：跳过（问候/闲聊/一句话问答）', () => {
    expect(shouldSkipPlanning('你好', 3)).toBe(true)
    expect(shouldSkipPlanning('今天天气怎么样？', 3)).toBe(true)
  })

  it('有工具 + 短多行输入：不跳过（可能是贴了代码/多行任务）', () => {
    expect(shouldSkipPlanning('看下这段代码\nfor(;;){}', 3)).toBe(false)
  })

  it('有工具 + 长输入：不跳过', () => {
    const long = '帮我分析下面的销售数据，按地区汇总，找出增长最快的三类产品，并给出下季度备货建议'
    expect(long.length).toBeGreaterThanOrEqual(30)
    expect(shouldSkipPlanning(long, 3)).toBe(false)
  })

  it('边界：trim 后 29 字符跳过，30 字符不跳过', () => {
    expect(shouldSkipPlanning('  ' + 'a'.repeat(29) + '  ', 3)).toBe(true)
    expect(shouldSkipPlanning('a'.repeat(30), 3)).toBe(false)
  })
})

describe('compressToolResult', () => {
  it('不超长时原样返回', () => {
    expect(compressToolResult('short', 100)).toBe('short')
  })

  it('JSON 数组超长：保留前 3 项 + 总数提示', () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}-padding` }))
    const out = compressToolResult(JSON.stringify(arr), 500)
    expect(out).toContain('数组共 50 项')
    expect(out).toContain('item-0')
    expect(out).not.toContain('item-49')
  })

  it('JSON 对象超长：保留字段摘要 + 截断正文', () => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < 30; i++) obj[`field${i}`] = `value-${i}-` + 'x'.repeat(50)
    const out = compressToolResult(JSON.stringify(obj), 400)
    expect(out).toContain('30 个字段')
  })

  it('纯文本超长：保留首段 + 末段 + 省略提示', () => {
    const text = 'A'.repeat(600) + 'B'.repeat(600)
    const out = compressToolResult(text, 500)
    expect(out).toContain('中间已省略')
    expect(out.startsWith('A')).toBe(true)
    expect(out.endsWith('B')).toBe(true)
  })
})

describe('computeToolSignature', () => {
  const tc = (id: string, name: string, args: string): ToolCall => ({
    id, type: 'function', function: { name, arguments: args }
  })

  it('相同调用集合不同顺序 → 相同签名', () => {
    const a = [tc('1', 'web_search', '{"q":"a"}'), tc('2', 'calculator', '1+1')]
    const b = [tc('3', 'calculator', '1+1'), tc('4', 'web_search', '{"q":"a"}')]
    expect(computeToolSignature(a)).toBe(computeToolSignature(b))
  })

  it('参数不同 → 签名不同', () => {
    const a = [tc('1', 'web_search', '{"q":"a"}')]
    const b = [tc('1', 'web_search', '{"q":"b"}')]
    expect(computeToolSignature(a)).not.toBe(computeToolSignature(b))
  })
})

describe('buildHistorySummary', () => {
  it('按角色生成摘要行，非 done 消息跳过', () => {
    const history = [
      msg({ role: 'user', content: '用户的问题' }),
      msg({ role: 'assistant', content: '助手的回答', status: 'streaming' as MessageRecord['status'] }),
      msg({ role: 'assistant', content: '助手的最终回答' })
    ]
    const summary = buildHistorySummary(history)
    expect(summary).toContain('用户: 用户的问题')
    expect(summary).toContain('助手: 助手的最终回答')
    expect(summary).not.toContain('流式中')
  })

  it('工具结果以 工具[名] 格式呈现', () => {
    const history = [
      toolMsg('tc1', 'web_search', '搜索到的内容')
    ]
    const summary = buildHistorySummary(history)
    expect(summary).toContain('工具[web_search]: 搜索到的内容')
  })
})

describe('estimateTokens — CJK-aware token 估算', () => {
  it('空串为 0；CJK ≈ 1 token/字', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('汉'.repeat(20))).toBe(20)
  })

  it('拉丁/数字/符号 ≈ 4 字符/token（向上取整）', () => {
    expect(estimateTokens('abcdefgh')).toBe(2) // 8/4
    expect(estimateTokens('abcde')).toBe(2) // 5/4 → ceil 2
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  it('混合文本按类别分别计数', () => {
    // 4 CJK + 8 latin = 4 + 2 = 6
    expect(estimateTokens('你好世界abcdefgh')).toBe(6)
  })
})

describe('cutToTokens — token 预算截断', () => {
  it('预算内原样返回（不追加省略号）', () => {
    expect(cutToTokens('你好', 10)).toBe('你好')
    expect(cutToTokens('short', 5)).toBe('short')
    expect(cutToTokens('', 5)).toBe('')
  })

  it('超预算截断并追加省略号，结果不超预算', () => {
    const out = cutToTokens('一二三四五六七八九十', 6)
    expect(out.endsWith('…')).toBe(true)
    expect(estimateTokens(out)).toBeLessThanOrEqual(6)
  })

  it('中文按字数截断：20 汉字预算 10 → 保留 9 字 + …', () => {
    expect(cutToTokens('汉'.repeat(20), 10)).toBe('汉'.repeat(9) + '…')
  })

  it('预算单调性：预算越大结果不减', () => {
    const text = 'a'.repeat(100)
    let prevLen = 0
    for (const budget of [2, 4, 8, 16, 32]) {
      const out = cutToTokens(text, budget)
      expect(out.length).toBeGreaterThanOrEqual(prevLen)
      expect(estimateTokens(out)).toBeLessThanOrEqual(budget)
      prevLen = out.length
    }
  })

  it('边界：预算 0 返回空串；预算 1 只剩省略号', () => {
    expect(cutToTokens('abc', 0)).toBe('')
    expect(cutToTokens('你好', 1)).toBe('…')
  })
})
