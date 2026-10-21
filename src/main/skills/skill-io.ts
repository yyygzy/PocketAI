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
import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { errMsg } from '../error'
import { skillRepo } from '../db/repositories/skill.repo'
import type { SkillRecord } from '../../shared/types'
import { parseSkillText, type SkillShape } from './skill-parser'
import { installSkillFiles, readSkillFolder, rollbackSkillFiles } from './skill-files'
import { safeFetch } from '../net/safe-fetch'
import { skillShapeSchema } from '../../shared/schemas/skills'

/** 导入文件大小上限（技能本质是文本，256KB 足够宽裕） */
const MAX_IMPORT_BYTES = 256 * 1024
/** 远程拉取额外宽松一点（registry index 可能长一点） */
const MAX_REMOTE_BYTES = 512 * 1024

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
    enabled: true,
    resident: opts.resident ?? true
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

    const payload = {
      format: 'pocketai-skill',
      version: 1,
      exportedAt: new Date().toISOString(),
      skill: {
        name: skill.name,
        description: skill.description,
        icon: skill.icon,
        content: skill.content
      }
    }

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
    const { shape, error } = parseSkillText(raw)
    // （解析签名多了一个 ignoredKeys，这里不解构它：单文件导入本来就没有资源，未知键只在目录导入里报）
    if (!shape) {
      // 兼容旧格式：非标准 pocketai-skill 的 JSON 也给个明确错误
      if (error === '缺少 name 字段' || error === '缺少 content 字段') {
        return { ok: false, error: 'MISSING_FIELDS' }
      }
      if (error === 'JSON 解析失败') return { ok: false, error: 'PARSE_FAILED' }
      return { ok: false, error }
    }

    const nameDuplicated = skillRepo.list().some((s) => s.name === shape.name)
    const skill = saveShapeAsSkill(shape)
    return { ok: true, skill, nameDuplicated }
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

    const skill = saveShapeAsSkill(shape, { resident: useResident })
    let copied: string[] = []
    let skipped = read.skipped
    try {
      const inst = installSkillFiles(skill.id, read.files)
      copied = inst.copied
      skipped = read.skipped.concat(inst.skipped)
    } catch (e) {
      const cleanup = rollbackSkillFiles(skill.id)
      skillRepo.delete(skill.id)
      return { ok: false, error: cleanup ? `${errMsg(e)}；残留清理也失败：${cleanup}` : errMsg(e) }
    }
    const nameDuplicated = skillRepo.list().some((s) => s.name === shape.name && s.id !== skill.id)
    return {
      ok: true,
      skill,
      copied,
      skipped,
      ignoredKeys: parsed.ignoredKeys,
      forcedOnDemand: !useResident,
      nameDuplicated
    }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 从远程 URL 导入技能（safeFetch + 自动检测 JSON/Markdown） */
export async function importSkillFromUrl(
  url: string
): Promise<{ ok: boolean; skill?: SkillRecord; error?: string }> {
  try {
    if (!url || typeof url !== 'string') return { ok: false, error: 'URL 为空' }
    let res
    try {
      res = await safeFetch(url, { maxBytes: MAX_REMOTE_BYTES, timeoutMs: 15_000 })
    } catch (e) {
      const msg = errMsg(e)
      return { ok: false, error: `网络请求失败: ${msg}` }
    }
    if (res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const text = res.body.toString('utf8')
    if (!text.trim()) return { ok: false, error: '远程内容为空' }

    const { shape, error } = parseSkillText(text)
    if (!shape) return { ok: false, error: `解析失败: ${error}` }

    const skill = saveShapeAsSkill(shape)
    return { ok: true, skill }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 拉取 registry index（safeFetch） */
export async function fetchRegistryIndex(
  indexUrl: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const res = await safeFetch(indexUrl, { maxBytes: MAX_REMOTE_BYTES, timeoutMs: 15_000 })
    if (res.status >= 300) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, text: res.body.toString('utf8') }
  } catch (e) {
    const msg = errMsg(e)
    return { ok: false, error: msg }
  }
}
