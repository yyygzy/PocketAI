// 远程技能「目录包」安装（在线技能从单文件扩展到 SKILL.md + references/scripts/assets）。
//
// 信任边界：registry 条目给一个 manifest URL，清单列出入口与各资源文件。所有文件都从
// **清单同源**拉取（防清单把下载引到别的 host 绕过 registry 的信任面），逐文件走 safeFetch
// （SSRF / IP pin / 重定向逐跳校验 / 5MB 上限），下载到临时目录后复用 skill-files 的落盘链。
//
// 体积预检在下载前：清单声明的 size 超限就整体拒绝，不先下载再截断；下载时仍按实际字节复核，
// 清单撒谎（少报 size）也会被 readBody 的 maxBytes 与这里的二次校验挡住。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { errMsg } from '../error'
import { safeFetch } from '../net/safe-fetch'
import {
  SKILL_DIR_MAX_DEPTH,
  SKILL_DIR_MAX_FILES,
  SKILL_DIR_TOTAL_LIMIT_BYTES,
  SKILL_FILE_READ_LIMIT_BYTES
} from './skill-files'

const MANIFEST_FORMAT = 'pocketai-skill-dir'
const MANIFEST_VERSION = 1
/** 清单文本上限（与 skill-io 的单次远程拉取同一档） */
export const SKILL_MANIFEST_MAX_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 15_000

export interface SkillDirFile {
  /** 相对清单所在目录的路径，形如 references/x.md */
  path: string
  /** 声明字节数，可选；用于下载前预检 */
  size?: number
  /** sha256 / md5，可选；有就逐文件校验 */
  hash?: string
}

export interface SkillDirManifest {
  format: string
  version: number
  entry: string
  files: SkillDirFile[]
}

export interface DownloadedSkillDir {
  /** 入口 SKILL.md 原文 */
  entryText: string
  /** 供 installSkillFiles 的资源文件（不含入口） */
  files: Array<{ rel: string; abs: string; size: number }>
  /** 临时目录，安装结束后由调用方清理 */
  tempDir: string
  /** 声明没有 hash 的文件数（界面据此提示"未逐文件校验"） */
  unverified: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 清单里的相对路径校验（纯函数）：只收目录内普通相对路径。
 * 拒绝对路径、盘符、反斜杠、NUL、`..` 段、超过深度上限；与 resolveSkillFilePath 同一口径，
 * 但这里在下载前就拒，避免把恶意路径的资源 Download 到临时盘。
 */
export function safeManifestRel(rel: unknown): string | null {
  if (typeof rel !== 'string') return null
  const s = rel.trim()
  if (!s || s.includes('\0') || s.includes('\\') || s.includes(':')) return null
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  const parts = s.split('/')
  if (parts.length > SKILL_DIR_MAX_DEPTH) return null
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return parts.join('/')
}

/** 解析清单文本。格式/版本/入口/file 形状任一不合法即整体拒绝 */
export function parseSkillDirManifest(text: string): { ok: true; manifest: SkillDirManifest } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '技能目录清单不是合法 JSON' }
  }
  if (!isRecord(parsed)) return { ok: false, error: '技能目录清单不是对象' }
  if (parsed.format !== MANIFEST_FORMAT) return { ok: false, error: '技能目录清单格式不支持' }
  if (parsed.version !== MANIFEST_VERSION) return { ok: false, error: '技能目录清单版本不支持' }
  const entry = safeManifestRel(parsed.entry)
  if (!entry) return { ok: false, error: '技能目录清单的入口路径不合法' }
  if (!Array.isArray(parsed.files)) return { ok: false, error: '技能目录清单缺少 files' }
  if (parsed.files.length > SKILL_DIR_MAX_FILES) return { ok: false, error: 'TOO_MANY_FILES' }

  const files: SkillDirFile[] = []
  let total = 0
  let entryFound = false
  for (const raw of parsed.files) {
    if (!isRecord(raw)) return { ok: false, error: '技能目录清单里有非法文件条目' }
    const rel = safeManifestRel(raw.path)
    if (!rel) return { ok: false, error: `非法文件路径: ${String(raw.path ?? '')}` }
    if (files.some((f) => f.path === rel)) return { ok: false, error: `重复文件路径: ${rel}` }
    const size = typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0 ? raw.size : undefined
    if (size !== undefined && size > SKILL_FILE_READ_LIMIT_BYTES) return { ok: false, error: 'FILE_TOO_LARGE' }
    total += size ?? 0
    if (total > SKILL_DIR_TOTAL_LIMIT_BYTES) return { ok: false, error: 'DIR_TOO_LARGE' }
    const hash = typeof raw.hash === 'string' && /^(sha256|md5):[0-9a-f]{32,64}$/i.test(raw.hash.trim())
      ? raw.hash.trim()
      : undefined
    files.push({ path: rel, size, hash })
    if (rel === entry) entryFound = true
  }
  if (!entryFound) return { ok: false, error: '技能目录清单里没有入口文件 SKILL.md' }
  return { ok: true, manifest: { format: MANIFEST_FORMAT, version: MANIFEST_VERSION, entry, files } }
}

