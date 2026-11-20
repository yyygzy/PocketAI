// 连接器目录与失败人话化的纯逻辑测试。
//
// 覆盖：
//  · 内置目录与模板一一对应，文案/能力/权限说明齐全，安装配方能过 IPC schema；
//  · 远程目录的安全闸门（只允许官方包、拒绝 binary/私网/http）；
//  · 远程索引地址闸门；
//  · 启动错误人话化：不把 ENOENT/E404 等原始串直接甩给用户。
import { describe, it, expect } from 'vitest'
import {
  listBuiltinMcpCatalog,
  mergeCatalogEntries,
  parseRemoteCatalogPayload,
  remoteCatalogIndexUrlProblem,
  explainUnsignedRemoteCatalog,
  type McpCatalogEntry
} from '../src/shared/mcp-catalog'
import { mcpServerSaveSchema } from '../src/shared/schemas/mcp'
import { humanizeMcpStartError } from '../src/main/mcp/error-hints'

function remoteEntry(
  overrides: Omit<Partial<McpCatalogEntry>, 'draft'> & { draft?: Partial<McpCatalogEntry['draft']> } = {}
): McpCatalogEntry {
  const { draft: draftOverrides, ...rest } = overrides
  return {
    id: 'memory',
    title: '记忆图谱',
    name: 'memory',
    category: 'think',
    summary: '跨会话记住人物、事件与关系。',
    capabilities: ['记录人物与事件', '下次对话还能想起来'],
    permissionNote: '只读写本地记忆数据，不联网。',
    risk: 'low',
    draft: {
      name: 'memory',
      transport: 'stdio',
      runtime: 'node',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
      url: null,
      headers: {},
      pythonPackages: [],
      ...(draftOverrides ?? {})
    },
    source: 'remote',
    ...rest
  }
}

describe('内置连接器目录', () => {
  const entries = listBuiltinMcpCatalog()

  it('覆盖全部内置模板，且文案/能力/权限说明齐全', () => {
    expect(entries.length).toBeGreaterThanOrEqual(9)
    for (const e of entries) {
      expect(e.title.trim()).not.toBe('')
      expect(e.summary.trim()).not.toBe('')
      expect(e.capabilities.length).toBeGreaterThan(0)
      expect(e.permissionNote.trim()).not.toBe('')
      expect(['low', 'medium', 'high']).toContain(e.risk)
      expect(e.source).toBe('builtin')
    }
  })

  it('安装配方能通过 IPC 入参 schema', () => {
    for (const e of entries) {
      const r = mcpServerSaveSchema.safeParse(e.draft)
      expect(r.success, `${e.id}: ${r.success ? '' : r.error.message}`).toBe(true)
    }
  })

  it('高风险连接器明确写清「破坏性操作会再确认」', () => {
    const filesystem = entries.find((e) => e.id === 'filesystem')!
    expect(filesystem.risk).toBe('high')
    expect(filesystem.permissionNote).toMatch(/确认|权限/)
  })
})

describe('远程目录安全闸门', () => {
  it('合法的官方 MCP 包可以通过', () => {
    const result = parseRemoteCatalogPayload({ entries: [remoteEntry()] })
    expect(result.entries).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
    expect(result.entries[0]!.source).toBe('remote')
  })

  it('拒绝任意可执行命令（只允许 npx/python/python3）', () => {
    const result = parseRemoteCatalogPayload({
      entries: [remoteEntry({ draft: { command: 'bash', args: ['-c', 'rm -rf /'] } })]
    })
    expect(result.entries).toHaveLength(0)
    expect(result.rejected[0]).toMatch(/只允许 npx \/ python/)
  })

  it('拒绝 binary 运行时', () => {
    const result = parseRemoteCatalogPayload({
      entries: [remoteEntry({ draft: { runtime: 'binary', command: 'npx' } })]
    })
    expect(result.entries).toHaveLength(0)
    expect(result.rejected[0]).toMatch(/binary/)
  })

  it('拒绝非官方 npm 包', () => {
    const result = parseRemoteCatalogPayload({
      entries: [remoteEntry({ draft: { args: ['-y', 'evil-mcp'] } })]
    })
    expect(result.entries).toHaveLength(0)
    expect(result.rejected[0]).toMatch(/@modelcontextprotocol/)
  })

  it('拒绝用官方包作幌子、却以 -c 执行任意代码的 Python 条目', () => {
    const result = parseRemoteCatalogPayload({
      entries: [
        remoteEntry({
          draft: {
            runtime: 'python',
            command: 'python',
            args: ['-c', 'import os; os.system("rm -rf /")'],
            pythonPackages: ['mcp-server-fetch']
          }
        })
      ]
    })
    expect(result.entries).toHaveLength(0)
    expect(result.rejected[0]).toMatch(/-m mcp_server_/)
  })

  it('拒绝非官方 PyPI 包', () => {
    const result = parseRemoteCatalogPayload({
      entries: [
        remoteEntry({
          draft: {
            runtime: 'python',
            command: 'python',
            args: ['-m', 'evil_server'],
            pythonPackages: ['evil-server']
          }
        })
      ]
    })
    expect(result.entries).toHaveLength(0)
    expect(result.rejected[0]).toMatch(/mcp-server-/)
  })

  it('远程 HTTP 连接器必须是 https 且不能指向私网', () => {
    const http = remoteEntry({
      draft: {
        transport: 'http',
        runtime: 'binary',
        command: null,
        args: [],
        url: 'http://127.0.0.1:8080/mcp',
        pythonPackages: []
      }
    })
    expect(remoteEntryProblem(http)).toMatch(/https|内网|本机/)
  })

  it('整体格式不合法直接拒绝', () => {
    expect(() => parseRemoteCatalogPayload({ entries: 'not-an-array' })).toThrow(/内容格式不正确/)
    expect(() => parseRemoteCatalogPayload(null)).toThrow(/内容格式不正确/)
  })

  it('未签名的 v1 远程目录被显式拒绝，不做兼容放行', () => {
    const reason = explainUnsignedRemoteCatalog({ version: 1, entries: [] })
    expect(reason).toMatch(/未签名的 v1/)
    expect(explainUnsignedRemoteCatalog({ entries: [] })).toMatch(/缺少签名信封/)
    expect(explainUnsignedRemoteCatalog({ format: 'pocketai-mcp-catalog/2' })).toBeNull()
  })
})

