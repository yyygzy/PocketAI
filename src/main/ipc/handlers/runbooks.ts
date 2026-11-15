// P1-5：流程模板 IPC。
//
// 与助手导入导出的分工：这里不弹「同名覆盖」确认窗——同名一律作为新模板导入，
// 绝不覆盖用户已有的模板（模板是授权挂在上面的本机资产，覆盖等于悄悄替换授权对象）。
// 导入只解析一次文件；路径不进渲染层（dialog 在主进程完成）。
import { dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../../shared/types'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { writeFileAtomicSync } from '../../files/atomic-write'
import { safeFileName } from '../../../shared/export-markdown'
import {
  RUNBOOK_IMPORT_MAX,
  buildRunbookExportPayload,
  resolveRunbookImportItem
} from '../../../shared/runbook'
import { runbookRepo } from '../../db/repositories/runbook.repo'
import { toolRegistry } from '../../tools/registry'
import { checkRunbookRefs, createRunbookFromRun } from '../../runbooks/runbook-service'

const idSchema = z.string().min(1).max(64)
const createSchema = z.object({
  requestId: z.string().min(1).max(64),
  name: z.string().max(100).optional()
})
const updateSchema = z.object({
  id: idSchema,
  name: z.string().max(100).optional(),
  toolPermissions: z.array(z.string().max(200)).max(200).optional()
})

function windowOf(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
}

export function registerRunbookHandlers(): void {
  safeHandle(IPC.RUNBOOK_LIST, () => runbookRepo.list())

  safeHandle(
    IPC.RUNBOOK_CREATE_FROM_RUN,
    (_e, input: { requestId: string; name?: string }) => {
      // 一次 listAll 建 name→schema 索引：getSchema 每次都会重建整个工具面（含 MCP env 解密），
      // 按步骤逐个查会把同一份索引算几十遍
      const byName = new Map(toolRegistry.listAll().map((schema) => [schema.name, schema]))
      return createRunbookFromRun(input, {
        resolveTool: {
          // 授权 id 与模型侧工具名不是一回事（`kb.search` vs `kb_search`），只能回注册表查
          toolId: (name) => byName.get(name)?.id ?? null,
          mcpServerId: (name) => byName.get(name)?.mcpServerId ?? null
        }
      })
    },
    argsSchema(createSchema)
  )

  safeHandle(
    IPC.RUNBOOK_UPDATE,
    (_e, patch: { id: string; name?: string; toolPermissions?: string[] }) => {
      // 空名不落库：repo 的空名回落是给「只改授权」那一路用的，改名传了空串必须报错，
      // 否则界面上会出现一次「保存成功但名字没变」。
      // 重名**不在这里拦**：导入本来就允许同名并列（同名当新模板），改名沿用同一口径，
      // 由渲染端把「已有同名」提示成一次确认，而不是让改名叫不出这个名字。
      if (patch.name !== undefined && !patch.name.trim()) {
        return { ok: false as const, error: '模板名称不能为空' }
      }
      const updated = runbookRepo.update(patch.id, {
        name: patch.name,
        toolPermissions: patch.toolPermissions
      })
      if (!updated) return { ok: false as const, error: '模板不存在' }
      return updated
    },
    argsSchema(updateSchema)
  )

  safeHandle(IPC.RUNBOOK_DELETE, (_e, id: string) => ({ ok: runbookRepo.delete(id) }), argsSchema(idSchema))

  safeHandle(IPC.RUNBOOK_CHECK, (_e, id: string) => ({ missingRefs: checkRunbookRefs(id) }), argsSchema(idSchema))

  // ---------- 导出：全部模板 → JSON（不含授权） ----------
  safeHandle(IPC.RUNBOOK_EXPORT, async (e) => {
    const win = windowOf(e)
    if (!win) return { ok: false as const, error: '窗口不可用' }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName('runbooks')}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true as const, canceled: true as const }
    const payload = buildRunbookExportPayload(runbookRepo.list())
    writeFileAtomicSync(filePath, JSON.stringify(payload, null, 2))
    return { ok: true as const, path: filePath, count: payload.runbooks.length }
  })

  // ---------- 导入：JSON → 逐条解析（授权一律清空、同名当新模板） ----------
  safeHandle(IPC.RUNBOOK_IMPORT, async (e) => {
    const win = windowOf(e)
    if (!win) return { ok: false as const, error: '窗口不可用' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths[0]) return { ok: true as const, canceled: true as const }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
    } catch {
      return { ok: false as const, error: '文件不是有效的 JSON' }
    }
    const rawList =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { runbooks?: unknown }).runbooks)
        ? ((parsed as { runbooks: unknown[] }).runbooks)
        : null
    if (!rawList) return { ok: false as const, error: '格式不正确：缺少 runbooks 数组' }

    let imported = 0
    let skipped = 0
    let droppedTools = 0
    let droppedRefs = 0
    // 回传新模板 id：渲染端导入后直接跳到第一条，展开「逐项重勾授权」的确认引导。
    // 不回传的话只能靠「最近更新的一条」猜，撞上同名/同秒导入就指错人。
    const ids: string[] = []
    for (const raw of rawList.slice(0, RUNBOOK_IMPORT_MAX)) {
      const resolved = resolveRunbookImportItem(raw)
      if (!resolved) {
        skipped++
        continue
      }
      const saved = runbookRepo.insert(resolved.draft)
      ids.push(saved.id)
      imported++
      droppedTools += resolved.droppedTools
      droppedRefs += resolved.droppedRefs
    }
    return { ok: true as const, imported, skipped, droppedTools, droppedRefs, ids }
  })
}
