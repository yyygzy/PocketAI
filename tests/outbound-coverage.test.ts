// 出网清单覆盖测试（2c-2 验收关键）
//
// 扫 src/main 下出现出网调用点的源文件，逐个断言已登记在 OUTBOUND_ENTRIES[*].files。
// 新增一个 `fetch(...)` / `safeFetch(...)` / `new WebSocket(...)` / `autoUpdater` /
// WebDAV 客户端调用点而不登记，这里会直接变红——这是防止「手写名单很快过期」的回归钩子。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  OUTBOUND_ENTRIES,
  OUTBOUND_SCAN_EXEMPT_FILES,
  outboundRegisteredFiles
} from '../src/main/net/outbound-registry'

const MAIN_ROOT = path.resolve(__dirname, '..', 'src', 'main')

/** 出网调用点识别规则（与注册表说明一致；webdav 包在本仓库是动态 import('webdav')） */
const OUTBOUND_CALL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'safeFetch(', re: /\bsafeFetch\s*\(/ },
  { name: 'new WebDAVClient', re: /new\s+WebDAVClient\b/ },
  { name: 'from webdav', re: /from\s+'webdav'|import\('webdav'\)/ },
  { name: 'autoUpdater', re: /\bautoUpdater\b/ },
  { name: 'new WebSocket', re: /new\s+WebSocket\b/ }
]

/** 剥块注释与行注释：注释里提到 `fetch(` 不算调用点 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line.replace(/(?<!:)\s\/\/[^"]*$/, '')))
    .join('\n')
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
})
