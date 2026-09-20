// 技能导入/导出（V2 批次五：技能市场）
//
// 设计要点：
//  - 导出格式 { format:'pocketai-skill', version:1, exportedAt, skill:{name,description,icon,content} }；
//  - 导入永远重新生成 id（skillRepo.save 不传 id），isBuiltin 强制 false——
//    即便导入文件携带内置技能的 id/标记，也不会覆盖内置技能；
//  - 文件对话框由主进程弹出，渲染端只拿结果不接触文件路径。
import fs from 'node:fs'
import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { skillRepo } from '../db/repositories/skill.repo'
import type { SkillRecord } from '../../shared/types'

/** 导入文件大小上限（技能本质是文本，256KB 足够宽裕） */
const MAX_IMPORT_BYTES = 256 * 1024

const FILE_FILTERS = [{ name: 'PocketAI 技能', extensions: ['json'] }]

/** 导出文件名净化：截断 40 字符并去除文件系统非法字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'skill'
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

/** 从 JSON 文件导入技能（结构校验 + id 隔离） */
export async function importSkill(
  win: BrowserWindow
): Promise<{
  ok: boolean
  canceled?: boolean
  skill?: SkillRecord
  /** 是否与已有技能同名（允许并存，仅提示用户） */
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

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { ok: false, error: 'PARSE_FAILED' }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'PARSE_FAILED' }

    const obj = parsed as Record<string, unknown>
    // 格式标记不匹配：明确拒绝（防止把任意 JSON 当技能导入）
    if (obj.format !== 'pocketai-skill') return { ok: false, error: 'NOT_SKILL_FILE' }

    const raw = (obj.skill ?? {}) as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const content = typeof raw.content === 'string' ? raw.content.trim() : ''
    if (!name || !content) return { ok: false, error: 'MISSING_FIELDS' }

    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    const icon = typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim().slice(0, 4) : '⚡'

    // 同名检测（不阻断：导入始终生成独立副本，仅把信号回传渲染端提示）
    const nameDuplicated = skillRepo.list().some((s) => s.name === name)

    // 不传 id → skillRepo.save 重新生成 randomUUID；isBuiltin 强制 false
    const skill = skillRepo.save({ name, description, icon, content, enabled: true })
    return { ok: true, skill, nameDuplicated }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
