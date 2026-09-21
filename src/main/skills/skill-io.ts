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
import { skillRepo } from '../db/repositories/skill.repo'
import type { SkillRecord } from '../../shared/types'
import { parseSkillText, type SkillShape } from './skill-parser'
import { safeFetch } from '../net/safe-fetch'

/** 导入文件大小上限（技能本质是文本，256KB 足够宽裕） */
const MAX_IMPORT_BYTES = 256 * 1024
/** 远程拉取额外宽松一点（registry index 可能长一点） */
const MAX_REMOTE_BYTES = 512 * 1024

const FILE_FILTERS = [
  { name: '墨匣技能（JSON / Markdown）', extensions: ['json', 'md'] }
]

/** 导出文件名净化：截断 40 字符并去除文件系统非法字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'skill'
}

/** 把 SkillShape 保存为自定义技能（不传 id → 自动生成 UUID；isBuiltin=false） */
function saveShapeAsSkill(shape: SkillShape): SkillRecord {
  return skillRepo.save({
    name: shape.name,
    description: shape.description,
    icon: shape.icon,
    content: shape.content,
    enabled: true
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
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

    const file = filePaths[0]
    const stat = fs.statSync(file)
    if (stat.size > MAX_IMPORT_BYTES) return { ok: false, error: 'FILE_TOO_LARGE' }

    const raw = fs.readFileSync(file, 'utf8')
    const { shape, error } = parseSkillText(raw)
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
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
      const msg = e instanceof Error ? e.message : String(e)
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
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
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}
