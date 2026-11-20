// MCP「连接器目录」的共享数据与校验。
//
// 设计口径（安全优先）：
//  1. 默认只用本地内置的精选清单，不联网、不接任何第三方开放注册表；
//  2. 远程索引必须由用户显式配置 https 地址，且每条新连接器都要通过下面的
//     安全闸门（只允许官方 MCP 包名 / 不允许 binary / 远端 URL 只能是 https 公网）；
//  3. 远程索引里的文案与命令都按不可信数据处理：安装前界面会把真正要跑的命令摊开，
//     高危工具仍然默认关闭（是否授权由逐工具勾选决定，不随目录安装自动放行）。
import { z } from 'zod'
import { listMcpTemplates, type McpTemplatePlaceholder } from './mcp-templates'
import type { McpImportDraft } from './mcp-import'
import { isLoopbackHost } from './url-policy'

export type McpCatalogCategory = 'web' | 'file' | 'think' | 'auto'
export type McpCatalogRisk = 'low' | 'medium' | 'high'
export type McpCatalogSource = 'builtin' | 'remote'

export interface McpCatalogEntry {
  /** 稳定标识；同一 id 的远程条目会覆盖内置条目（只允许改文案与安装配方） */
  id: string
  /** 给用户看的中文名（不是进程名） */
  title: string
  /** 安装后写入 mcp_servers.name 的技术名 */
  name: string
  category: McpCatalogCategory
  /** 一句话说明「它能帮你干什么」 */
  summary: string
  /** 2–3 条大白话能力说明 */
  capabilities: string[]
  /** 权限说明（大白话，写清能读什么、能改什么、什么操作会再确认） */
  permissionNote: string
  risk: McpCatalogRisk
  /** 安装配方：与 JSON 导入/模板共用同一条落库链路 */
  draft: McpImportDraft
  placeholders?: McpTemplatePlaceholder[]
  source: McpCatalogSource
}

export interface McpCatalogView {
  entries: McpCatalogEntry[]
  builtinCount: number
  remoteCount: number
  /** 已保存的远程索引地址；空串=只用内置清单 */
  indexUrl: string
  /** 远程索引最近一次成功更新时间（ms）；0=从未更新 */
  updatedAt: number
  /** 远程索引最近一次读取失败的原因（内置条目仍然可用） */
  remoteError?: string
  /** 当前远程缓存验签通过时的信封信息（未加载远程条目时缺省） */
  remoteVerified?: {
    keyId: string
    serial: number
    issuedAt: number
  }
}

const BUILTIN_META: Record<
  string,
  { title: string; summary: string; capabilities: string[]; permissionNote: string; risk: McpCatalogRisk }
