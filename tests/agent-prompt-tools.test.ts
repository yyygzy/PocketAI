// 默认 Agent 提示词的工具清单注入契约（V4-Iter-97）
// 背景：原生 function calling 已经把整份工具清单作为 `tools` 字段发给模型，
// 系统提示词里再渲染一份文本等于每次调用多付一遍 schema（13 个内置工具实测 ≈1.5k token/次）。
// 本文件锁定三件事：
//  1) 默认提示词不再带文本清单（防止有人把 {{tools}} 加回去，静默翻倍计费）；
//  2) 自定义助手模板显式写 {{tools}} 时清单照常注入（用户主动要求的能力没被砍）；
//  3) 不支持 tools 字段的端点走文本协议，那份清单由 buildTextProtocolPrompt 独立补齐
//     （删掉文本份不会让兜底路径看不到工具）。
// engine.ts 顶层 import 重依赖，按 agent-context.test.ts 的既有做法整体打桩后再取常量。
// §232 起引擎会经 agent/tool-output-offload 拉进 portable（顶层算 APP_ROOT 要用 app.isPackaged）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))

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
  badArgsError: (argsJson: string, detail: string) => `[BAD_ARGS] ${detail} ${argsJson}`
}))
vi.mock('../src/main/tools/fs-tools', () => ({
  getWorkspaceDir: () => '',
  resolveWorkspacePath: (p: string) => p
}))
vi.mock('../src/main/tools/shell-tools', () => ({ findDangerRanges: () => [] }))
vi.mock('../src/main/assistant/skills', () => ({ buildSkillsContext: () => '' }))
vi.mock('../src/main/conversation/title-gen', () => ({ runFirstMessageTitle: () => {} }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: {} }))

import { DEFAULT_AGENT_PROMPT } from '../src/main/agent/engine'
import { renderPrompt } from '../src/main/assistant/prompt-template'
import { buildTextProtocolPrompt } from '../src/shared/text-tool-protocol'
import { toOpenAITools } from '../src/main/providers/openai-compatible'
import type { ToolSchema } from '../src/shared/types'

const TOOLS: ToolSchema[] = [
  {
    id: 'time_now',
    name: 'time_now',
    description: '获取当前日期与时间',
    parameters: { type: 'object', properties: { offset_days: { type: 'number' } } },
    source: 'builtin'
  },
  {
    id: 'weather_query',
    name: 'weather_query',
    description: '查询指定城市当前天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    source: 'builtin'
  }
]

// 真实 formatForPrompt 的产物形状（registry.ts 的渲染契约），用于验证「注入与否」
const TOOLS_TEXT =
  '## 可用工具\n' + TOOLS.map((t) => `### ${t.name}\n${t.description}`).join('\n')

describe('DEFAULT_AGENT_PROMPT 与工具清单注入', () => {
  it('默认提示词不带 {{tools}} 占位与「可用工具列表」标题', () => {
    expect(DEFAULT_AGENT_PROMPT).not.toContain('{{tools')
    expect(DEFAULT_AGENT_PROMPT).not.toContain('可用工具列表')
  })

  it('默认提示词的日期/知识/记忆占位与工具选择规则未受影响', () => {
    expect(DEFAULT_AGENT_PROMPT).toContain('{{date}}')
    expect(DEFAULT_AGENT_PROMPT).toContain('{{knowledge}}')
    expect(DEFAULT_AGENT_PROMPT).toContain('{{memory}}')
    // 选择规则仍按名字点名工具——删的是清单，不是「该用哪个工具」的指引
    expect(DEFAULT_AGENT_PROMPT).toContain('time_now')
  })

  it('即使调用方传了清单文本，默认提示词渲染结果里也不出现清单', () => {
    const rendered = renderPrompt(DEFAULT_AGENT_PROMPT, { tools: TOOLS_TEXT })
    expect(rendered).not.toContain('### weather_query')
    expect(rendered).not.toContain('## 可用工具')
  })

  it('自定义助手模板显式写 {{tools}} 时清单照常注入（opt-in 未破坏）', () => {
    const rendered = renderPrompt('你是一个助手。\n\n可用工具：\n{{tools}}', { tools: TOOLS_TEXT })
    expect(rendered).toContain('### weather_query')
    expect(rendered).toContain('查询指定城市当前天气')
  })

  it('文本协议兜底路径自带工具名与参数 schema（原生端点被拒时不丢信息）', () => {
    const prompt = buildTextProtocolPrompt(TOOLS)
    expect(prompt).toContain('### weather_query')
    expect(prompt).toContain(JSON.stringify(TOOLS[1]!.parameters))
  })

  it('原生通道逐个携带工具：清单只剩这一份', () => {
    const native = toOpenAITools(TOOLS) as Array<{ function: { name: string } }>
    expect(native.map((n) => n.function.name)).toEqual(['time_now', 'weather_query'])
  })
})
