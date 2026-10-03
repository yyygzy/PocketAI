// snippet-slash 纯函数测试
import { describe, it, expect } from 'vitest'
import {
  getSnippetTrigger,
  snippetToCommand,
  filterSnippetCommands,
  buildBuiltinSlashCommands
} from '../src/renderer/src/utils/snippet-slash'

describe('getSnippetTrigger — 触发识别', () => {
  it('行首 / 触发', () => {
    expect(getSnippetTrigger('/abc')).toEqual({ trigger: '/', query: 'abc', startPos: 0 })
  })

  it('空白后 / 触发', () => {
    expect(getSnippetTrigger('hello /abc')).toEqual({ trigger: '/', query: 'abc', startPos: 6 })
  })

  it('行首 # 触发', () => {
    expect(getSnippetTrigger('#abc')).toEqual({ trigger: '#', query: 'abc', startPos: 0 })
  })

  it('空白后 # 触发', () => {
    expect(getSnippetTrigger('hello #abc')).toEqual({ trigger: '#', query: 'abc', startPos: 6 })
  })

  it('行中 / 不触发（路径）', () => {
    expect(getSnippetTrigger('hello/abc')).toBeNull()
  })

  it('行中 # 不触发（标签）', () => {
    expect(getSnippetTrigger('hello#abc')).toBeNull()
  })

  it('空查询', () => {
    expect(getSnippetTrigger('/')).toEqual({ trigger: '/', query: '', startPos: 0 })
    expect(getSnippetTrigger('#')).toEqual({ trigger: '#', query: '', startPos: 0 })
  })

  it('光标在中间时只识别光标前', () => {
    expect(getSnippetTrigger('/abc def', 4)).toEqual({ trigger: '/', query: 'abc', startPos: 0 })
    expect(getSnippetTrigger('/abc def', 5)).toBeNull()
  })

  it('无触发字符', () => {
    expect(getSnippetTrigger('hello')).toBeNull()
    expect(getSnippetTrigger('')).toBeNull()
  })
})

describe('snippetToCommand — 片段转命令', () => {
  it('正确映射字段', () => {
    const s = { id: 's1', title: '翻译', content: '翻译以下内容', isBuiltin: false, createdAt: 0, updatedAt: 0 }
    const cmd = snippetToCommand(s as any)
    expect(cmd).toEqual({ name: 'snippet:s1', label: '翻译', template: '翻译以下内容', kind: 'snippet' })
  })
})

describe('filterSnippetCommands — 过滤', () => {
  const cmds = [
    { name: 'a', label: '总结', template: '请总结', kind: 'builtin' as const },
    { name: 'b', label: '翻译', template: '请翻译', kind: 'snippet' as const },
    { name: 'c', label: '润色', template: '请润色', kind: 'snippet' as const }
  ]

  it('空查询返回全部', () => {
    expect(filterSnippetCommands(cmds, '')).toHaveLength(3)
    expect(filterSnippetCommands(cmds, '  ')).toHaveLength(3)
  })

  it('按 label 过滤', () => {
    expect(filterSnippetCommands(cmds, '总结')).toHaveLength(1)
    expect(filterSnippetCommands(cmds, '翻')).toHaveLength(1)
  })

  it('按 template 过滤', () => {
    expect(filterSnippetCommands(cmds, '润色')).toHaveLength(1)
  })

  it('不区分大小写', () => {
    expect(filterSnippetCommands(cmds, 'ABC')).toHaveLength(0)
  })
})

describe('buildBuiltinSlashCommands — 内置指令', () => {
  it('返回 6 条内置指令', () => {
    const t = (k: string) => k
    const cmds = buildBuiltinSlashCommands(t)
    expect(cmds).toHaveLength(6)
    expect(cmds[0]!.kind).toBe('builtin')
    expect(cmds[0]!.name).toBe('summary')
  })
})
