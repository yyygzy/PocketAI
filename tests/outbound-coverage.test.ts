// 出网清单覆盖测试（2c-2 验收关键）
//
// 双向校验，防止「手写名单」漂移：
//  1. 文件级：扫 src/main 下出现出网调用点的源文件，断言已登记在 OUTBOUND_ENTRIES[*].files；
//  2. 调用点 → 清单：调用点文件里出现的 URL 必须能在清单里找到对应端点；
//  3. 清单 → 调用点：callsite 条目登记的每个端点必须真的出现在它的调用点文件里
//     （redirect / config / runtime 条目按 endpointEvidence 明确豁免，并在注册表里写清原因）。
// 只改地址不更新清单、或清单写了实际不走的地址，这里都会直接变红。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  OUTBOUND_ENTRIES,
  OUTBOUND_SCAN_EXEMPT_FILES,
  outboundRegisteredFiles
} from '../src/main/net/outbound-registry'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const MAIN_ROOT = path.resolve(__dirname, '..', 'src', 'main')
const REPO_ROOT = path.resolve(__dirname, '..')

/** 四本字典当数据读（原文是逐键字面量类型，需要字符串索引） */
const DICTS: Record<string, Record<string, string>> = {
  zh: zh as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
  ja: ja as unknown as Record<string, string>,
  ko: ko as unknown as Record<string, string>
}
const LANGS = ['zh', 'en', 'ja', 'ko']

/** 出网调用点识别规则（与注册表说明一致；webdav 包在本仓库是动态 import('webdav')） */
const OUTBOUND_CALL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'safeFetch(', re: /\bsafeFetch\s*\(/ },
  { name: 'net.request(', re: /\bnet\.request\s*\(/ },
  { name: 'https.request(', re: /\bhttps\.request\s*\(/ },
  { name: 'http.request(', re: /\bhttp\.request\s*\(/ },
  { name: 'axios', re: /\bfrom\s+'axios'|\brequire\('axios'\)|\baxios\s*\./ },
  { name: 'new WebDAVClient', re: /new\s+WebDAVClient\b/ },
  { name: 'from webdav', re: /from\s+'webdav'|import\('webdav'\)/ },
  { name: 'autoUpdater', re: /\bautoUpdater\b/ },
  { name: 'new WebSocket', re: /new\s+WebSocket\b/ }
]

/** 脚本/模板里的 URL 字面量；排除引号、括号、空白等边界字符 */
const URL_RE = /(?:https?|wss?):\/\/[^\s'"`)\]}>]+/g

/** 剥行注释与块注释：注释里提到 `fetch(` 不算调用点 */
function stripComments(src: string): string {
  // 先剥行注释，避免注释里的 URL glob（如 `api/*`）被误当成块注释起始
  return src
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line.replace(/(?<!:)\s\/\/[^"]*$/, '')))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) walk(abs)
      else if (/\.(ts|tsx)$/.test(item.name)) out.push(abs)
    }
  }
  walk(root)
  return out
}

function relToMain(abs: string): string {
  return path.relative(MAIN_ROOT, abs).replace(/\\/g, '/')
}

function matchedPatterns(src: string): string[] {
  const code = stripComments(src)
  return OUTBOUND_CALL_PATTERNS.filter((p) => p.re.test(code)).map((p) => p.name)
}

/** 当前文件里的简单字符串常量，用于还原 `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}` */
function stringConsts(src: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]*)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(src))) {
    const key = match[1]
    if (key === undefined) continue
    map.set(key, match[2] ?? '')
  }
  return map
}

/**
 * 提取代码里可能作为请求目标的 URL。
 * - 先按文件内常量还原模板串（GitHub owner/repo 这类拼接）；
 * - 还原后仍不可解析的片段（如 `http://${PORT}`）跳过，避免把模板当端点。
 */
function extractUrls(src: string): string[] {
  const consts = stringConsts(src)
  const expanded = src.replace(
    /\$\{([A-Za-z_$][\w$]*)\}/g,
    (whole, name: string) => consts.get(name) ?? whole
  )
  const urls = new Set<string>()
  for (const raw of expanded.match(URL_RE) ?? []) {
    // 模板串里仍未还原的部分（如 `${path}`）不参与比较，只保留确定的前缀
    const prefix = raw.split('${')[0] ?? ''
    if (prefix.endsWith(':')) continue
    const url = prefix.replace(/[.,;:]+$/, '')
    try {
      if (!new URL(url).hostname) continue
    } catch {
      continue
    }
    urls.add(url)
  }
  return [...urls]
}

