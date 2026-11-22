// 技能导入/导出（V2 批次五：技能市场 + SKILL.md + 在线商店）
//
// 设计要点：
//  - 导出格式 { format:'pocketai-skill', version:1, exportedAt, skill:{name,description,icon,content} }；
//  - 导入永远重新生成 id（skillRepo.save 不传 id），isBuiltin 强制 false——
//    即便导入文件携带内置技能的 id/标记，也不会覆盖内置技能；
//  - 支持 .json + .md（Markdown + 可选 YAML frontmatter）；
//  - 远程 URL 导入走 safeFetch（SSRF 防护），支持 JSON 和 Markdown 两种格式；
//  - 文件对话框由主进程弹出，渲染端只拿结果不接触文件路径。
import fs from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { errMsg } from '../error'
import { createLogger } from '../logger'
import { skillRepo } from '../db/repositories/skill.repo'
import {
  skillImportAuditRepo,
  type SkillImportSource
} from '../db/repositories/skill-import-audit.repo'

const log = createLogger('skill-io')
import type { SkillRecord } from '../../shared/types'
import { parseSkillText, type SkillShape } from './skill-parser'
import { buildSkillExportPayload, verifySkillPackage } from './skill-package'
import { safeUrlForDisplay, scanSkill, type SkillScanResult } from './skill-scan'
import { installSkillFiles, readSkillFolder, rollbackSkillFiles } from './skill-files'
import { safeFetch } from '../net/safe-fetch'
import { downloadSkillDir, parseSkillDirManifest, SKILL_MANIFEST_MAX_BYTES, type DownloadedSkillDir } from './skill-remote-dir'
import { skillShapeSchema } from '../../shared/schemas/skills'
import {
  GITHUB_NOT_FOUND_TEXT,
  GITHUB_RATE_LIMIT_TEXT,
  githubHttpErrorText,
  githubIndexCandidates,
  githubNetworkErrorText,
  githubRequestHeaders,
  githubSkillCandidates,
  verifyContentHash
} from './github-contents'

/** 导入文件大小上限（技能本质是文本，256KB 足够宽裕） */
const MAX_IMPORT_BYTES = 256 * 1024
/** 远程拉取额外宽松一点（registry index 可能长一点） */
const MAX_REMOTE_BYTES = 512 * 1024

type RemoteFetchResult =
  | { ok: true; body: Buffer }
  | { ok: false; kind: 'http'; status: number; error: string }
  | { ok: false; kind: 'network'; error: string }

/** 走 safeFetch 拉远程文本；GitHub 域名附带 raw Accept，错误统一转成用户可读文案 */
async function fetchRemote(url: string): Promise<RemoteFetchResult> {
  const headers = githubRequestHeaders(url)
  try {
    const res = await safeFetch(
      url,
      headers
        ? { maxBytes: MAX_REMOTE_BYTES, timeoutMs: 15_000, headers, useProxy: true }
        : { maxBytes: MAX_REMOTE_BYTES, timeoutMs: 15_000, useProxy: true }
    )
    if (res.status >= 300) {
      return { ok: false, kind: 'http', status: res.status, error: githubHttpErrorText(res.status) }
    }
    return { ok: true, body: res.body }
  } catch (e) {
    return { ok: false, kind: 'network', error: githubNetworkErrorText(e) }
  }
}

/** 多候选地址都失败时，优先暴露限流/不存在这类明确诊断，其次用最后一次错误 */
function pickRegistryError(errors: string[]): string {
  if (errors.includes(GITHUB_RATE_LIMIT_TEXT)) return GITHUB_RATE_LIMIT_TEXT
  if (errors.includes(GITHUB_NOT_FOUND_TEXT)) return GITHUB_NOT_FOUND_TEXT
  return errors[errors.length - 1] ?? '拉取失败'
}

const FILE_FILTERS = [
  { name: '墨匣技能（JSON / Markdown）', extensions: ['json', 'md'] }
]

