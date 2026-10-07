import { describe, expect, it } from 'vitest'

describe('tool-grouping', () => {
  it('should split tools into builtin and mcp groups', () => {
    const tools = [
      { id: '1', name: 'a', description: '', parameters: {}, source: 'builtin' as const },
      { id: '2', name: 'b', description: '', parameters: {}, source: 'mcp' as const },
      { id: '3', name: 'c', description: '', parameters: {}, source: 'builtin' as const }
    ]
    const builtinTools = tools.filter((t) => t.source !== 'mcp')
    const mcpTools = tools.filter((t) => t.source === 'mcp')
    expect(builtinTools).toHaveLength(2)
    expect(mcpTools).toHaveLength(1)
  })

  it('should select all tools in a group', () => {
    const group = [
      { id: 'a', name: 'a', description: '', parameters: {}, source: 'builtin' as const },
      { id: 'b', name: 'b', description: '', parameters: {}, source: 'builtin' as const }
    ]
    const prev: string[] = ['c']
    const next = prev.filter((id) => !group.some((t) => t.id === id))
    const result = [...next, ...group.map((t) => t.id)]
    expect(result).toEqual(['c', 'a', 'b'])
  })

  it('should clear all tools in a group', () => {
    const group = [
      { id: 'a', name: 'a', description: '', parameters: {}, source: 'builtin' as const },
      { id: 'b', name: 'b', description: '', parameters: {}, source: 'builtin' as const }
    ]
    const prev = ['a', 'b', 'c']
    const result = prev.filter((id) => !group.some((t) => t.id === id))
    expect(result).toEqual(['c'])
  })
})
