// 平台管家 IPC：健康报告/清理/VACUUM、模型推荐、安全审计、故障诊断、数据健康度
import fs from 'node:fs'
import { BrowserWindow, dialog, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../../../shared/types'
import { DATA_DIR } from '../../portable'
import { healthService } from '../../health/health'
import { recommendModels } from '../../steward/model-recommend'
import { runAudit, runDiagnose } from '../../steward/diagnose'
import { getDataHealthReport } from '../../steward/data-health'
import { clearBrowserHttpCache } from '../../steward/cache-clean'
import { computeLocalJudgements } from '../../steward/local-judgement'
import { recordPerf } from '../../steward/perf-probe'
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
  safeHandle(IPC.DATA_HEALTH_GET, (_e, refresh?: boolean) => getDataHealthReport({ refresh: !!refresh }))
  // 「浏览器缓存」那一格旁边的跳转：不接收任何路径入参（要开的就是数据目录本身），
  // shell.openPath 成功返回空串、非空就是错误文本 ⇒ 失败要如实报，不许静默"看起来点了没反应"。
  safeHandle(IPC.DATA_HEALTH_OPEN_DIR, async () => {
    const err = await shell.openPath(DATA_DIR)
    return err ? { ok: false as const, error: err } : { ok: true as const }
  })
  // 清 HTTP 缓存（V4-Iter-189）：与上一条同处「浏览器缓存」那一格，同样**不接收任何路径入参**；
  // 只调 session.clearCache()（Chromium 自己淘汰），失败原样回报——不许把没做成的清理画成释放了空间。
  safeHandle(IPC.DATA_HEALTH_CLEAR_CACHE, () => clearBrowserHttpCache())
  // 本机判据屏（V4-Iter-146）：现采一次显存是**异步**的，这条通道因此是 async；
  // 失败不降级成空报告——空报告会与"这台机器真的采不到"混成一回事（safeHandle 把失败转成
  // {ok:false,error} 返回值，渲染层按 hasIpcFailed 判，不许把失败画成数据）。
  safeHandle(IPC.LOCAL_JUDGEMENT_GET, async () => computeLocalJudgements())
  // KB 数据健康修复动作（探测只读走 DATA_HEALTH_GET 的 kb.integrity）
  safeHandle(IPC.DATA_HEALTH_KB_CLEAN, () => cleanOrphans())
  safeHandle(IPC.DATA_HEALTH_KB_DEDUP, (_e, keepDocId: string) => deduplicate(keepDocId), argsSchema(idSchema))
  safeHandle(IPC.DATA_HEALTH_KB_REINDEX, (_e, docIds: string[]) => reindexDocs(docIds), argsSchema(idSchema.array()))
  // 渲染端性能事件上报（longtask observer）：限长 schema + 环形缓冲天然防灌爆
  safeHandle(
    IPC.PERF_EVENT,
    (_e, payload: { label: string; ms: number }) => {
      recordPerf(payload.label, payload.ms)
    },
    argsSchema(z.object({ label: z.string().min(1).max(64), ms: z.number().finite().min(0).max(3_600_000) }))
  )
}
