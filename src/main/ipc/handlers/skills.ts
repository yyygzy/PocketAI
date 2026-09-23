// 技能（Skill）管理与技能市场 IPC
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../../shared/types'
import type { SkillRecord } from '../../../shared/types'
import { skillRepo } from '../../db/repositories/skill.repo'
import { exportSkill, importSkill } from '../../skills/skill-io'
import { syncBuiltinSkills } from '../../assistant/builtin'
import { validateSkillText, SKILL_TEMPLATES } from '../../skills/skill-parser'

export function registerSkillHandlers(): void {
  ipcMain.handle(IPC.SKILL_LIST, () => skillRepo.list())
  ipcMain.handle(IPC.SKILL_GET, (_e, id: string) => skillRepo.get(id))
  ipcMain.handle(IPC.SKILL_SAVE, (_e, record: Partial<SkillRecord> & { name: string }) =>
    skillRepo.save(record)
  )
  ipcMain.handle(IPC.SKILL_DELETE, (_e, id: string) => {
    skillRepo.delete(id)
    return { ok: true }
  })

  // 技能市场：导出/导入（文件对话框在主进程弹出）
  ipcMain.handle(IPC.SKILL_EXPORT, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return exportSkill(win!, id)
  })
  ipcMain.handle(IPC.SKILL_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return importSkill(win!)
  })
  ipcMain.handle(IPC.SKILL_SYNC, () => {
    return syncBuiltinSkills()
  })
  ipcMain.handle(IPC.SKILL_FETCH_INDEX, async (_e, indexUrl: string) => {
    const { fetchRegistryIndex } = await import('../../skills/skill-io')
    const res = await fetchRegistryIndex(indexUrl)
    if (!res.ok || !res.text) return { ok: false, error: res.error ?? '拉取失败', skills: [] }
    const { parseRegistryIndex } = await import('../../skills/skill-parser')
    const { skills, error } = parseRegistryIndex(res.text)
    if (error) return { ok: false, error, skills: [] }
    return { ok: true, skills }
  })
  ipcMain.handle(IPC.SKILL_IMPORT_URL, async (_e, url: string) => {
    const { importSkillFromUrl } = await import('../../skills/skill-io')
    return importSkillFromUrl(url)
  })

  // SDK：技能校验 + 模板
  ipcMain.handle(IPC.SKILL_VALIDATE, (_e, text: string) => validateSkillText(text))
  ipcMain.handle(IPC.SKILL_TEMPLATES, () => SKILL_TEMPLATES)
}
