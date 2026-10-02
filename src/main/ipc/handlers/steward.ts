// 平台管家 IPC：健康报告/清理/VACUUM、模型推荐、安全审计、故障诊断、数据健康度
import fs from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { IPC } from '../../../shared/types'
import { healthService } from '../../health/health'
import { recommendModels } from '../../steward/model-recommend'
import { runAudit, runDiagnose } from '../../steward/diagnose'
import { getDataHealthReport } from '../../steward/data-health'
import { cleanOrphans, deduplicate, reindexDocs } from '../../knowledge/kb-health'
import { idSchema } from '../../../shared/schemas/providers'
import { safeHandle, argsSchema } from '../safe-handle'

/** 报告文本上限（渲染端拼装的纯文本远小于此，仅做防灌爆） */
const REPORT_MAX_CHARS = 200_000

/** 默认文件名时间戳 YYYYMMDD-HHmm */
function reportTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function registerStewardHandlers(): void {
  safeHandle(IPC.HEALTH_REPORT, () => healthService.report())
  safeHandle(IPC.HEALTH_CLEANUP, () => healthService.cleanup())
  safeHandle(IPC.HEALTH_VACUUM, () => healthService.vacuum())
  safeHandle(IPC.STEWARD_MODEL_RECOMMEND, async () => ({
    ok: true as const,
    data: await recommendModels()
  }))
  safeHandle(IPC.STEWARD_AUDIT, () => ({ ok: true as const, data: runAudit() }))
  safeHandle(IPC.STEWARD_DIAGNOSE, () => ({ ok: true as const, data: runDiagnose() }))
  // 诊断报告导出：渲染端拼装纯文本 → 主进程弹保存框落盘（远程求助场景）
  safeHandle(
    IPC.STEWARD_EXPORT_REPORT,
    async (e, args: { content: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
      if (!win) return { ok: false as const, error: '窗口不可用' }
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: `pocketai-report-${reportTimestamp()}.txt`,
        filters: [
          { name: '文本文件', extensions: ['txt'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (canceled || !filePath) return { ok: true as const, canceled: true as const }
      fs.writeFileSync(filePath, args.content, 'utf8')
      return { ok: true as const, path: filePath }
    },
    argsSchema(z.object({ content: z.string().min(1).max(REPORT_MAX_CHARS) }))
  )
  safeHandle(IPC.DATA_HEALTH_GET, () => getDataHealthReport())
  // KB 数据健康修复动作（探测只读走 DATA_HEALTH_GET 的 kb.integrity）
  safeHandle(IPC.DATA_HEALTH_KB_CLEAN, () => cleanOrphans())
  safeHandle(IPC.DATA_HEALTH_KB_DEDUP, (_e, keepDocId: string) => deduplicate(keepDocId), argsSchema(idSchema))
  safeHandle(IPC.DATA_HEALTH_KB_REINDEX, (_e, docIds: string[]) => reindexDocs(docIds), argsSchema(idSchema.array()))
}