> = {
  fetch: {
    title: '网页抓取',
    summary: '读取网页正文，整理成助手能看懂的文字。',
    capabilities: ['打开并读取你给的网址', '把网页内容转成干净的 Markdown', '不写入、不修改任何文件'],
    permissionNote: '只读网页，不会改动本机文件；只在你允许联网时使用。',
    risk: 'low'
  },
  puppeteer: {
    title: '浏览器自动化',
    summary: '替你打开网页、点击按钮、填表和截图。',
    capabilities: ['自动打开浏览器访问网页', '点击、输入、提交表单', '截图并保存页面结果'],
    permissionNote: '能操作浏览器里的一切内容；涉及提交、发送、删除等动作时会逐次确认。',
    risk: 'high'
  },
  filesystem: {
    title: '文件读写',
    summary: '让你指定的文件夹变成助手可读可改的工作区。',
    capabilities: ['浏览和读取指定文件夹', '新建、修改、移动文件', '删除文件前会单独确认'],
    permissionNote: '只能访问你填写的文件夹；删除/覆盖等破坏性操作每次都会再确认一次。',
    risk: 'high'
  },
  git: {
    title: 'Git 仓库',
    summary: '查看仓库的提交历史、分支和改动状态。',
    capabilities: ['读取提交历史与分支', '查看当前改动和状态', '不直接改写代码'],
    permissionNote: '以读取为主；如果工具里包含提交、重置等写操作，每次仍会单独确认。',
    risk: 'medium'
  },
  sqlite: {
    title: 'SQLite 数据库',
    summary: '查询本地数据库，也能按你的要求修改数据。',
    capabilities: ['浏览表结构和数据', '执行查询语句', '写入/删除数据前会单独确认'],
    permissionNote: '能读也能写你指定的数据库文件；破坏性 SQL 每次都会再问一次。',
    risk: 'high'
  },
  'tavily-search': {
    title: 'Tavily 网页搜索',
    summary: '给助手一个实时联网搜索入口。',
    capabilities: ['搜索最新网页信息', '返回摘要和来源链接', '需要你提供 Tavily API Key'],
    permissionNote: '只做搜索，不改本机文件；API Key 会加密保存在本地，未设主密码时不会保存。',
    risk: 'medium'
  },
  memory: {
    title: '记忆图谱',
    summary: '跨会话记住人物、事件和它们之间的关系。',
    capabilities: ['记录人物、事件与关系', '下次对话还能想起来', '所有内容只存在你的本地数据库'],
    permissionNote: '只读写本地记忆数据，不联网；清空记忆需要你主动操作。',
    risk: 'low'
  },
  'sequential-thinking': {
    title: '分步思考',
    summary: '把复杂问题拆成几步，帮助手想得更清楚。',
    capabilities: ['拆解复杂问题', '分步推理并回头检查', '不接触你的文件或网络'],
    permissionNote: '纯本地推理辅助，不读写文件、不联网。',
    risk: 'low'
  },
  time: {
    title: '时间与时区',
    summary: '查询当前时间、换算不同时区。',
    capabilities: ['获取当前日期和时间', '在不同时区之间换算', '不读写文件、不联网'],
    permissionNote: '只读系统时间，不会改动任何数据。',
    risk: 'low'
  }
}

/** 本地内置的精选连接器清单（顺序固定，便于用户按场景找） */
export function listBuiltinMcpCatalog(): McpCatalogEntry[] {
  const templates = listMcpTemplates()
  const entries: McpCatalogEntry[] = []
  for (const t of templates) {
    const meta = BUILTIN_META[t.id]
    // 内置模板与目录必须一一对应；新增模板时漏写文案会被测试拦住
    if (!meta) continue
    entries.push({
      id: t.id,
      title: meta.title,
      name: t.draft.name,
      category: t.category,
      summary: meta.summary,
      capabilities: meta.capabilities,
      permissionNote: meta.permissionNote,
      risk: meta.risk,
      draft: { ...t.draft },
      ...(t.placeholders ? { placeholders: t.placeholders.map((p) => ({ ...p })) } : {}),
      source: 'builtin'
    })
  }
  return entries
}

/** 按 id 取内置目录条目（列表卡片补「它能干什么」用；远程覆盖的文案不在此处） */
export function findBuiltinCatalogEntry(id: string | null | undefined): McpCatalogEntry | null {
  if (!id) return null
  return listBuiltinMcpCatalog().find((e) => e.id === id) ?? null
}

/** 合并远程条目：同 id 覆盖内置条目，新 id 追加在末尾 */
export function mergeCatalogEntries(remote: McpCatalogEntry[]): McpCatalogEntry[] {
  const builtin = listBuiltinMcpCatalog()
  const byId = new Map(builtin.map((e) => [e.id, e] as const))
  const appended: McpCatalogEntry[] = []
  for (const entry of remote) {
    const remoteEntry: McpCatalogEntry = { ...entry, source: 'remote' }
    if (byId.has(entry.id)) byId.set(entry.id, remoteEntry)
    else appended.push(remoteEntry)
  }
  return [...builtin.map((e) => byId.get(e.id) ?? e), ...appended]
}

// ─── 远程索引格式与安全闸门 ─────────────────────────────────────

const catalogPlaceholderSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_]+$/, '占位符名只能包含字母/数字/下划线'),
  label: z.string().min(1).max(120),
  secret: z.boolean().optional()
})

