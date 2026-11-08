// GitHub Contents API 适配（在线技能索引 / 技能文件）
//
// 背景：raw.githubusercontent.com 在部分网络会被直接重置，而 api.github.com 可达。
// 本模块只做纯函数适配：地址映射、请求头、错误文案、内容 hash 校验。
// 网络请求仍由 skill-io 统一走 safeFetch（SSRF 校验 + 钉 IP + 字节上限），
// 因此这里不出现 safeFetch 调用。
import { createHash } from 'node:crypto'
import { errMsg } from '../error'

/** GitHub 固定口径：用 raw 媒体类型拿原文件，避免 base64 包装 */
export const GITHUB_RAW_ACCEPT = 'application/vnd.github.raw+json'
const GITHUB_API_ORIGIN = 'https://api.github.com'
const RAW_HOST = 'raw.githubusercontent.com'
const API_HOST = 'api.github.com'

export const GITHUB_RATE_LIMIT_TEXT = 'GitHub API 限流，请稍后再试'
export const GITHUB_NOT_FOUND_TEXT = '地址或内容不存在'
const NETWORK_BLOCKED_TEXT = '网络连接中断；该网络可能屏蔽了 raw.githubusercontent.com'

function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/** raw.githubusercontent.com/{owner}/{repo}/{ref}/{path} → api.github.com/repos/.../contents/{path}?ref={ref} */
export function toContentsApiUrl(rawUrl: string): string | null {
  const u = parseHttpUrl(rawUrl)
  if (!u || u.hostname.toLowerCase() !== RAW_HOST) return null
  const segs = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
  if (segs.length < 4) return null
  const [owner, repo, ref, ...rest] = segs
  if (!owner || !repo || !ref || rest.length === 0) return null
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/contents/${rest.join('/')}?ref=${encodeURIComponent(ref)}`
}

/** api.github.com/repos/.../contents/{path}?ref={ref} → raw.githubusercontent.com/{owner}/{repo}/{ref}/{path} */
export function toRawGithubUrl(apiUrl: string): string | null {
  const u = parseHttpUrl(apiUrl)
  if (!u || u.hostname.toLowerCase() !== API_HOST) return null
  const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/)
  if (!m) return null
  const ref = u.searchParams.get('ref')
  if (!ref) return null
  const [, owner, repo, path] = m
  const encodedRef = ref
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `https://${RAW_HOST}/${owner}/${repo}/${encodedRef}/${path}`
}

/**
 * 索引请求地址：能映射到 API 时优先 API，raw 作为兜底；非 GitHub 地址原样返回。
 * 输入本身是 API 地址时，raw 由反向映射得到。
 */
export function githubIndexCandidates(indexUrl: string): string[] {
  const apiFromRaw = toContentsApiUrl(indexUrl)
  if (apiFromRaw) {
    const raw = toRawGithubUrl(apiFromRaw)
    return raw ? [apiFromRaw, raw] : [apiFromRaw]
  }
  const rawFromApi = toRawGithubUrl(indexUrl)
  if (rawFromApi) return [indexUrl, rawFromApi]
  return [indexUrl]
}

/** 技能文件请求地址：raw → API（主），raw（兜底）；非 GitHub 地址原样保留 */
export function githubSkillCandidates(url: string): {
  primaryUrl: string
  fallbackUrl: string | null
} {
  const apiFromRaw = toContentsApiUrl(url)
  if (apiFromRaw) return { primaryUrl: apiFromRaw, fallbackUrl: toRawGithubUrl(apiFromRaw) }
  const rawFromApi = toRawGithubUrl(url)
  if (rawFromApi) return { primaryUrl: url, fallbackUrl: rawFromApi }
  return { primaryUrl: url, fallbackUrl: null }
}

/** 仅 GitHub 域名附带 raw Accept；其它地址保持原样，避免影响普通静态服务器 */
export function githubRequestHeaders(url: string): Record<string, string> | undefined {
  const u = parseHttpUrl(url)
  if (!u) return undefined
  const host = u.hostname.toLowerCase()
  if (host !== API_HOST && host !== RAW_HOST) return undefined
  return { Accept: GITHUB_RAW_ACCEPT }
}

/** HTTP 状态 → 用户可读文案（不把裸错误码甩给用户） */
export function githubHttpErrorText(status: number): string {
  if (status === 403 || status === 429) return GITHUB_RATE_LIMIT_TEXT
  if (status === 404) return GITHUB_NOT_FOUND_TEXT
  return `请求失败（HTTP ${status}）`
}

/** 连接层错误 → 用户可读文案 */
export function githubNetworkErrorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (
    typeof code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
  ) {
    return NETWORK_BLOCKED_TEXT
  }
  const msg = errMsg(e)
  if (/ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|ENOTFOUND|other side closed/i.test(msg)) {
    return NETWORK_BLOCKED_TEXT
  }
  return msg
}

export type HashVerification =
  | { state: 'absent' }
  | { state: 'matched' }
  | { state: 'mismatch'; error: string }

/**
 * 内容 hash 校验：清单里给了就校验，没给就放行。
 * 支持 `sha256:` / `md5:` 前缀；无前缀时按长度推断（64=sha256、32=md5）。
 */
export function verifyContentHash(body: Buffer, expected?: string | null): HashVerification {
  const raw = (expected ?? '').trim().toLowerCase()
  if (!raw) return { state: 'absent' }

  let algo: 'sha256' | 'md5' = raw.length === 64 ? 'sha256' : 'md5'
  let value = raw
  const prefixed = raw.match(/^(sha256|md5):(.+)$/)
  if (prefixed) {
    algo = prefixed[1] as 'sha256' | 'md5'
    value = prefixed[2]!
  }

  const expectedLen = algo === 'sha256' ? 64 : 32
  if (!/^[0-9a-f]+$/.test(value) || value.length !== expectedLen) {
    return { state: 'mismatch', error: '技能 hash 格式不正确，已拒绝导入' }
  }

  const actual = createHash(algo).update(body).digest('hex')
  if (actual !== value) {
    return { state: 'mismatch', error: '技能内容校验失败（hash 不匹配）' }
  }
  return { state: 'matched' }
}