/** 校验下载字节与清单 hash（sha256/md5），三态与单文件安装一致 */
function verifyBytes(body: Buffer, expected?: string): { state: 'ok' | 'absent' | 'mismatch'; error?: string } {
  if (!expected) return { state: 'absent' }
  const [algo, hex] = expected.split(':')
  if (!algo || !hex) return { state: 'absent' }
  const actual = createHash(algo === 'md5' ? 'md5' : 'sha256').update(body).digest('hex')
  if (actual.toLowerCase() !== hex.toLowerCase()) {
    return { state: 'mismatch', error: `文件校验失败（${expected}）` }
  }
  return { state: 'ok' }
}

/**
 * 拉取并落临时盘。返回可供 installSkillFiles 直接消费的文件列表；失败时清理临时目录。
 * manifestUrl 必须是 http(s)（safeFetch 会做协议与 DNS 校验）；每个文件 URL 必须与清单同源。
 */
export async function downloadSkillDir(manifestUrl: string, manifest: SkillDirManifest): Promise<
  { ok: true; result: DownloadedSkillDir } | { ok: false; error: string }
> {
  let base: URL
  try {
    base = new URL(manifestUrl)
  } catch {
    return { ok: false, error: '清单 URL 不合法' }
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-skill-dir-'))
  const cleanup = () => { try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响主流程 */ } }
  try {
    const files: Array<{ rel: string; abs: string; size: number }> = []
    let entryText = ''
    let unverified = 0
    let total = 0
    for (const f of manifest.files) {
      const target = new URL(f.path, base)
      if (target.origin !== base.origin) {
        cleanup()
        return { ok: false, error: `资源文件与清单不同源，已拒绝: ${f.path}` }
      }
      const res = await safeFetch(target.toString(), {
        maxBytes: SKILL_FILE_READ_LIMIT_BYTES,
        timeoutMs: FETCH_TIMEOUT_MS,
        useProxy: true
      })
      if (res.status >= 300) {
        cleanup()
        return { ok: false, error: `下载资源失败（HTTP ${res.status}）: ${f.path}` }
      }
      // 清单 size / 总量两道预检只是提前拒；这里按实际字节再判一次，防少报
      if (res.body.byteLength > SKILL_FILE_READ_LIMIT_BYTES) {
        cleanup()
        return { ok: false, error: 'FILE_TOO_LARGE' }
      }
      total += res.body.byteLength
      if (total > SKILL_DIR_TOTAL_LIMIT_BYTES) {
        cleanup()
        return { ok: false, error: 'DIR_TOO_LARGE' }
      }
      const v = verifyBytes(res.body, f.hash)
      if (v.state === 'mismatch') {
        cleanup()
        return { ok: false, error: `${f.path}: ${v.error}` }
      }
      if (v.state === 'absent') unverified += 1
      const abs = path.join(tempDir, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, res.body)
      if (f.path === manifest.entry) {
        entryText = res.body.toString('utf8')
      } else {
        files.push({ rel: f.path, abs, size: res.body.byteLength })
      }
    }
    if (!entryText.trim()) {
      cleanup()
      return { ok: false, error: '入口技能文件为空' }
    }
    return { ok: true, result: { entryText, files, tempDir, unverified } }
  } catch (e) {
    cleanup()
    return { ok: false, error: errMsg(e) }
  }
}