const catalogDraftSchema = z.object({
  name: z.string().min(1).max(100),
  transport: z.enum(['stdio', 'http']),
  runtime: z.enum(['node', 'python', 'binary']),
  command: z.string().max(1024).nullable(),
  args: z.array(z.string().max(4096)).max(32),
  env: z.record(z.string().max(256), z.string().max(32768)),
  url: z.string().max(2048).nullable(),
  headers: z.record(z.string().max(128), z.string().max(4096)),
  pythonPackages: z.array(z.string().max(200)).max(50)
})

const catalogEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, '连接器 id 只能包含字母/数字/下划线/短横线'),
  title: z.string().min(1).max(80),
  name: z.string().min(1).max(100),
  category: z.enum(['web', 'file', 'think', 'auto']),
  summary: z.string().min(1).max(300),
  capabilities: z.array(z.string().min(1).max(160)).min(1).max(6),
  permissionNote: z.string().min(1).max(500),
  risk: z.enum(['low', 'medium', 'high']),
  draft: catalogDraftSchema,
  placeholders: z.array(catalogPlaceholderSchema).max(8).optional()
})

/**
 * 签名信封里的 payload。未签名的 v1（`{ version:1, entries:[...] }`）不再被解析：
 * 整份目录必须先通过 `pocketai-mcp-catalog/2` 的 Ed25519 验签（见 shared/mcp-catalog-trust.ts）。
 */
export const remoteMcpCatalogPayloadSchema = z.object({
  updatedAt: z.number().int().nonnegative().optional(),
  entries: z.array(catalogEntrySchema).max(100),
  revoked: z
    .object({
      keyIds: z.array(z.string().min(1).max(64)).max(100).optional(),
      entryIds: z.array(z.string().min(1).max(64)).max(1000).optional(),
      entryHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000).optional()
    })
    .optional()
})

const NPM_OFFICIAL_PREFIX = '@modelcontextprotocol/'
const PYPI_OFFICIAL_PREFIX = 'mcp-server-'
const SAFE_REMOTE_COMMANDS = new Set(['npx', 'python', 'python3'])

function baseName(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  return normalized.split('/').pop() ?? normalized
}

function isPrivateIpHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h) || /^0\.0\.0\.0$/.test(h)) return true
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

/** 远程索引地址闸门：必须 https、不能带账号密码、不能指向本机/内网 */
export function remoteCatalogIndexUrlProblem(raw: string): string | null {
  let u: URL
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    return '远程目录地址不合法'
  }
  if (u.protocol !== 'https:') return '远程目录地址必须是 https'
  if (u.username || u.password) return '远程目录地址不能携带账号密码'
  if (isPrivateIpHost(u.hostname) || isLoopbackHost(u.hostname)) return '远程目录地址不能指向本机或内网'
  return null
}

/**
 * 远程条目的安全闸门（纯函数，便于单测）。
 * 返回 null 表示通过；否则返回拒绝原因（中文，直接进日志/界面）。
 *
 * 为什么这么严：远程索引在没有签名信任（本次明确后置）的情况下仍然是"陌生人的安装配方"。
 * 因此只允许它调度官方 MCP 包（npm @modelcontextprotocol/* / PyPI mcp-server-*），
 * 不允许 binary 任意可执行文件，也不允许把远端指到回环/内网。
 */