/** 导出文件名净化：截断 40 字符并去除文件系统非法字符 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'skill'
}

/**
 * 把 SkillShape 保存为自定义技能（不传 id → 自动生成 UUID；isBuiltin=false）。
 * `resident` 不给就是 true——导入的默认形状必须等于今天的行为，按需档是用户/超长逼出来的例外。
 */
export function saveShapeAsSkill(shape: SkillShape, opts: { resident?: boolean } = {}): SkillRecord {
  skillShapeSchema.parse(shape)
  return skillRepo.save({
    name: shape.name,
    description: shape.description,
    icon: shape.icon,
    content: shape.content,
    category: shape.category ?? '',
    tags: shape.tags ?? [],
    enabled: true,
    resident: opts.resident ?? true
  })
}

/** 导入审计是旁路：仓储内部 fail-open，这里只负责把三个入口的字段摆齐 */
function auditImported(
  skill: SkillRecord,
  source: SkillImportSource,
  sourceDetail: string,
  scan: SkillScanResult
): void {
  skillImportAuditRepo.insert({
    skillId: skill.id,
    skillName: skill.name,
    source,
    sourceDetail,
    scan
  })
}

/** 导出单个技能为 JSON 文件（用户选择保存位置） */
export async function exportSkill(
  win: BrowserWindow,
  id: string
): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> {
  try {
    const skill = skillRepo.get(String(id ?? ''))
    if (!skill) return { ok: false, error: '技能不存在' }

    // 校验和由 skill-package 统一算：只在有值时写 category/tags（旧文件形状不变），
    // 哈希仍按归一口径（空 category=''／空 tags=[]）计算，读回来能对上。
    const payload = buildSkillExportPayload(skill)

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `技能-${safeFileName(skill.name)}.json`,
      filters: FILE_FILTERS
    })
    if (canceled || !filePath) return { ok: true, canceled: true }

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 4), 'utf8')
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 从本地文件导入技能（.json 或 .md 自动检测） */
export async function importSkill(
  win: BrowserWindow
): Promise<{
  ok: boolean
  canceled?: boolean
  skill?: SkillRecord
  nameDuplicated?: boolean
  /** 装前静态扫描结果（候选与事实，不是安全判定；界面下一轮再用） */
  scan?: SkillScanResult
  /** verified＝包内校验和一致；absent＝没有校验和（旧包/Markdown），已放行但未校验完整性 */
  checksum?: 'verified' | 'absent'
  /** 上游声明的许可证（如 MIT），仅导入时告知，不入库 */
  license?: string
  error?: string
}> {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: FILE_FILTERS
    })
    if (canceled || filePaths.length === 0) return { ok: true, canceled: true }

    const file = filePaths[0]!
    const stat = fs.statSync(file)
    if (stat.size > MAX_IMPORT_BYTES) return { ok: false, error: 'FILE_TOO_LARGE' }

    const raw = fs.readFileSync(file, 'utf8')
    // 完整性先于解析：校验和不一致时连形状都不该信（内容可能整段被换掉）
    const verification = verifySkillPackage(raw)
    if (verification.state === 'mismatch') return { ok: false, error: 'CHECKSUM_MISMATCH' }
    if (verification.state === 'unsupported') return { ok: false, error: 'CHECKSUM_UNSUPPORTED' }

    const { shape, error, ignoredKeys } = parseSkillText(raw)
    if (!shape) {
      // 兼容旧格式：非标准 pocketai-skill 的 JSON 也给个明确错误
      if (error === '缺少 name 字段' || error === '缺少 content 字段') {
        return { ok: false, error: 'MISSING_FIELDS' }
      }
      if (error === 'JSON 解析失败') return { ok: false, error: 'PARSE_FAILED' }
      return { ok: false, error }
    }

    const nameDuplicated = skillRepo.list().some((s) => s.name === shape.name)
    // 落库前先扫：扫描是纯函数，不碰文件系统，也不改变导入判定
    const scan = scanSkill({ content: shape.content, ignoredKeys })
    const skill = saveShapeAsSkill(shape)
    auditImported(skill, 'file', path.basename(file), scan)
    return { ok: true, skill, nameDuplicated, scan, license: shape.license, checksum: verification.state === 'ok' ? 'verified' : 'absent' }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/**
 * 目录导入（§236 第三层的地基）：选一个含 `SKILL.md` 的目录，正文进 content 那一列，
 * `scripts／references／assets` 复制成 `<DATA_DIR>/skills/<新技能 id>/` 下的一份**快照**。
 *
 * 三条不是随手定的口径：
 *  · 复制而不是引用原路径——技能要被 `load_skill` 按 id 读，指着用户机器上随时会动的目录就等于不可复现；
 *  · 正文超常驻上限（8KB）**不判失败，降成按需**并在返回里说为什么——一份 12KB 的上游技能本来就是按需形状；
 *  · 资源装不进去时把这份技能删干净（不留半份）：技能在列表里、文件不在，`load_skill` 只会一直报"没这条文件"。
 */
