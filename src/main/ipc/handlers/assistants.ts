// 自建助手 IPC（含免费版数量门控）
import { dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../../shared/types'
import type { AssistantRecord } from '../../../shared/types'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { kbRepo } from '../../db/repositories/kb.repo'
import { skillRepo } from '../../db/repositories/skill.repo'
import { assertCanCreateAssistant } from '../../license/license'
import { safeHandle, argsSchema } from '../safe-handle'
import { assistantSaveSchema, booleanSchema, assistantImportSchema } from '../../../shared/schemas/assistants'
import { idSchema } from '../../../shared/schemas/providers'
import { safeFileName } from '../../../shared/export-markdown'
import {
  buildAssistantExportPayload,
  resolveAssistantImportItem
} from '../../../shared/assistant-port'
import { errMsg } from '../../error'

export function registerAssistantHandlers(): void {
  safeHandle(IPC.ASSISTANT_LIST, () => assistantRepo.list())
  safeHandle(IPC.ASSISTANT_GET, (_e, id: string) => assistantRepo.get(id), argsSchema(idSchema))
  safeHandle(IPC.ASSISTANT_SAVE, (_e, record: Partial<AssistantRecord> & { name: string }) => {
    // License 门控：免费版限制自建助手数量（新建/复制场景；内置助手不计）
    if (!record.id || !assistantRepo.get(record.id)) {
      assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    }
    return assistantRepo.save(record)
  }, argsSchema(assistantSaveSchema))
  safeHandle(IPC.ASSISTANT_DELETE, (_e, id: string) => {
    assistantRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.ASSISTANT_DUPLICATE, (_e, id: string) => {
    assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    return assistantRepo.duplicate(id)
  }, argsSchema(idSchema))
  safeHandle(IPC.ASSISTANT_SET_PINNED, (_e, id: string, pinned: boolean) => {
    assistantRepo.setPinned(id, pinned)
    return { ok: true }
  }, argsSchema(idSchema, booleanSchema))

  // ---------- 导出：全量用户助手（非内置）→ JSON → showSaveDialog ----------
  safeHandle(IPC.ASSISTANT_EXPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName('assistants')}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }
    const payload = buildAssistantExportPayload(assistantRepo.list())
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: filePath, count: payload.assistants.length }
  })

  // ---------- 导入：showOpenDialog → 逐条解析 → 同名覆盖（kb/skill 跨机失效过滤）----------
  safeHandle(IPC.ASSISTANT_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths[0]) return { ok: true, canceled: true }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
    } catch {
      return { ok: false, error: '文件不是有效的 JSON' }
    }
    const topLevel = assistantImportSchema.safeParse(parsed)
    if (!topLevel.success) return { ok: false, error: '格式不正确：缺少 assistants 数组' }

    const kbIds = new Set(kbRepo.list().map((k) => k.id))
    const skillIds = new Set(skillRepo.list().map((s) => s.id))
    // 同名覆盖：按 name 查现有非内置助手；命中内置助手则跳过（不可编辑）
    const byName = new Map(assistantRepo.list().map((a) => [a.name, a]))

    let imported = 0
    let overwritten = 0
    let skipped = 0
    let droppedKb = 0
    let droppedSkills = 0
    for (const raw of topLevel.data.assistants) {
      const resolved = resolveAssistantImportItem(raw, kbIds, skillIds)
      if (!resolved) {
        skipped++
        continue
      }
      droppedKb += resolved.droppedKb
      droppedSkills += resolved.droppedSkills
      const existing = byName.get(resolved.draft.name)
      if (existing?.isBuiltin) {
        // 与内置助手同名：导入为新副本（改名后缀），不覆盖内置
        try {
          assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
          assistantRepo.save({ ...resolved.draft, name: `${resolved.draft.name} (导入)` })
          imported++
        } catch (err) {
          return { ok: false, error: errMsg(err, '导入失败') }
        }
        continue
      }
      try {
        if (existing) {
          assistantRepo.save({ ...resolved.draft, id: existing.id })
          overwritten++
        } else {
          assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
          assistantRepo.save(resolved.draft)
          imported++
        }
      } catch (err) {
        return { ok: false, error: errMsg(err, '导入失败') }
      }
    }
    return { ok: true, imported, overwritten, skipped, droppedKb, droppedSkills }
  })
}