/** 端点匹配：协议 + 主机 + 路径前缀（端点有路径时按路径段边界比较） */
function matchesEndpoint(url: string, endpoint: string): boolean {
  try {
    const u = new URL(url)
    const e = new URL(endpoint)
    if (u.protocol !== e.protocol || u.host !== e.host) return false
    const ep = e.pathname.replace(/\/+$/, '')
    if (!ep) return true
    const up = u.pathname.replace(/\/+$/, '')
    return up === ep || up.startsWith(ep + '/')
  } catch {
    return false
  }
}

/** 条目里的端点是否真的出现在它的调用点文件里 */
function endpointSeenIn(files: Array<{ rel: string; src: string }>, endpoint: string): boolean {
  if (files.some((f) => extractUrls(f.src).some((u) => matchesEndpoint(u, endpoint)))) return true
  // 环回地址常被拆成 HOST / PORT 两个常量拼接，退化为「主机 + 端口都出现」
  try {
    const e = new URL(endpoint)
    if (!e.port) return false
    return files.some((f) => f.src.includes(e.hostname) && f.src.includes(e.port))
  } catch {
    return false
  }
}

describe('出网调用点覆盖', () => {
  const scanned = sourceFiles(MAIN_ROOT)
    .map((abs) => ({ rel: relToMain(abs), src: stripComments(fs.readFileSync(abs, 'utf-8')), abs }))
    .map((f) => ({ ...f, patterns: matchedPatterns(f.src) }))
    .filter((f) => f.patterns.length > 0)
    .filter((f) => !OUTBOUND_SCAN_EXEMPT_FILES.includes(f.rel))

  it('扫描结果非空（规则本身有效）', () => {
    expect(scanned.length).toBeGreaterThan(0)
  })

  it('每个出网调用点文件都已登记在 OUTBOUND_ENTRIES[*].files', () => {
    const registered = new Set(outboundRegisteredFiles())
    const missing = scanned.filter((f) => !registered.has(f.rel)).map((f) => f.rel)
    expect(
      missing,
      `以下文件含出网调用点但未登记到 OUTBOUND_ENTRIES[*].files：\n${missing.join('\n')}`
    ).toEqual([])
  })

  it('登记的文件都存在（防止清单挂到已删除/改名的文件上）', () => {
    const missing = outboundRegisteredFiles().filter(
      (rel) => !fs.existsSync(path.join(MAIN_ROOT, rel))
    )
    expect(missing).toEqual([])
  })

  it('豁免名单只包含传输层实现文件', () => {
    expect(OUTBOUND_SCAN_EXEMPT_FILES).toEqual(['net/safe-fetch.ts'])
  })

  it('规则能识别新增调用点（探针：模拟有人新写一个 fetch）', () => {
    const probe = "const res = await fetch('https://example.com/api')\n"
    expect(matchedPatterns(probe)).toContain('fetch(')
    const probeWs = 'const ws = new WebSocket(url)\n'
    expect(matchedPatterns(probeWs)).toContain('new WebSocket')
    const probeUpdater = "import { autoUpdater } from 'electron-updater'\n"
    expect(matchedPatterns(probeUpdater)).toContain('autoUpdater')
    // 注释里的调用点不算（避免误报）
    expect(matchedPatterns('// fetch(url) 只是说明\n')).toEqual([])
  })

  it('端点双向校验能抓到 owner 错字（探针）', () => {
    const files = [
      {
        rel: 'probe.ts',
        src: "const U = 'https://github.com/real-owner/repo/releases/latest/download/a.yml'\n"
      }
    ]
    expect(endpointSeenIn(files, 'https://github.com/real-owner/repo')).toBe(true)
    expect(endpointSeenIn(files, 'https://github.com/typo-owner/repo')).toBe(false)
    expect(matchesEndpoint('https://github.com/typo-owner/repo/x', 'https://github.com/real-owner/repo')).toBe(false)
    expect(matchesEndpoint('https://api.tavily.com/search', 'https://api.tavily.com')).toBe(true)
  })

  it('每条清单都声明了 kind / transport / files，且 id 唯一', () => {
    const ids = OUTBOUND_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of OUTBOUND_ENTRIES) {
      expect(e.kind).toMatch(/^(fixed|configurable|runtime-url|local-loopback)$/)
      expect(['safeFetch', 'fetch', 'webdav', 'updater', 'websocket', 'child-process']).toContain(
        e.transport
      )
      expect(e.files.length).toBeGreaterThan(0)
      // 固定端点/配置来源必居其一（或两者都写清）
      expect(e.endpoints.length > 0 || e.configSource.trim() !== '').toBe(true)
    }
  })

  it('调用点出现的 URL 都必须在清单里（代码 → 清单）', () => {
    const allEndpoints = OUTBOUND_ENTRIES.flatMap((e) => e.endpoints)
    const missing: string[] = []
    for (const f of scanned) {
      for (const url of extractUrls(f.src)) {
        if (!allEndpoints.some((endpoint) => matchesEndpoint(url, endpoint))) {
          missing.push(`${f.rel} → ${url}`)
        }
      }
    }
    expect(
      missing,
      `以下调用点地址没有登记进出网清单（先加到对应条目的 endpoints）：\n${missing.join('\n')}`
    ).toEqual([])
  })

  it('callsite 条目登记的端点必须在调用点文件里出现（清单 → 代码）', () => {
    const byRel = new Map(scanned.map((f) => [f.rel, f]))
    const unused: string[] = []
    for (const entry of OUTBOUND_ENTRIES) {
      if ((entry.endpointEvidence ?? 'callsite') !== 'callsite') continue
      const files = entry.files
        .map((rel) => byRel.get(rel) ?? { rel, src: readMain(rel) })
        .filter((f): f is { rel: string; src: string } => Boolean(f))
      for (const endpoint of entry.endpoints) {
        if (!endpointSeenIn(files, endpoint)) unused.push(`${entry.id} → ${endpoint}`)
      }
    }
    expect(
      unused,
      `清单登记了但调用点里找不到的端点（改地址后没同步，或条目该标 redirect/config/runtime）：\n${unused.join('\n')}`
    ).toEqual([])
  })

  it('非 callsite 证据必须在 configSource 里写清原因', () => {
    const bad = OUTBOUND_ENTRIES.filter(
      (e) => e.endpointEvidence && e.endpointEvidence !== 'callsite' && !e.configSource.trim()
    ).map((e) => e.id)
    expect(bad).toEqual([])
  })

  it('发布源端点和 electron-builder publish 配置一致（挡住 owner/repo 错字）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      build?: { publish?: { provider?: string; owner?: string; repo?: string } }
    }
    const publish = pkg.build?.publish
    expect(publish?.provider).toBe('github')
    const derived = `https://github.com/${publish?.owner}/${publish?.repo}`
    for (const id of ['app-update', 'asar-patch']) {
      const entry = OUTBOUND_ENTRIES.find((e) => e.id === id)
      expect(entry?.endpoints, `${id} 的端点应与 package.json build.publish 对齐`).toContain(
        derived
      )
    }
  })

  it('能力中心默认技能索引与发布源同 owner，且为 main 分支的 index.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      build?: { publish?: { owner?: string } }
    }
    const owner = pkg.build?.publish?.owner
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'renderer', 'src', 'modules', 'skills', 'CapabilityCenter.tsx'),
      'utf-8'
    )
    const indexUrl = extractUrls(src).find((u) => u.includes('/skill-registry/'))
    expect(indexUrl).toBe(
      `https://api.github.com/repos/${owner}/skill-registry/contents/index.json?ref=main`
    )
  })

  // OutboundPanel 里那两发 `t(e.labelKey)` / `t(e.purposeKey)` 是动态 key（i18n-interpolation-361 的
  // 动态桶判不了它们，只能按"已登记的数据驱动"计数）。能登记的前提是取值域封闭且键真实存在：
  // 取值域＝本注册表的枚举，键的存在性由这条用例钉住——注册表里改错一颗 key，这里先红。
  it('labelKey / purposeKey 在四语字典里都存在（OutboundPanel 动态取词的静态依据）', () => {
    const missing: string[] = []
    for (const e of OUTBOUND_ENTRIES) {
      for (const key of [e.labelKey, e.purposeKey]) {
        for (const lang of LANGS) {
          if (!DICTS[lang]?.[key]) missing.push(`${e.id} / ${lang} 缺 ${key}`)
        }
      }
    }
    expect(missing, `注册表里有字典查不到的 key：\n${missing.join('\n')}`).toEqual([])
  })
})

function readMain(rel: string): string {
  const abs = path.join(MAIN_ROOT, rel)
  return fs.existsSync(abs) ? stripComments(fs.readFileSync(abs, 'utf-8')) : ''
}