export async function importSkillFolder(win: BrowserWindow): Promise<{
  ok: boolean
  canceled?: boolean
  skill?: SkillRecord
  copied?: string[]
  skipped?: Array<{ path: string; reason: string }>
  ignoredKeys?: string[]
  /** 正文超常驻上限被降成按需的那一句（界面据此解释为什么开关是关的） */
  forcedOnDemand?: boolean
  nameDuplicated?: boolean
  /** 装前静态扫描结果（正文 + 随包资源清单 + 白名单外声明字段） */
  scan?: SkillScanResult
  /** 上游声明的许可证（如 MIT），仅导入时告知，不入库 */
  license?: string
  error?: string
}> {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择技能目录（需含 SKILL.md）'
    })
    if (canceled || filePaths.length === 0) return { ok: true, canceled: true }

    const read = readSkillFolder(filePaths[0]!)
    if (read.error) return { ok: false, error: read.error }
    if (Buffer.byteLength(read.entryText, 'utf8') > MAX_IMPORT_BYTES) {
      return { ok: false, error: 'ENTRY_TOO_LARGE' }
    }

    // 先按常驻档试，超了再按按需档收：这两道都读 validate 的同一份上限，不在界面重抄数字
    const residentTry = parseSkillText(read.entryText, true)
    const useResident = residentTry.shape !== null
    const parsed = useResident ? residentTry : parseSkillText(read.entryText, false)
    const shape = parsed.shape
    if (!shape) {
      // 按需档还装不下才是真失败；把两次尝试里更"接近能装"的那句报出来
      return { ok: false, error: parsed.error || residentTry.error }
    }

    const scan = scanSkill({
      content: shape.content,
      resources: read.files.map((f) => ({ path: f.rel, size: f.size })),
      ignoredKeys: parsed.ignoredKeys
    })
    const skill = saveShapeAsSkill(shape, { resident: useResident })
    let copied: string[] = []
    let skipped = read.skipped
    try {
      const inst = installSkillFiles(skill.id, read.files)
      copied = inst.copied
      skipped = read.skipped.concat(inst.skipped)
    } catch (e) {
      const cleanup = rollbackSkillFiles(skill.id)
      try {
        skillRepo.delete(skill.id)
      } catch (deleteErr) {
        // 文件回滚做成了、库里那条删不掉 ⇒ 留下的正是上面那条注释明令不许的形状：列表里有这条、
        // 它自带的文件不在，`load_skill` 只会一直报"没这条文件"。渲染层认不出光秃秃的原文（一律折叠成
        // 「导入失败」），所以这一张脸要自己的回码，界面才有机会说"列表里会留下一条打不开的记录"。
        log.warn(`技能资源已回滚、记录删不掉（列表里会留下打不开的这条 ${skill.id}）:`, errMsg(deleteErr))
        return { ok: false, error: 'SKILL_ROW_RESIDUE' }
      }
      return { ok: false, error: cleanup ? `${errMsg(e)}；残留清理也失败：${cleanup}` : errMsg(e) }
    }
    const nameDuplicated = skillRepo.list().some((s) => s.name === shape.name && s.id !== skill.id)
    auditImported(skill, 'folder', path.basename(filePaths[0]!), scan)
    return {
      ok: true,
      skill,
      copied,
      skipped,
      ignoredKeys: parsed.ignoredKeys,
      forcedOnDemand: !useResident,
      nameDuplicated,
      license: shape.license,
      scan
    }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/**
 * 从远程「目录包」导入技能：清单 URL → 逐文件同源抓取 → 复用目录导入的解析/扫描/落库/回滚。
 * manifestUrl 由 registry 条目的 manifest 字段提供，调用方（handler）把它透传过来。
 */
