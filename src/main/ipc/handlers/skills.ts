// 技能（Skill）管理与技能市场 IPC
import { BrowserWindow } from 'electron'
import { IPC } from '../../../shared/types'
import type { SkillRecord } from '../../../shared/types'
import { skillRepo } from '../../db/repositories/skill.repo'
import { exportSkill, importSkill, importSkillFolder } from '../../skills/skill-io'
import { listSkillFiles, readSkillFile, removeSkillFiles } from '../../skills/skill-files'
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
    // §236：删技能连它自带的文件一起删（路径由 id 推出，删不掉不拦这次删除）
    const filesRemoved = removeSkillFiles(id)
    return { ok: true, filesRemoved }
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
  // §236：目录导入（SKILL.md + 资源快照）与"这条技能带了哪些文件"
  safeHandle(IPC.SKILL_IMPORT_FOLDER, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    return importSkillFolder(win)
  })
  safeHandle(IPC.SKILL_LIST_FILES, (_e, id: string) => {
    // 技能不存在时不给文件列表：那串 id 是渲染层从列表里拿的，拿不到就说明它已经不在了
    if (!skillRepo.get(String(id ?? ''))) return { ok: false, error: 'SKILL_NOT_FOUND' }
    return { ok: true, files: listSkillFiles(String(id ?? '')) }
  }, argsSchema(idSchema))
  // 阶段 4：只读预览；白名单/越界/二进制/哈希校验都在 skill-files 那一层，handler 只做接线
  safeHandle(IPC.SKILL_READ_FILE, (_e, id: string, rel: string) => {
    const skill = skillRepo.get(String(id ?? ''))
    if (!skill) return { ok: false, error: 'SKILL_NOT_FOUND' }
    try {
      const file = readSkillFile(skill.id, String(rel ?? ''))
      return { ok: true, file }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, argsSchema(idSchema, z.string().min(1).max(512)))
  // 阶段 1：版本历史与回滚。内置技能没有版本历史（内容锁定），只读空列表；回滚也拒绝内置。
  safeHandle(IPC.SKILL_LIST_VERSIONS, (_e, id: string) => {
    const skill = skillRepo.get(String(id ?? ''))
    if (!skill) return { ok: false, error: 'SKILL_NOT_FOUND' }
    return { ok: true, versions: skill.isBuiltin ? [] : skillRepo.listVersions(skill.id) }
  }, argsSchema(idSchema))
  safeHandle(IPC.SKILL_ROLLBACK, (_e, id: string, versionId: string) => {
    const skill = skillRepo.get(String(id ?? ''))
    if (!skill) return { ok: false, error: 'SKILL_NOT_FOUND' }
    if (skill.isBuiltin) return { ok: false, error: 'BUILTIN_SKILL_LOCKED' }
    const restored = skillRepo.rollbackTo(skill.id, String(versionId ?? ''))
    return restored ? { ok: true, skill: restored } : { ok: false, error: 'VERSION_NOT_FOUND' }
  }, argsSchema(idSchema, z.string().min(1).max(64)))

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
  safeHandle(IPC.SKILL_IMPORT_URL, async (_e, url: string, expectedHash: string) => {
    const { importSkillFromUrl } = await import('../../skills/skill-io')
    return importSkillFromUrl(url, expectedHash)
  }, argsSchema(z.string().url('URL 不合法'), z.string().max(128)))
  safeHandle(IPC.SKILL_IMPORT_DIR, async (_e, manifestUrl: string, publicKey?: string) => {
    const { importSkillDirFromManifest } = await import('../../skills/skill-io')
    return importSkillDirFromManifest(manifestUrl, publicKey ?? '')
  }, argsSchema(z.string().url('清单 URL 不合法'), z.string().max(4096).optional()))

  // SDK：技能校验 + 模板
  safeHandle(IPC.SKILL_VALIDATE, (_e, text: string) => validateSkillText(text), argsSchema(z.string()))
  safeHandle(IPC.SKILL_TEMPLATES, () => SKILL_TEMPLATES)
}
