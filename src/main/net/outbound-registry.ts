// 出网清单注册表（2c-2，只读）
//
// 目标：把「应用会连哪些地址」做成**从代码枚举**的清单，而不是手写一份很快过期的名单。
// 覆盖测试（tests/outbound-coverage.test.ts）扫描 src/main 下的出网调用点
// （fetch( / safeFetch( / new WebDAVClient / autoUpdater / new WebSocket，
// 以及本仓库实际使用的 `from 'webdav'`），逐个断言其所在文件已登记在 OUTBOUND_ENTRIES[*].files。
// 新增一个 fetch 调用点而不登记，测试会直接变红。
//
// 口径：
//  - fixed：固定域名/端点常量；
//  - configurable：地址来自现有配置仓储，运行时可变；
//  - runtime-url：运行时输入（用户/模型给出 URL，或平台在运行时下发），无法预先枚举；
//  - local-loopback：只连本机环回，不出网（在屏上明确标「不出网」）；
//  - transport=child-process：由子进程发起，应用自身不直接连接。
//
// endpointEvidence 说明「该端点在本仓库里如何被证实」：
//  - callsite（默认）：调用点文件里能找到该地址（含模板常量拼接）；
//  - redirect：上游 302 后由 safeFetch 跟随到该地址，调用点文件里没有字面量；
//  - config：地址由构建配置/环境变量决定（如 electron-builder publish）；
//  - runtime：由子进程或运行时决定，应用自身不直接请求。
// 覆盖测试按此做双向校验：调用点出现的地址必须登记，callsite 条目的登记地址必须真被调用。
import type {
  OutboundAddress,
  OutboundEntryView,
  OutboundKind,
  OutboundTransport
} from '../../shared/types'
import { ACTIVATION_BASE_URL } from '../license/server-config'
import { errMsg } from '../error'

// ---------- 固定端点常量（仅注册表内部使用） ----------
const TAVILY_API = 'https://api.tavily.com'
const BOCHA_API = 'https://api.bochaai.com'
const OPEN_METEO_GEOCODING = 'https://geocoding-api.open-meteo.com'
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com'
const OLLAMA_LOOPBACK = 'http://127.0.0.1:11434'
const OLLAMA_RECOMMEND_LOOPBACK = 'http://localhost:11434'
const OLLAMA_OFFICIAL = 'https://github.com/ollama/ollama'
const OLLAMA_REGISTRY = 'https://registry.ollama.ai'
const PYTHON_STANDALONE = 'https://github.com/astral-sh/python-build-standalone'
const GH_RELEASES = 'https://github.com/yyygzy/PocketAI'
const GH_RELEASE_CDN_OBJECTS = 'https://objects.githubusercontent.com'
const GH_RELEASE_CDN_ASSETS = 'https://release-assets.githubusercontent.com'
const GH_API = 'https://api.github.com'
const NPM_REGISTRY_DEFAULT = 'https://registry.npmjs.org'
const TELEGRAM_API = 'https://api.telegram.org'
const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_GATEWAY_WS = 'wss://gateway.discord.gg'
const SLACK_API = 'https://slack.com/api'
const FEISHU_API = 'https://open.feishu.cn'
const DINGTALK_API = 'https://api.dingtalk.com'
const PIP_INDEX_OFFICIAL = 'https://pypi.org/simple'
const PIP_INDEX_TUNA = 'https://pypi.tuna.tsinghua.edu.cn/simple'

export interface OutboundEntry {
  id: string
  labelKey: string
  purposeKey: string
  kind: OutboundKind
  configSource: string
  endpoints: string[]
  transport: OutboundTransport
  /** 覆盖测试用：相对 src/main 的源文件路径 */
  files: string[]
  /** 端点证据类型；缺省按 callsite 校验（见文件头说明） */
  endpointEvidence?: 'callsite' | 'redirect' | 'config' | 'runtime'
  /** 读现有配置仓储拿当前真实地址；未配置返回 []，抛错由上层区分 */
  resolve?: () => Promise<OutboundAddress[]>
}

/**
 * 覆盖测试的显式豁免：传输层自身实现文件。
 * 它包含 `fetch(`/`safeFetch(` 的定义，不是调用点；把它登记成「出网条目」没有意义。
 * 豁免必须写在这里（而不是测试里硬编码），改动可被 code review 看见。
 */