export async function importSkillDirFromManifest(
  manifestUrl: string,
  publisherPublicKey?: string
): Promise<{
  ok: boolean
  skill?: SkillRecord
  scan?: SkillScanResult
  copied?: string[]
  skipped?: Array<{ path: string; reason: string }>
  ignoredKeys?: string[]
  forcedOnDemand?: boolean
  unverified?: number
  /** 上游声明的许可证（如 MIT），仅导入时告知，不入库 */
  license?: string
  /** 清单签名是否验过（发布者身份可信） */
  signatureVerified?: boolean
  error?: string
}> {
  let downloaded: DownloadedSkillDir | null = null
  try {
    // 清单本身也走 safeFetch（同源任何 host，但受 SSRF/IP pin/5MB 约束）
    const candidates = githubIndexCandidates(manifestUrl)
    let manifestRes: { ok: true; text: string } | { ok: false; error: string } = { ok: false, error: '拉取失败' }
    const errors: string[] = []
    for (const url of candidates) {
      const res = await fetchRemote(url)
      if (res.ok) {
        if (res.body.byteLength > SKILL_MANIFEST_MAX_BYTES) {
          return { ok: false, error: '技能目录清单过大' }
        }
        manifestRes = { ok: true, text: res.body.toString('utf8') }
        break
      }
      errors.push(res.error)
    }
    if (!manifestRes.ok) return { ok: false, error: pickRegistryError(errors) }

    const parsedManifest = parseSkillDirManifest(manifestRes.text)
    if (!parsedManifest.ok) return { ok: false, error: parsedManifest.error }

    // 清单签名在下载资源之前验：带签名就必须验过（fail-closed），没签名则放行并在回执里标记。
    // 公钥来自 registry 索引条目，不由 manifest 自报。
    const { verifySkillDirManifestSignature } = await import('./skill-dir-trust')
    const trust = verifySkillDirManifestSignature(
      manifestRes.text,
      parsedManifest.manifest,
      publisherPublicKey
    )
    if (trust.error) return { ok: false, error: trust.error }

    const dl = await downloadSkillDir(manifestUrl, parsedManifest.manifest)
    if (!dl.ok) return { ok: false, error: dl.error }
    downloaded = dl.result

    // 与 importSkillFolder 同款两段式解析：先常驻档、超了按按需档；两档都装不下才失败
    const residentTry = parseSkillText(downloaded.entryText, true)
    const useResident = residentTry.shape !== null
    const parsed = useResident ? residentTry : parseSkillText(downloaded.entryText, false)
    const shape = parsed.shape
    if (!shape) return { ok: false, error: parsed.error || residentTry.error }

    const scan = scanSkill({
      content: shape.content,
      resources: downloaded.files.map((f) => ({ path: f.rel, size: f.size })),
      ignoredKeys: parsed.ignoredKeys
    })
    const skill = saveShapeAsSkill(shape, { resident: useResident })
    let copied: string[] = []
    let skipped: Array<{ path: string; reason: string }> = []
    try {
      const inst = installSkillFiles(skill.id, downloaded.files)
      copied = inst.copied
      skipped = inst.skipped
    } catch (e) {
      rollbackSkillFiles(skill.id)
      try {
        skillRepo.delete(skill.id)
      } catch (deleteErr) {
        log.warn(`技能资源已回滚、记录删不掉（列表里会留下打不开的这条 ${skill.id}）:`, errMsg(deleteErr))
        return { ok: false, error: 'SKILL_ROW_RESIDUE' }
      }
      return { ok: false, error: errMsg(e) }
    }
    auditImported(skill, 'url', safeUrlForDisplay(manifestUrl), scan)
    return {
      ok: true,
      skill,
      scan,
      copied,
      skipped,
      ignoredKeys: parsed.ignoredKeys,
      forcedOnDemand: !useResident,
      unverified: downloaded.unverified,
      license: shape.license,
      signatureVerified: trust.verified
    }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  } finally {
    if (downloaded) {
      try { fs.rmSync(downloaded.tempDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响导入结果 */ }
    }
  }
}

/** 从远程 URL 导入技能（safeFetch + 自动检测 JSON/Markdown） */
export async function importSkillFromUrl(
  url: string,
  expectedHash?: string
): Promise<{
  ok: boolean
  skill?: SkillRecord
  scan?: SkillScanResult
  /** verified＝包内校验和一致；absent＝没有校验和（Markdown/旧包），已放行但未校验完整性 */
  checksum?: 'verified' | 'absent'
  /** 上游声明的许可证（如 MIT），仅导入时告知，不入库 */
  license?: string
  error?: string
}> {
  try {
    if (!url || typeof url !== 'string') return { ok: false, error: 'URL 为空' }
    const { primaryUrl, fallbackUrl } = githubSkillCandidates(url)
    let res = await fetchRemote(primaryUrl)
    // API 地址映射后 404（仓库/分支/路径口径不一致）→ 回退原 raw 地址再试一次
    if (!res.ok && res.kind === 'http' && res.status === 404 && fallbackUrl) {
      res = await fetchRemote(fallbackUrl)
    }
    if (!res.ok) {
      return {
        ok: false,
        error: res.kind === 'network' ? `网络请求失败: ${res.error}` : res.error
      }
    }
    const hash = verifyContentHash(res.body, expectedHash)
    if (hash.state === 'mismatch') return { ok: false, error: hash.error }

    const text = res.body.toString('utf8')
    if (!text.trim()) return { ok: false, error: '远程内容为空' }

    // registry 的 hash 校验的是「下载到的字节」；包内 checksum 校验的是「字段」。
    // 两道是不同承诺，能同时给就给：前者证明分发没被换，后者证明字段没被改。
    const verification = verifySkillPackage(text)
    if (verification.state === 'mismatch') return { ok: false, error: 'CHECKSUM_MISMATCH' }
    if (verification.state === 'unsupported') return { ok: false, error: 'CHECKSUM_UNSUPPORTED' }

    const { shape, error, ignoredKeys } = parseSkillText(text)
    if (!shape) return { ok: false, error: `解析失败: ${error}` }

    const scan = scanSkill({ content: shape.content, ignoredKeys })
    const skill = saveShapeAsSkill(shape)
    // 来源明细只留 origin + pathname：URL 的查询串可能带令牌，审计不抄
    auditImported(skill, 'url', safeUrlForDisplay(url), scan)
    return { ok: true, skill, scan, license: shape.license, checksum: verification.state === 'ok' ? 'verified' : 'absent' }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 拉取 registry index（safeFetch + GitHub Contents API 优先、raw 兜底） */
export async function fetchRegistryIndex(
  indexUrl: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    if (!indexUrl || typeof indexUrl !== 'string') return { ok: false, error: 'URL 为空' }
    const errors: string[] = []
    for (const url of githubIndexCandidates(indexUrl)) {
      const res = await fetchRemote(url)
      if (res.ok) return { ok: true, text: res.body.toString('utf8') }
      errors.push(res.error)
    }
    return { ok: false, error: pickRegistryError(errors) }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}
