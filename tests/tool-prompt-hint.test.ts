// @vitest-environment node
// 本轮可用工具提示（v78 第 4 批）
//
// 目的：提示词里的工具清单必须与**本次请求真正下发的 tools** 同一份事实，
// 否则模型会照着静态提示去调一个不在请求里的工具，最后得到"工具不存在"。
import { describe, expect, it } from 'vitest'
import { buildAvailableToolsHint } from '../src/main/agent/tool-prompt-hint'
import type { ToolSchema } from '../src/shared/types'

function tool(name: string, description: string): ToolSchema {
  return {
    id: name,
    name,
    description,
    parameters: { type: 'object', properties: {} },
    source: 'builtin',
    permission: 'auto'
  }
}

describe('buildAvailableToolsHint', () => {
  it('没有工具 → 空串（调用方不追加）', () => {
    expect(buildAvailableToolsHint([])).toBe('')
  })

  it('只列出本轮实际下发的工具（被裁掉的组不出现）', () => {
    const hint = buildAvailableToolsHint([
      tool('weather_query', '查询指定城市当前天气与预报。'),
      tool('time_now', '获取本地时间')
    ])
    expect(hint).toContain('- weather_query：')
    expect(hint).toContain('- time_now：')
    expect(hint).not.toContain('web_search')
    expect(hint).toContain('未列出的工具本轮不可用')
  })

  it('描述截断到一句话、超长加省略号（控制 token 成本）', () => {
    const long = '这是一段很长的工具说明'.repeat(10) // 110 字，无句号
    const hint = buildAvailableToolsHint([tool('demo_x', long)])
    const line = hint.split('\n').find((l) => l.startsWith('- demo_x'))!
    expect(line.endsWith('…')).toBe(true)
    expect(line.length).toBeLessThan(90)
    expect(line).not.toContain(long)
  })

  it('空描述有兜底文案（不出现"undefined"）', () => {
    const hint = buildAvailableToolsHint([tool('demo_x', '')])
    expect(hint).toContain('- demo_x：（无描述）')
    expect(hint).not.toContain('undefined')
  })
})
