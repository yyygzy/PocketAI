// 内置 MCP Server 模板：预置常用免密钥服务，一键创建。
// 设计约束：
//  1. 模板只产出 McpImportDraft（与 JSON 导入同构），创建走同一条 saveMcpServer 链路；
//  2. node 类模板用官方 @modelcontextprotocol 包（npx 免装）；python 类模板用
//     python -m <module> + pythonPackages，主进程会先装进 venv 再用 venv 解释器启动，
//     不依赖用户预装 uv；
//  3. desc/label 存 i18n key，由渲染端翻译；本文件保持纯数据 + 纯函数。
import type { McpImportDraft } from './mcp-import'

export interface McpTemplatePlaceholder {
  /** draft.args/url 中的 {{key}} 占位符 */
  key: string
  /** 输入框标签（i18n key） */
  label: string
}

export interface McpTemplate {
  id: string
  /** 描述（i18n key） */
  desc: string
  draft: Omit<McpImportDraft, 'enabled'>
  /** 需用户填写占位符的模板才声明；创建前渲染端按此渲染输入框 */
  placeholders?: McpTemplatePlaceholder[]
}

const TEMPLATES: McpTemplate[] = [
  {
    id: 'filesystem',
    desc: 'agent.tplDescFilesystem',
    draft: {
      name: 'filesystem',
      transport: 'stdio',
      runtime: 'node',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '{{dir}}'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: []
    },
    placeholders: [{ key: 'dir', label: 'agent.tplPhDir' }]
  },
  {
    id: 'fetch',
    desc: 'agent.tplDescFetch',
    draft: {
      name: 'fetch',
      transport: 'stdio',
      runtime: 'python',
      command: 'python',
      args: ['-m', 'mcp_server_fetch'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: ['mcp-server-fetch']
    }
  },
  {
    id: 'memory',
    desc: 'agent.tplDescMemory',
    draft: {
      name: 'memory',
      transport: 'stdio',
      runtime: 'node',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: []
    }
  },
  {
    id: 'time',
    desc: 'agent.tplDescTime',
    draft: {
      name: 'time',
      transport: 'stdio',
      runtime: 'python',
      command: 'python',
      args: ['-m', 'mcp_server_time'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: ['mcp-server-time']
    }
  },
  {
    id: 'sequential-thinking',
    desc: 'agent.tplDescSeq',
    draft: {
      name: 'sequential-thinking',
      transport: 'stdio',
      runtime: 'node',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: []
    }
  },
  {
    id: 'git',
    desc: 'agent.tplDescGit',
    draft: {
      name: 'git',
      transport: 'stdio',
      runtime: 'python',
      command: 'python',
      args: ['-m', 'mcp_server_git', '{{repo}}'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: ['mcp-server-git']
    },
    placeholders: [{ key: 'repo', label: 'agent.tplPhRepo' }]
  }
]

/** 读取全部内置模板（返回拷贝，防调用方误改常量） */
export function listMcpTemplates(): McpTemplate[] {
  return TEMPLATES.map((t) => ({ ...t, draft: { ...t.draft } }))
}

export interface McpTemplateInstance {
  draft?: McpImportDraft
  /** 占位符缺失时返回 'missing:<key>'，渲染端映射 i18n */
  error?: string
}

/** 找出 draft.args/url 中实际出现的 {{key}} 占位符集合 */
export function templatePlaceholderKeys(t: McpTemplate): string[] {
  const keys: string[] = []
  for (const arg of t.draft.args ?? []) {
    for (const m of arg.matchAll(/\{\{(\w+)\}\}/g)) keys.push(m[1]!)
  }
  const url = t.draft.url
  if (url) {
    for (const m of url.matchAll(/\{\{(\w+)\}\}/g)) keys.push(m[1]!)
  }
  return [...new Set(keys)]
}

/**
 * 实例化模板：替换 {{key}} 占位符为用户填写的值。
 * 声明了 placeholders 的模板要求每个占位符都有非空值（声明与实际使用不一致也报错）。
 */
export function instantiateMcpTemplate(
  t: McpTemplate,
  values: Record<string, string>
): McpTemplateInstance {
  const used = templatePlaceholderKeys(t)
  const declared = (t.placeholders ?? []).map((p) => p.key)
  const all = [...new Set([...used, ...declared])]
  const resolved: Record<string, string> = {}
  for (const key of all) {
    const v = String(values[key] ?? '').trim()
    if (!v) return { error: `missing:${key}` }
    resolved[key] = v
  }
  const sub = (s: string): string => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => resolved[k] ?? '')
  return {
    draft: {
      ...t.draft,
      args: (t.draft.args ?? []).map(sub),
      url: t.draft.url ? sub(t.draft.url) : null,
      enabled: true
    }
  }
}