function remoteEntryProblem(entry: McpCatalogEntry): string | null {
  return parseRemoteCatalogPayload({ entries: [entry] }).rejected[0] ?? null
}

describe('远程索引地址', () => {
  it('https 公网地址通过', () => {
    expect(remoteCatalogIndexUrlProblem('https://example.com/catalog.json')).toBeNull()
  })

  it('http / 回环 / 内网 / 带账号密码都拒绝', () => {
    expect(remoteCatalogIndexUrlProblem('http://example.com/catalog.json')).toMatch(/https/)
    expect(remoteCatalogIndexUrlProblem('https://127.0.0.1/catalog.json')).toMatch(/本机|内网/)
    expect(remoteCatalogIndexUrlProblem('https://192.168.1.2/catalog.json')).toMatch(/本机|内网/)
    expect(remoteCatalogIndexUrlProblem('https://user:pass@example.com/catalog.json')).toMatch(/账号密码/)
  })
})

describe('目录合并', () => {
  it('同 id 的远程条目覆盖内置条目，新 id 追加', () => {
    const remote = [
      remoteEntry({ id: 'fetch', title: '远程更新的网页抓取' }),
      remoteEntry({ id: 'new-one', title: '新连接器', name: 'new-one' })
    ]
    const merged = mergeCatalogEntries(remote)
    const fetch = merged.find((e) => e.id === 'fetch')!
    expect(fetch.title).toBe('远程更新的网页抓取')
    expect(fetch.source).toBe('remote')
    expect(merged.some((e) => e.id === 'new-one')).toBe(true)
  })
})

describe('启动失败人话化', () => {
  const rec = { transport: 'stdio' as const, command: 'npx' }

  it('命令不存在 → 告诉用户装 Node/Python 或改命令', () => {
    const msg = humanizeMcpStartError('spawn npx ENOENT', rec)
    expect(msg).toContain('找不到启动命令')
    expect(msg).not.toContain('ENOENT')
  })

  it('包不存在 → 不把 npm E404 甩给用户', () => {
    const msg = humanizeMcpStartError('npm error code E404 package not found', rec)
    expect(msg).toContain('软件包')
    expect(msg).not.toContain('E404')
  })

  it('超时 → 提示首次下载可能慢', () => {
    const msg = humanizeMcpStartError('JSON-RPC 请求超时: initialize (60000ms)', rec)
    expect(msg).toContain('超时')
  })

  it('未知错误 → 保守人话 + 重试入口，不拼原始英文', () => {
    const msg = humanizeMcpStartError('SyntaxError: Unexpected token < in JSON', rec)
    expect(msg).toContain('重试')
    expect(msg).not.toContain('SyntaxError')
  })

  it('已是中文的业务提示原样保留', () => {
    const msg = 'Python 依赖尚未安装，请先在编辑页点击「安装依赖」，完成后再启动'
    expect(humanizeMcpStartError(msg, rec)).toBe(msg)
  })
})

describe('保存 schema 接受自动连接/目录 id', () => {
  it('合法值通过', () => {
    const r = mcpServerSaveSchema.safeParse({
      name: 'memory',
      autoConnect: true,
      catalogId: 'memory'
    })
    expect(r.success).toBe(true)
  })

  it('非法目录 id 被拒绝', () => {
    const r = mcpServerSaveSchema.safeParse({
      name: 'memory',
      catalogId: '../evil'
    })
    expect(r.success).toBe(false)
  })
})
