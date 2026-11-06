// 平台管家 IPC：健康报告/清理/VACUUM、模型推荐、安全审计、故障诊断、数据健康度
import fs from 'node:fs'
import { BrowserWindow, dialog, shell } from 'electron'
import { z } from 'zod'
import { IPC, type ApprovalAuditQuery } from '../../../shared/types'
import { DATA_DIR } from '../../portable'
import { healthService } from '../../health/health'
import { recommendModels } from '../../steward/model-recommend'
import { runAudit, runDiagnose } from '../../steward/diagnose'
import { getDataHealthReport } from '../../steward/data-health'
import { APPROVAL_AUDIT_MAX_PAGE, approvalEventRepo } from '../../db/repositories/approval-event.repo'
import { clearBrowserHttpCache } from '../../steward/cache-clean'
import { computeLocalJudgements } from '../../steward/local-judgement'
import { recordPerf } from '../../steward/perf-probe'
import { cleanOrphans, deduplicate, reindexDocs } from '../../knowledge/kb-health'
import { idSchema } from '../../../shared/schemas/providers'
import { safeHandle, argsSchema } from '../safe-handle'

/** 报告文本上限（渲染端拼装的纯文本远小于此，仅做防灌爆） */
const REPORT_MAX_CHARS = 200_000

/**
 * 审批明细屏入参（P0-2c-3）：只读查询，全部字段都收口。
 * `limit` 硬顶 100（与 repo 的 clamp 同一个常量）——这一屏不接受"一次拉全表"；
 * `from`/`to` 是毫秒时间戳（渲染端按本地日界换算），缺省即不筛。
 */
const approvalAuditQuerySchema = z.object({
  offset: z.number().int().min(0).max(1_000_000),
  limit: z.number().int().min(1).max(APPROVAL_AUDIT_MAX_PAGE),
  conversationId: z.string().min(1).max(200).optional(),
  decision: z.enum(['auto_allow', 'user_approve', 'user_deny', 'timeout_deny', 'policy_deny']).optional(),
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional()
})

/** 默认文件名时间戳 YYYYMMDD-HHmm */
function reportTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function registerStewardHandlers(): void {
  // §258：改信封——同 system.ts 那两条的理由（裸值标注挡不住 safeHandle 的解析式失败对象）
  safeHandle(IPC.HEALTH_REPORT, () => ({ ok: true as const, data: healthService.report() }))
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
  // 清空审批审计账本：显式动作、无入参；返回实际删除行数，失败按 safeHandle 原样回报。
  // 这里刻意让 clearAll() 抛错（不在 repo 里吞成 0）——用户点的就是"清干净"，静默报 0 会被读成"本来就没有"。
  safeHandle(IPC.DATA_HEALTH_CLEAR_APPROVALS, () => ({ ok: true as const, cleared: approvalEventRepo.clearAll() }))
  // 审批明细屏（P0-2c-3）：只读分页 + 组合筛选；失败由 safeHandle 转 {ok:false}，渲染端按 hasIpcFailed 判读，
  // 绝不允许把读取失败画成"没有记录"。
  safeHandle(
    IPC.APPROVALS_LIST,
    (_e, query: ApprovalAuditQuery) => approvalEventRepo.list(query),
    argsSchema(approvalAuditQuerySchema)
  )
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
