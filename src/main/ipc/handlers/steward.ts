// 平台管家 IPC：健康报告/清理/VACUUM、模型推荐、安全审计、故障诊断
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import { healthService } from '../../health/health'
import { recommendModels } from '../../steward/model-recommend'
import { runAudit, runDiagnose } from '../../steward/diagnose'
import { safeHandle } from '../safe-handle'

export function registerStewardHandlers(): void {
  ipcMain.handle(IPC.HEALTH_REPORT, () => healthService.report())
  ipcMain.handle(IPC.HEALTH_CLEANUP, () => healthService.cleanup())
  ipcMain.handle(IPC.HEALTH_VACUUM, () => healthService.vacuum())
  safeHandle(IPC.STEWARD_MODEL_RECOMMEND, async () => ({
    ok: true as const,
    data: await recommendModels()
  }))
  safeHandle(IPC.STEWARD_AUDIT, () => ({ ok: true as const, data: runAudit() }))
  safeHandle(IPC.STEWARD_DIAGNOSE, () => ({ ok: true as const, data: runDiagnose() }))
}
