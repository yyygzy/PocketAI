// 技能（Skill）管理与技能市场 IPC
import { BrowserWindow } from 'electron'
import { IPC } from '../../../shared/types'
import type { SkillRecord } from '../../../shared/types'
import { skillRepo } from '../../db/repositories/skill.repo'
import { exportSkill, importSkill } from '../../skills/skill-io'
import { syncBuiltinSkills } from '../../assistant/builtin'
import { validateSkillText, SKILL_TEMPLATES } from '../../skills/skill-parser'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { skillSaveSchema } from '../../../shared/schemas/skills'
import { idSchema } from '../../../shared/schemas/providers'

export function registerSkillHandlers(): void {
  safeHandle(IPC.SKILL_LIST, () => skillRepo.list())
  safeHandle(IPC.SKILL_GET, (_e, id: string) => skillRepo.get(id), argsSchema(idSchema))
  safeHandle(IPC.SKILL_SAVE, (_e, record: Partial<SkillRecord> & { name: string }) =>
    skillRepo.save(record),
  argsSchema(skillSaveSchema))
  safeHandle(IPC.SKILL_DELETE, (_e, id: string) => {
    skillRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))

  // 技能市场：导出/导入（文件对话框在主进程弹出）
  safeHandle(IPC.SKILL_EXPORT, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    return exportSkill(win, id)
  }, argsSchema(idSchema))
  safeHandle(IPC.SKILL_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    return importSkill(win)
  })
  safeHandle(IPC.SKILL_SYNC, () => {
    return syncBuiltinSkills()
  })
  safeHandle(IPC.SKILL_FETCH_INDEX, async (_e, indexUrl: string) => {
    const { fetchRegistryIndex } = await import('../../skills/skill-io')
    const res = await fetchRegistryIndex(indexUrl)
    if (!res.ok || !res.text) return { ok: false, error: res.error ?? '拉取失败', skills: [] }
    const { parseRegistryIndex } = await import('../../skills/skill-parser')
    const { skills, error } = parseRegistryIndex(res.text)
    if (error) return { ok: false, error, skills: [] }
    return { ok: true, skills }
  }, argsSchema(z.string().url('索引 URL 不合法')))
  safeHandle(IPC.SKILL_IMPORT_URL, async (_e, url: string) => {
    const { importSkillFromUrl } = await import('../../skills/skill-io')
    return importSkillFromUrl(url)
  }, argsSchema(z.string().url('URL 不合法')))

  // SDK：技能校验 + 模板
  safeHandle(IPC.SKILL_VALIDATE, (_e, text: string) => validateSkillText(text), argsSchema(z.string()))
  safeHandle(IPC.SKILL_TEMPLATES, () => SKILL_TEMPLATES)
}
