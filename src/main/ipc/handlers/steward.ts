// 平台管家 IPC：健康报告/清理/VACUUM、模型推荐、安全审计、故障诊断、数据健康度
import { IPC } from '../../../shared/types'
import { healthService } from '../../health/health'
import { recommendModels } from '../../steward/model-recommend'
import { runAudit, runDiagnose } from '../../steward/diagnose'
import { getDataHealthReport } from '../../steward/data-health'
import { cleanOrphans, deduplicate, reindexDocs } from '../../knowledge/kb-health'
import { idSchema } from '../../../shared/schemas/providers'
import { safeHandle, argsSchema } from '../safe-handle'

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
  safeHandle(IPC.DATA_HEALTH_GET, () => getDataHealthReport())
  // KB 数据健康修复动作（探测只读走 DATA_HEALTH_GET 的 kb.integrity）
  safeHandle(IPC.DATA_HEALTH_KB_CLEAN, () => cleanOrphans())
  safeHandle(IPC.DATA_HEALTH_KB_DEDUP, (_e, keepDocId: string) => deduplicate(keepDocId), argsSchema(idSchema))
  safeHandle(IPC.DATA_HEALTH_KB_REINDEX, (_e, docIds: string[]) => reindexDocs(docIds), argsSchema(idSchema.array()))
}
