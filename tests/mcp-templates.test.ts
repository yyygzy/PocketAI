// 内置 MCP Server 模板测试
//
// 覆盖 src/shared/mcp-templates.ts：
// - 模板清单结构完整性（name 唯一、占位符声明与实际使用一致、draft 能过 IPC 入参 schema）
// - instantiateMcpTemplate：占位符替换 / 缺值报错 / 声明与使用不一致也要求填
import { describe, it, expect } from 'vitest'
import {
  listMcpTemplates,
  instantiateMcpTemplate,
  templatePlaceholderKeys
} from '../src/shared/mcp-templates'
import { mcpServerSaveSchema } from '../src/shared/schemas/mcp'

describe('模板清单结构', () => {
  const templates = listMcpTemplates()

  it('预置模板非空且 name 唯一', () => {
    expect(templates.length).toBeGreaterThanOrEqual(6)
    const names = templates.map((t) => t.draft.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('transport 均为 stdio 且 url 为空', () => {
    for (const t of templates) {
      expect(t.draft.transport).toBe('stdio')
      expect(t.draft.url).toBeNull()
    }
  })

  it('placeholders 声明与 args 中的实际占位符一致', () => {
    for (const t of templates) {
      const used = templatePlaceholderKeys(t)
      const declared = (t.placeholders ?? []).map((p) => p.key).sort()
      expect(used.sort()).toEqual(declared)
    }
  })

  it('每个模板实例化后的 draft 能通过 mcpServerSaveSchema（IPC 入口兜底）', () => {
    for (const t of templates) {
      const values: Record<string, string> = {}
      for (const p of t.placeholders ?? []) values[p.key] = `C:\\tmp\\${p.key}`
      const inst = instantiateMcpTemplate(t, values)
      expect(inst.error).toBeUndefined()
      expect(inst.draft).toBeDefined()
      const r = mcpServerSaveSchema.safeParse(inst.draft)
      expect(r.success).toBe(true)
    }
  })
})

describe('instantiateMcpTemplate', () => {
  const templates = listMcpTemplates()
  const filesystem = templates.find((t) => t.id === 'filesystem')!

  it('占位符替换为用户填写的值，enabled 为 true', () => {
    const inst = instantiateMcpTemplate(filesystem, { dir: 'D:\\docs' })
    expect(inst.error).toBeUndefined()
    expect(inst.draft?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:\\docs'])
    expect(inst.draft?.enabled).toBe(true)
  })

  it('缺值返回 missing:<key>', () => {
    const inst = instantiateMcpTemplate(filesystem, {})
    expect(inst.error).toBe('missing:dir')
    expect(inst.draft).toBeUndefined()
  })

  it('值为纯空白视为缺值', () => {
    const inst = instantiateMcpTemplate(filesystem, { dir: '   ' })
    expect(inst.error).toBe('missing:dir')
  })

  it('无占位符模板不要求 values，直接产出', () => {
    const fetch = templates.find((t) => t.id === 'fetch')!
    const inst = instantiateMcpTemplate(fetch, {})
    expect(inst.error).toBeUndefined()
    expect(inst.draft?.command).toBe('python')
    expect(inst.draft?.pythonPackages).toContain('mcp-server-fetch')
  })

  it('声明多于使用的占位符同样要求填写（防配置漂移）', () => {
    const fake = {
      ...filesystem,
      placeholders: [{ key: 'dir', label: 'x' }, { key: 'extra', label: 'y' }]
    }
    const inst = instantiateMcpTemplate(fake, { dir: 'D:\\x' })
    expect(inst.error).toBe('missing:extra')
  })

  it('listMcpTemplates 返回拷贝，修改不影响后续调用', () => {
    const a = listMcpTemplates()
    a[0]!.draft.name = 'tampered'
    const b = listMcpTemplates()
    expect(b[0]!.draft.name).not.toBe('tampered')
  })
})
