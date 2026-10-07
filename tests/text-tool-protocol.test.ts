// 小模型工具调用文本协议测试
//
// 覆盖 src/shared/text-tool-protocol.ts：
// - isToolsUnsupportedError：Ollama / LM Studio / vLLM 等端点报错文案匹配
// - extractTextToolCalls：围栏块 / 多块 / 坏 JSON / 宽松兜底 / 已知工具名约束
// - buildTextProtocolPrompt：协议说明与工具清单
import { describe, it, expect } from 'vitest'
import {
  isToolsUnsupportedError,
  extractTextToolCalls,
  buildTextProtocolPrompt
} from '../src/shared/text-tool-protocol'
import type { ToolSchema } from '../src/shared/types'

describe('isToolsUnsupportedError', () => {
  it('匹配 Ollama 文案', () => {
    expect(isToolsUnsupportedError('registry.ollama.ai/library/qwen2.5:0.5b does not support tools')).toBe(true)
  })

  it('匹配 LM Studio / vLLM 文案', () => {
    expect(isToolsUnsupportedError('This model does not support the tools parameter.')).toBe(true)
    expect(isToolsUnsupportedError('400 - tools are not supported by this model')).toBe(true)
  })

  it('匹配 not support tool 单数与 unsupported 前缀', () => {
    expect(isToolsUnsupportedError('model does not support tool calling')).toBe(true)
    expect(isToolsUnsupportedError('Error: unsupported feature: tools')).toBe(true)
  })

  it('普通错误与空串不误判', () => {
    expect(isToolsUnsupportedError('connection refused')).toBe(false)
    expect(isToolsUnsupportedError('')).toBe(false)
    expect(isToolsUnsupportedError('tool 死循环检测触发')).toBe(false)
  })
})

describe('extractTextToolCalls 围栏块', () => {
  it('标准单块：解析 name/arguments', () => {
    const text = '我先查一下时间。\n```tool_call\n{"name": "time_now", "arguments": {"tz": "Asia/Shanghai"}}\n```\n'
    const r = extractTextToolCalls(text)
    expect(r.hasBadBlock).toBe(false)
    expect(r.calls).toEqual([{ name: 'time_now', arguments: { tz: 'Asia/Shanghai' } }])
  })

  it('多个块按序解析', () => {
    const text = [
      '```tool_call',
      '{"name":"a","arguments":{"x":1}}',
      '```',
      '然后',
      '```tool_call',
      '{"name":"b","arguments":{}}',
      '```'
    ].join('\n')
    const r = extractTextToolCalls(text)
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('围栏内 JSON 非法 → hasBadBlock 且无 calls', () => {
    const r = extractTextToolCalls('```tool_call\n{"name": a,}\n```')
    expect(r.calls).toEqual([])
    expect(r.hasBadBlock).toBe(true)
  })

  it('围栏内缺 name 字段 → hasBadBlock', () => {
    const r = extractTextToolCalls('```tool_call\n{"arguments": {}}\n```')
    expect(r.hasBadBlock).toBe(true)
  })

  it('arguments 非对象时容错为空对象', () => {
    const r = extractTextToolCalls('```tool_call\n{"name":"calc","arguments":"1+1"}\n```')
    expect(r.calls).toEqual([{ name: 'calc', arguments: {} }])
    expect(r.hasBadBlock).toBe(false)
  })

  it('纯文本无围栏 → 无调用无坏块', () => {
    const r = extractTextToolCalls('今天是晴天。')
    expect(r.calls).toEqual([])
    expect(r.hasBadBlock).toBe(false)
  })
})

describe('extractTextToolCalls 宽松兜底', () => {
  it('无围栏但整段是含 name+arguments 的 JSON 且命中已知工具 → 视为调用', () => {
    const raw = '{"name":"time_now","arguments":{}}'
    const r = extractTextToolCalls(raw, new Set(['time_now', 'web_fetch']))
    expect(r.calls).toEqual([{ name: 'time_now', arguments: {} }])
  })

  it('宽松兜底 name 不在已知清单 → 不视为调用', () => {
    const raw = '{"name":"unknown_tool","arguments":{}}'
    const r = extractTextToolCalls(raw, new Set(['time_now']))
    expect(r.calls).toEqual([])
    expect(r.hasBadBlock).toBe(false)
  })

  it('无已知清单时宽松兜底直接放行', () => {
    const raw = '{"name":"anything","arguments":{"k":1}}'
    const r = extractTextToolCalls(raw)
    expect(r.calls.length).toBe(1)
  })

  it('回答文本中恰好含 JSON 但不满足 name+arguments → 不误判', () => {
    const r = extractTextToolCalls('结果如下：{"status": "ok", "data": [1,2]}')
    expect(r.calls).toEqual([])
  })
})

describe('buildTextProtocolPrompt', () => {
  const tools: ToolSchema[] = [
    {
      id: 'mcp:1:fs_read',
      name: 'fs_read',
      description: '读取文件内容',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      source: 'mcp',
      mcpServerId: '1'
    }
  ]

  it('包含协议格式说明、工具名与参数 schema', () => {
    const prompt = buildTextProtocolPrompt(tools)
    expect(prompt).toContain('tool_call')
    expect(prompt).toContain('"name"')
    expect(prompt).toContain('### fs_read')
    expect(prompt).toContain('读取文件内容')
    expect(prompt).toContain(JSON.stringify(tools[0]!.parameters))
  })

  it('空工具清单也不抛错', () => {
    expect(() => buildTextProtocolPrompt([])).not.toThrow()
  })
})