export const OUTBOUND_SCAN_EXEMPT_FILES = ['net/safe-fetch.ts']

/** 相对 src/main 的文件路径集合（覆盖测试断言用） */
export function outboundRegisteredFiles(): string[] {
  return [...new Set(OUTBOUND_ENTRIES.flatMap((e) => e.files))]
}

async function resolveProviderBaseUrls(): Promise<OutboundAddress[]> {
  const { providerRepo } = await import('../db/repositories/provider.repo')
  return providerRepo
    .list()
    .filter((p) => p.baseUrl.trim() !== '')
    .map((p) => ({ label: p.name, value: p.baseUrl }))
}

async function resolveSearxng(): Promise<OutboundAddress[]> {
  const { getWebSearchConfig } = await import('../tools/websearch-config')
  const cfg = getWebSearchConfig()
  return cfg.searxngBaseUrl.trim() ? [{ label: cfg.provider, value: cfg.searxngBaseUrl }] : []
}

async function resolveMcpHttp(): Promise<OutboundAddress[]> {
  const { mcpServerRepo } = await import('../db/repositories/mcp-server.repo')
  return mcpServerRepo
    .list()
    .filter((s) => s.transport === 'http' && (s.url ?? '').trim() !== '')
    .map((s) => ({ label: s.name, value: s.url as string }))
}

async function resolveWebdav(): Promise<OutboundAddress[]> {
  const { readWebDAVConfig } = await import('../backup/backup-service')
  const read = readWebDAVConfig()
  // 「有行但读不出来」不是「没配过」：不把坏配置画成未配置
  if (read.configUnreadable) throw new Error('WebDAV 配置行读取失败（请到设置 → 数据与安全 重新保存）')
  const url = read.cfg?.url
  return url?.trim() ? [{ label: '', value: url }] : []
}

async function resolveOllamaDownload(): Promise<OutboundAddress[]> {
  const { appConfigRepo } = await import('../db/repositories/app-config.repo')
  const mirror = (appConfigRepo.get('ollama_download_mirror') ?? '').trim()
  return mirror
    ? [
        { label: 'official', value: OLLAMA_OFFICIAL },
        { label: 'mirror', value: mirror }
      ]
    : [{ label: 'official', value: OLLAMA_OFFICIAL }]
}

async function resolvePipIndex(): Promise<OutboundAddress[]> {
  const { getPipSource } = await import('../mcp/python-env')
  const source = getPipSource()
  const value =
    source === 'official' ? PIP_INDEX_OFFICIAL : source === 'tuna' ? PIP_INDEX_TUNA : source
  return [{ label: source, value }]
}

async function resolveNpmRegistry(): Promise<OutboundAddress[]> {
  const registry = (process.env.npm_config_registry ?? '').trim() || NPM_REGISTRY_DEFAULT
  return [{ label: '', value: registry }]
}

async function resolveProxy(): Promise<OutboundAddress[]> {
  const { appConfigRepo } = await import('../db/repositories/app-config.repo')
  const url = (appConfigRepo.getProxyUrl() ?? '').trim()
  return url ? [{ label: '', value: url }] : []
}

function fixedAddresses(endpoints: string[]): OutboundAddress[] {
  return endpoints.map((value) => ({ label: '', value }))
}

/**
 * 出网清单。顺序即设置页表格顺序：按「用户最容易出网」到「系统后台」排列。
 */