export function remoteCatalogEntryProblem(entry: McpCatalogEntry): string | null {
  const d = entry.draft
  if (d.transport === 'http') {
    if (!d.url) return 'HTTP 条目缺少 url'
    let u: URL
    try {
      u = new URL(d.url)
    } catch {
      return 'HTTP 条目的 url 不合法'
    }
    if (u.protocol !== 'https:') return '远程目录里的 HTTP 连接器必须是 https 地址'
    if (u.username || u.password) return 'HTTP 条目不允许在 URL 里携带账号密码'
    if (isPrivateIpHost(u.hostname) || isLoopbackHost(u.hostname)) return 'HTTP 条目不允许指向本机或内网地址'
    return null
  }
  const command = baseName(String(d.command ?? '')).toLowerCase()
  if (!SAFE_REMOTE_COMMANDS.has(command)) {
    return `远程目录不允许启动该命令：${command || '(空)'}（只允许 npx / python / python3）`
  }
  if (d.runtime === 'python') {
    if (!d.pythonPackages.length) return 'Python 条目必须声明官方 mcp-server-* 依赖'
    const bad = d.pythonPackages.find((p) => !p.startsWith(PYPI_OFFICIAL_PREFIX))
    if (bad) return `远程目录只允许官方 mcp-server-* 包：${bad}`
    // 必须 `-m mcp_server_xxx` 启动；禁止 -c/任意脚本，否则官方包只是幌子
    const [flag, module] = d.args
    if (flag !== '-m' || !module || !module.startsWith('mcp_server_')) {
      return 'Python 条目必须以「-m mcp_server_*」方式启动'
    }
    return null
  }
  if (d.runtime === 'node') {
    if (command !== 'npx') return '远程目录里的 Node 连接器必须通过 npx 安装'
    const packageArg = d.args.find((a) => a && !a.startsWith('-'))
    if (!packageArg) return 'npx 条目缺少包名'
    if (!packageArg.startsWith(NPM_OFFICIAL_PREFIX)) {
      return `远程目录只允许 @modelcontextprotocol/* 官方包：${packageArg}`
    }
    return null
  }
  return '远程目录不允许 binary 类型的连接器'
}

export interface RemoteCatalogParseResult {
  entries: McpCatalogEntry[]
  /** 被安全闸门/撤销列表拒绝的条目说明（不阻断其余条目） */
  rejected: string[]
}

export interface RemoteCatalogParseOptions {
  /** 发布者撤销的条目：返回非空原因即丢弃该条（哈希需要主进程算，故用回调注入） */
  entryRevoked?: (entry: McpCatalogEntry, rawEntry: unknown) => string | null
}

/**
 * 未签名/旧格式的显式拒绝原因（验签前的第一道闸）。
 * 返回 null 表示「形状像签名信封」，交给信封 schema 继续判。
 */
export function explainUnsignedRemoteCatalog(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '远程目录不是签名信封（需要 pocketai-mcp-catalog/2），已拒绝加载。'
  }
  const obj = raw as Record<string, unknown>
  if ('format' in obj) return null
  if (obj.version === 1) {
    return '远程目录是未签名的 v1 格式，已拒绝加载。请让发布者改用 pocketai-mcp-catalog/2 签名信封后重试。'
  }
  if ('entries' in obj) {
    return '远程目录缺少签名信封（pocketai-mcp-catalog/2），已拒绝加载。未签名的目录一律不加载。'
  }
  return '远程目录不是签名信封（需要 pocketai-mcp-catalog/2），已拒绝加载。'
}

/**
 * 解析**已通过验签**的信封 payload：整体格式非法直接抛错；单条不安全只拒绝该条。
 * 撤销列表里的条目在这里一并丢弃（撤销=发布者明确作废，不等于「没签名也能装」）。
 */
export function parseRemoteCatalogPayload(
  payload: unknown,
  options: RemoteCatalogParseOptions = {}
): RemoteCatalogParseResult {
  const top = remoteMcpCatalogPayloadSchema.safeParse(payload)
  if (!top.success) {
    throw new Error('远程目录内容格式不正确（签名信封的 payload 需要 entries 数组）')
  }
  const entries: McpCatalogEntry[] = []
  const rejected: string[] = []
  for (const item of top.data.entries) {
    const candidate: McpCatalogEntry = { ...item, source: 'remote' }
    const problem = remoteCatalogEntryProblem(candidate)
    if (problem) {
      rejected.push(`${candidate.id}: ${problem}`)
      continue
    }
    const revoked = options.entryRevoked?.(candidate, item) ?? null
    if (revoked) {
      rejected.push(`${candidate.id}: ${revoked}`)
      continue
    }
    entries.push(candidate)
  }
  return { entries, rejected }
}
