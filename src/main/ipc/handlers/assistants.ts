// 自建助手 IPC（含免费版数量门控）
import { dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../../shared/types'
import type { AssistantListScope, AssistantRecord, DuplicatedAssistant } from '../../../shared/types'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { kbRepo } from '../../db/repositories/kb.repo'
import { skillRepo } from '../../db/repositories/skill.repo'
import { assertCanCreateAssistant } from '../../license/license'
import { safeHandle, argsSchema } from '../safe-handle'
import { assistantSaveSchema, booleanSchema, optionalStringSchema, assistantImportSchema } from '../../../shared/schemas/assistants'
import { idSchema } from '../../../shared/schemas/providers'
import { safeFileName } from '../../../shared/export-markdown'
import {
  buildAssistantExportPayload,
  resolveAssistantImportItem
} from '../../../shared/assistant-port'
import { errMsg } from '../../error'
import { issuePathToken, peekPathToken, dropPathToken } from '../dialog-path-token'

/** 已启用的内置助手 id 列表：只存 app_config KV，不碰 assistants 表（内置行每次启动会被 upsert 覆盖） */
const ENABLED_BUILTIN_IDS_KEY = 'assistants.enabled_builtin_ids'

function readEnabledBuiltinIds(): string[] {
  const raw = appConfigRepo.get(ENABLED_BUILTIN_IDS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** 读时清理悬空 id（内置助手行被删/被覆盖成不存在）：幂等且不需要额外启动钩子 */
function enabledBuiltinIds(): string[] {
  const ids = [...new Set(readEnabledBuiltinIds())]
  const builtinIds = new Set(assistantRepo.list().filter((a) => a.isBuiltin).map((a) => a.id))
  const kept = ids.filter((id) => builtinIds.has(id))
  if (kept.length !== ids.length) appConfigRepo.set(ENABLED_BUILTIN_IDS_KEY, JSON.stringify(kept))
  return kept
}

export function registerAssistantHandlers(): void {
  safeHandle(IPC.ASSISTANT_LIST, (_e, rawScope?: unknown) => {
    const scope: AssistantListScope = rawScope === 'mine' || rawScope === 'market' ? rawScope : 'all'
    const all = assistantRepo.list()
    const enabled = new Set(enabledBuiltinIds())
    const withFlag = (a: AssistantRecord): AssistantRecord => (a.isBuiltin ? { ...a, enabled: enabled.has(a.id) } : a)
    if (scope === 'mine') return all.filter((a) => !a.isBuiltin || enabled.has(a.id)).map(withFlag)
    if (scope === 'market') return all.filter((a) => a.isBuiltin).map(withFlag)
    return all.map(withFlag)
  })
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
  safeHandle(IPC.ASSISTANT_DUPLICATE, (_e, id: string, displayName?: string): DuplicatedAssistant => {
    assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    const src = assistantRepo.get(id)
    if (!src) throw new Error('助手不存在')
    // 复制前过滤已失效的引用：宁可明确告诉用户丢了几项，也不要静默少能力
    const validSkills = new Set(skillRepo.list().map((s) => s.id))
    const validKbs = new Set(kbRepo.list().map((k) => k.id))
    const keptSkills = src.skillIds.filter((x) => validSkills.has(x))
    const keptKbs = src.knowledgeBaseIds.filter((x) => validKbs.has(x))
    const copy = assistantRepo.duplicate(id, displayName, { skillIds: keptSkills, knowledgeBaseIds: keptKbs })
    return { ...copy, droppedSkills: src.skillIds.length - keptSkills.length, droppedKb: src.knowledgeBaseIds.length - keptKbs.length }
  }, argsSchema(idSchema, optionalStringSchema))
  safeHandle(IPC.ASSISTANT_SET_PINNED, (_e, id: string, pinned: boolean) => {
    assistantRepo.setPinned(id, pinned)
    return { ok: true }
  }, argsSchema(idSchema, booleanSchema))
  safeHandle(IPC.ASSISTANT_SET_ENABLED, (_e, id: string, enabled: boolean) => {
    const target = assistantRepo.get(id)
    if (!target || !target.isBuiltin) return { ok: false, error: '只能启用或停用内置助手' }
    const ids = enabledBuiltinIds()
    const has = ids.includes(id)
    if (enabled && !has) appConfigRepo.set(ENABLED_BUILTIN_IDS_KEY, JSON.stringify([...ids, id]))
    else if (!enabled && has) appConfigRepo.set(ENABLED_BUILTIN_IDS_KEY, JSON.stringify(ids.filter((x) => x !== id)))
    return { ok: true, enabled }
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

  // ---------- 导入：showOpenDialog → 逐条解析 → 同名需确认后覆盖（kb/skill 跨机失效过滤）----------
  //
  // 两段式（SEC-3 + SEC-6 同一手法）：首次调用只检测冲突，并把**主进程对话框选中的路径**
  // 换成一次性令牌签发（dialog-path-token）；用户确认后第二次调用带该令牌，路径只在主进程解析。
  // 渲染端传不进路径，也传不进「我已确认」之外的语义。
  safeHandle(IPC.ASSISTANT_IMPORT, async (e, opts?: { confirmToken?: string }) => {
    const confirmToken = typeof opts?.confirmToken === 'string' ? opts.confirmToken : ''
    let filePath: string | null = null
    if (confirmToken) {
      filePath = peekPathToken(confirmToken)
      // 令牌失效不回落成「重新弹框再静默覆盖」——那等于绕过用户的确认动作
      if (!filePath) return { ok: false, error: '确认已过期，请重新选择文件导入' }
    } else {
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
      filePath = filePaths[0]
    }
    const confirming = confirmToken.length > 0

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return { ok: false, error: '文件不是有效的 JSON' }
    }
    const topLevel = assistantImportSchema.safeParse(parsed)
    if (!topLevel.success) return { ok: false, error: '格式不正确：缺少 assistants 数组' }

    const kbIds = new Set(kbRepo.list().map((k) => k.id))
    const skillIds = new Set(skillRepo.list().map((s) => s.id))
    // 同名覆盖：按 name 查现有非内置助手；命中内置助手则跳过（不可编辑）
    const byName = new Map(assistantRepo.list().map((a) => [a.name, a]))

    const items: Array<{ resolved: NonNullable<ReturnType<typeof resolveAssistantImportItem>>; existing?: AssistantRecord }> = []
    let skipped = 0
    for (const raw of topLevel.data.assistants) {
      const resolved = resolveAssistantImportItem(raw, kbIds, skillIds)
      if (!resolved) {
        skipped++
        continue
      }
      items.push({ resolved, existing: byName.get(resolved.draft.name) })
    }

    const conflicts = items
      .filter((it) => it.existing && !it.existing.isBuiltin)
      .map((it) => it.resolved.draft.name)
    if (conflicts.length > 0 && !confirming) {
      const token = issuePathToken(filePath)
      return {
        ok: true as const,
        needsConfirm: true as const,
        conflicts,
        confirmToken: token,
        skipped,
        droppedTools: items.reduce((n, it) => n + it.resolved.droppedTools, 0)
      }
    }

    let imported = 0
    let overwritten = 0
    let droppedKb = 0
    let droppedSkills = 0
    let droppedTools = 0
    for (const { resolved, existing } of items) {
      droppedKb += resolved.droppedKb
      droppedSkills += resolved.droppedSkills
      droppedTools += resolved.droppedTools
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
        if (existing && confirming) {
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
    dropPathToken(confirmToken)
    return { ok: true, imported, overwritten, skipped, droppedKb, droppedSkills, droppedTools }
  })
}