export const OUTBOUND_ENTRIES: OutboundEntry[] = [
  {
    id: 'model-providers',
    labelKey: 'outbound.entry.modelProviders',
    purposeKey: 'outbound.purpose.modelProviders',
    kind: 'configurable',
    configSource: 'providers.base_url',
    endpoints: [],
    transport: 'fetch',
    files: ['providers/openai-compatible.ts'],
    resolve: resolveProviderBaseUrls
  },
  {
    id: 'search-tavily',
    labelKey: 'outbound.entry.searchTavily',
    purposeKey: 'outbound.purpose.searchTavily',
    kind: 'fixed',
    configSource: 'agent.websearch_provider + agent.websearch_tavily_key',
    endpoints: [TAVILY_API],
    transport: 'fetch',
    files: ['search/providers/tavily.ts', 'search/provider-fetch.ts']
  },
  {
    id: 'search-bocha',
    labelKey: 'outbound.entry.searchBocha',
    purposeKey: 'outbound.purpose.searchBocha',
    kind: 'fixed',
    configSource: 'agent.websearch_provider + agent.websearch_bocha_key',
    endpoints: [BOCHA_API],
    transport: 'fetch',
    files: ['search/providers/bocha.ts']
  },
  {
    id: 'search-searxng',
    labelKey: 'outbound.entry.searchSearxng',
    purposeKey: 'outbound.purpose.searchSearxng',
    kind: 'configurable',
    configSource: 'agent.websearch_searxng_url',
    endpoints: [],
    transport: 'fetch',
    files: ['search/providers/searxng.ts', 'search/registry.ts'],
    resolve: resolveSearxng
  },
  {
    id: 'web-fetch',
    labelKey: 'outbound.entry.webFetch',
    purposeKey: 'outbound.purpose.webFetch',
    kind: 'runtime-url',
    configSource: '运行时 URL（模型/用户输入）',
    endpoints: [],
    transport: 'safeFetch',
    files: ['tools/builtin.ts']
  },
  {
    id: 'deep-search',
    labelKey: 'outbound.entry.deepSearch',
    purposeKey: 'outbound.purpose.deepSearch',
    kind: 'runtime-url',
    configSource: '搜索结果页 URL（运行时决定）',
    endpoints: [],
    transport: 'safeFetch',
    files: ['search/deep.ts']
  },
  {
    id: 'weather',
    labelKey: 'outbound.entry.weather',
    purposeKey: 'outbound.purpose.weather',
    kind: 'fixed',
    configSource: '无（固定端点）',
    endpoints: [OPEN_METEO_GEOCODING, OPEN_METEO_FORECAST],
    transport: 'safeFetch',
    files: ['tools/weather.ts']
  },
  {
    id: 'image-download',
    labelKey: 'outbound.entry.imageDownload',
    purposeKey: 'outbound.purpose.imageDownload',
    kind: 'runtime-url',
    configSource: '服务商返回的图片 URL（运行时决定）',
    endpoints: [],
    transport: 'safeFetch',
    files: ['images/image-service.ts']
  },
  {
    id: 'skill-remote',
    labelKey: 'outbound.entry.skillRemote',
    purposeKey: 'outbound.purpose.skillRemote',
    kind: 'runtime-url',
    configSource: '技能包 URL / 索引地址（运行时输入，默认走 GitHub Contents API，raw 兜底）',
    endpoints: [],
    transport: 'safeFetch',
    files: ['skills/skill-io.ts']
  },
  {
    id: 'kb-url',
    labelKey: 'outbound.entry.kbUrl',
    purposeKey: 'outbound.purpose.kbUrl',
    kind: 'runtime-url',
    configSource: '知识库导入 URL（用户输入）',
    endpoints: [],
    transport: 'safeFetch',
    files: ['knowledge/parsers/index.ts']
  },
  {
    id: 'webdav-backup',
    labelKey: 'outbound.entry.webdavBackup',
    purposeKey: 'outbound.purpose.webdavBackup',
    kind: 'configurable',
    configSource: 'webdav_config.url',
    endpoints: [],
    transport: 'webdav',
    files: ['backup/webdav-client.ts', 'backup/backup-service.ts', 'backup/task-scheduler.ts'],
    resolve: resolveWebdav
  },
  {
    id: 'mcp-http',
    labelKey: 'outbound.entry.mcpHttp',
    purposeKey: 'outbound.purpose.mcpHttp',
    kind: 'configurable',
    configSource: 'mcp_servers.url（transport=http）',
    endpoints: [],
    transport: 'fetch',
    files: ['mcp/http-transport.ts'],
    resolve: resolveMcpHttp
  },
  {
    id: 'mcp-stdio',
    labelKey: 'outbound.entry.mcpStdio',
    purposeKey: 'outbound.purpose.mcpStdio',
    kind: 'configurable',
    configSource: 'mcp_servers.command（transport=stdio）',
    endpoints: [],
    transport: 'child-process',
    files: ['mcp/json-rpc.ts']
  },
  {
    id: 'mcp-python-deps',
    labelKey: 'outbound.entry.mcpPythonDeps',
    purposeKey: 'outbound.purpose.mcpPythonDeps',
    kind: 'configurable',
    configSource: 'python_pip_index_url',
    endpoints: [PIP_INDEX_OFFICIAL, PIP_INDEX_TUNA],
    endpointEvidence: 'runtime',
    transport: 'child-process',
    files: ['mcp/python-env.ts'],
    resolve: resolvePipIndex
  },
  {
    id: 'mcp-node-deps',
    labelKey: 'outbound.entry.mcpNodeDeps',
    purposeKey: 'outbound.purpose.mcpNodeDeps',
    kind: 'configurable',
    configSource: 'npm registry（npx 安装 MCP 依赖，由 Node/npm 环境决定）',
    endpoints: [NPM_REGISTRY_DEFAULT],
    endpointEvidence: 'runtime',
    transport: 'child-process',
    files: ['mcp/json-rpc.ts'],
    resolve: resolveNpmRegistry
  },
  {
    id: 'ollama-local',
    labelKey: 'outbound.entry.ollamaLocal',
    purposeKey: 'outbound.purpose.ollamaLocal',
    kind: 'local-loopback',
    configSource: '固定环回 127.0.0.1:11434',
    endpoints: [OLLAMA_LOOPBACK],
    transport: 'fetch',
    files: ['ollama/ollama-runtime.ts']
  },
  {
    id: 'model-recommend',
    labelKey: 'outbound.entry.modelRecommend',
    purposeKey: 'outbound.purpose.modelRecommend',
    kind: 'local-loopback',
    configSource: '固定环回 localhost:11434/api/tags',
    endpoints: [`${OLLAMA_RECOMMEND_LOOPBACK}/api/tags`],
    transport: 'fetch',
    files: ['steward/model-recommend.ts']
  },
  {
    id: 'ollama-download',
    labelKey: 'outbound.entry.ollamaDownload',
    purposeKey: 'outbound.purpose.ollamaDownload',
    kind: 'configurable',
    configSource: 'ollama_download_mirror（空=官方源）',
    endpoints: [OLLAMA_OFFICIAL],
    transport: 'safeFetch',
    files: ['ollama/ollama-runtime.ts'],
    resolve: resolveOllamaDownload
  },
  {
    id: 'ollama-model-pull',
    labelKey: 'outbound.entry.ollamaModelPull',
    purposeKey: 'outbound.purpose.ollamaModelPull',
    kind: 'runtime-url',
    configSource: '本地 Ollama 守护进程（/api/pull），模型 blob 来自其 registry（默认 registry.ollama.ai）',
    endpoints: [OLLAMA_LOOPBACK],
    transport: 'child-process',
    files: ['ollama/ollama-runtime.ts']
  },
  {
    id: 'ollama-registry',
    labelKey: 'outbound.entry.ollamaRegistry',
    purposeKey: 'outbound.purpose.ollamaRegistry',
    kind: 'runtime-url',
    configSource: 'Ollama 守护进程的模型仓库（默认 registry.ollama.ai，可由用户环境改写）',
    endpoints: [OLLAMA_REGISTRY],
    endpointEvidence: 'runtime',
    transport: 'child-process',
    files: ['ollama/ollama-runtime.ts']
  },
  {
    id: 'python-portable',
    labelKey: 'outbound.entry.pythonPortable',
    purposeKey: 'outbound.purpose.pythonPortable',
    kind: 'fixed',
    configSource: '无（固定 GitHub release）',
    endpoints: [PYTHON_STANDALONE],
    transport: 'safeFetch',
    files: ['python-runtime.ts']
  },
  {
    id: 'app-update',
    labelKey: 'outbound.entry.appUpdate',
    purposeKey: 'outbound.purpose.appUpdate',
    kind: 'fixed',
    configSource: 'electron-builder publish（GitHub Releases）',
    endpoints: [GH_RELEASES],
    endpointEvidence: 'config',
    transport: 'updater',
    files: ['update-manager.ts']
  },
  {
    id: 'update-changelog',
    labelKey: 'outbound.entry.updateChangelog',
    purposeKey: 'outbound.purpose.updateChangelog',
    kind: 'fixed',
    configSource: '无（固定 GitHub API）',
    endpoints: [GH_API],
    transport: 'safeFetch',
    files: ['update-manager.ts']
  },
  {
    id: 'asar-patch',
    labelKey: 'outbound.entry.asarPatch',
    purposeKey: 'outbound.purpose.asarPatch',
    kind: 'fixed',
    configSource: '无（固定 GitHub Releases 下载地址）',
    endpoints: [GH_RELEASES],
    transport: 'safeFetch',
    files: ['update/asar-patcher.ts']
  },
  {
    id: 'github-release-cdn',
    labelKey: 'outbound.entry.githubReleaseCdn',
    purposeKey: 'outbound.purpose.githubReleaseCdn',
    kind: 'fixed',
    configSource: 'GitHub Release 下载 302 后的 CDN（由 safeFetch 跟随）',
    endpoints: [GH_RELEASE_CDN_OBJECTS, GH_RELEASE_CDN_ASSETS],
    endpointEvidence: 'redirect',
    transport: 'safeFetch',
    files: ['python-runtime.ts', 'ollama/ollama-runtime.ts', 'update/asar-patcher.ts', 'update-manager.ts']
  },
  {
    id: 'im-api',
    labelKey: 'outbound.entry.imApi',
    purposeKey: 'outbound.purpose.imApi',
    kind: 'fixed',
    configSource: 'channels 中对应渠道的开关与凭据',
    endpoints: [TELEGRAM_API, DISCORD_API, SLACK_API, FEISHU_API, DINGTALK_API],
    transport: 'fetch',
    files: [
      'channels/gateway-base.ts',
      'channels/telegram-gateway.ts',
      'channels/discord-gateway.ts',
      'channels/slack-gateway.ts',
      'channels/feishu-gateway.ts',
      'channels/dingtalk-gateway.ts'
    ]
  },
  {
    id: 'im-ws-discord',
    labelKey: 'outbound.entry.imWsDiscord',
    purposeKey: 'outbound.purpose.imWsDiscord',
    kind: 'fixed',
    configSource: 'channels.discord 开关与凭据',
    endpoints: [DISCORD_GATEWAY_WS],
    transport: 'websocket',
    files: ['channels/discord-gateway.ts']
  },
  {
    id: 'im-ws-dynamic',
    labelKey: 'outbound.entry.imWsDynamic',
    purposeKey: 'outbound.purpose.imWsDynamic',
    kind: 'runtime-url',
    configSource: '平台 API 在运行时下发的 WebSocket 地址',
    endpoints: [],
    transport: 'websocket',
    files: ['channels/slack-gateway.ts', 'channels/feishu-gateway.ts', 'channels/dingtalk-gateway.ts']
  },
  {
    id: 'license-activation',
    labelKey: 'outbound.entry.licenseActivation',
    purposeKey: 'outbound.purpose.licenseActivation',
    kind: 'configurable',
    configSource: '环境变量 POCKETAI_LICENSE_URL',
    endpoints: [ACTIVATION_BASE_URL],
    endpointEvidence: 'config',
    transport: 'fetch',
    files: ['license/activation-client.ts'],
    resolve: async () => [{ label: '', value: ACTIVATION_BASE_URL }]
  },
  {
    id: 'http-proxy',
    labelKey: 'outbound.entry.httpProxy',
    purposeKey: 'outbound.purpose.httpProxy',
    kind: 'configurable',
    configSource: 'app_config.net_proxy_url（全局 fetch 的下一跳）',
    endpoints: [],
    transport: 'fetch',
    files: ['net/proxy.ts'],
    resolve: resolveProxy
  }
]

/** 把注册表解析成渲染端视图（当前真实地址从现有仓储读，读失败单独标出） */
export async function getOutboundEntriesView(): Promise<OutboundEntryView[]> {
  return Promise.all(
    OUTBOUND_ENTRIES.map(async (entry): Promise<OutboundEntryView> => {
      let addresses: OutboundAddress[] = []
      let resolveError: string | undefined
      if (entry.resolve) {
        try {
          addresses = await entry.resolve()
        } catch (e) {
          // 读不到 ≠ 未配置：把原因带出去，屏上不把它画成「空」
          resolveError = errMsg(e)
        }
      } else {
        addresses = fixedAddresses(entry.endpoints)
      }
      return {
        id: entry.id,
        labelKey: entry.labelKey,
        purposeKey: entry.purposeKey,
        kind: entry.kind,
        endpoints: entry.endpoints,
        transport: entry.transport,
        configSource: entry.configSource,
        addresses,
        resolveError
      }
    })
  )
}
