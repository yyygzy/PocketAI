// 备份 IPC：本地备份（明文/加密）、WebDAV 配置与备份管理、定时计划
import path from 'node:path'
import { IPC, type WebDAVConfig as WebDAVConfigInput, type MergeStrategy } from '../../../shared/types'
import { getBackupSchedule, setBackupSchedule, noteManualBackup } from '../../backup/backup-scheduler'
import { DATA_DIR } from '../../portable'
import { safeHandle, errMsg, argsSchema } from '../safe-handle'
import {
  webdavConfigSchema,
  backupSchedulePatchSchema,
  backupFilenameSchema,
  mergeExecutePayloadSchema
} from '../../../shared/schemas/backup'
import { z } from 'zod'

export function registerBackupHandlers(): void {
  safeHandle(IPC.BACKUP_LOCAL, async () => {
    const { createLocalBackup } = await import('../../backup/backup-service')
    const dir = path.join(DATA_DIR, 'backups')
    return createLocalBackup(dir)
  })
  safeHandle(IPC.BACKUP_LOCAL_ENCRYPTED, async () => {
    const { createEncryptedLocalBackup } = await import('../../backup/backup-service')
    const dir = path.join(DATA_DIR, 'backups')
    try {
      return { ok: true as const, ...(await createEncryptedLocalBackup(dir)) }
    } catch (e) {
      // none 模式等场景：不产出固定密钥假加密包，返回可读错误由 UI 提示
      return { ok: false as const, error: errMsg(e, '加密备份失败') }
    }
  })
  safeHandle(IPC.BACKUP_WEBDAV_SAVE_CONFIG, async (_e, cfg: WebDAVConfigInput) => {
    const { saveWebDAVConfig } = await import('../../backup/backup-service')
    saveWebDAVConfig(cfg)
    return { ok: true }
  }, argsSchema(webdavConfigSchema))
  safeHandle(IPC.BACKUP_WEBDAV_LOAD_CONFIG, async () => {
    const { loadWebDAVConfig } = await import('../../backup/backup-service')
    return loadWebDAVConfig()
  })
  safeHandle(IPC.BACKUP_SCHEDULE_GET, () => getBackupSchedule())
  safeHandle(
    IPC.BACKUP_SCHEDULE_SET,
    (_e, patch: { enabled?: boolean; intervalHours?: number }) =>
      setBackupSchedule(patch ?? {}),
    argsSchema(backupSchedulePatchSchema)
  )
  safeHandle(IPC.BACKUP_WEBDAV_TEST, async (_e, cfg: WebDAVConfigInput) => {
    const { testWebDAV } = await import('../../backup/backup-service')
    return testWebDAV(cfg)
  }, argsSchema(webdavConfigSchema))
  safeHandle(IPC.BACKUP_WEBDAV_UPLOAD, async () => {
    const { loadWebDAVConfig, createWebDAVBackup } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      const r = await createWebDAVBackup(cfg)
      noteManualBackup() // 手动上传后刷新定时备份计时
      return r
    } catch (e) {
      return { ok: false, error: errMsg(e, '上传失败') }
    }
  })
  safeHandle(IPC.BACKUP_WEBDAV_UPLOAD_INCREMENTAL, async () => {
    const { loadWebDAVConfig, createWebDAVIncrementalBackup } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      const r = await createWebDAVIncrementalBackup(cfg)
      noteManualBackup() // 手动备份同样刷新定时备份计时
      return { ok: true, ...r }
    } catch (e) {
      return { ok: false, error: errMsg(e, '增量备份失败') }
    }
  })
  safeHandle(IPC.BACKUP_WEBDAV_LIST, async () => {
    const { loadWebDAVConfig, listWebDAVBackups } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return []
    try { return await listWebDAVBackups(cfg) } catch { return [] }
  })
  safeHandle(IPC.BACKUP_WEBDAV_RESTORE, async (_e, filename: unknown, backupPassword?: unknown) => {
    const {
      loadWebDAVConfig,
      restoreFromWebDAV,
      restoreIncrementalFromWebDAV
    } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    const fn = backupFilenameSchema.parse(filename)
    // 异机恢复密码：空串/缺省视为未提供；不做空值以外的格式约束（主密码可含任意字符）
    const pwd = z.string().min(1).nullish().parse(backupPassword ?? null) ?? undefined
    // 按文件名前缀路由：pocketai-inc-* 走增量索引恢复，其余走全量 zip 恢复
    if (fn.startsWith('pocketai-inc-')) {
      try {
        return await restoreIncrementalFromWebDAV(cfg, fn, { backupPassword: pwd })
      } catch (e) {
        return { ok: false, error: errMsg(e, '增量恢复失败') }
      }
    }
    return restoreFromWebDAV(cfg, fn, { backupPassword: pwd })
  })
  safeHandle(IPC.BACKUP_WEBDAV_MERGE_SCAN, async (_e, filename: string) => {
    const { scanMergeConflicts } = await import('../../backup/merge-service')
    const { loadWebDAVConfig } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV', tables: [], attachmentsToAdd: 0 }
    try {
      return await scanMergeConflicts(cfg, filename)
    } catch (e) {
      return { ok: false, error: errMsg(e, '扫描冲突失败'), tables: [], attachmentsToAdd: 0 }
    }
  }, argsSchema(backupFilenameSchema))
  safeHandle(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, async (_e, payload: { filename: string; strategy: MergeStrategy }) => {
    const { executeMerge } = await import('../../backup/merge-service')
    const { loadWebDAVConfig } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      return await executeMerge(cfg, payload.filename, payload.strategy)
    } catch (e) {
      return { ok: false, error: errMsg(e, '合并失败') }
    }
  }, argsSchema(mergeExecutePayloadSchema))
  safeHandle(IPC.BACKUP_WEBDAV_DELETE, async (_e, filename: string) => {
    const { loadWebDAVConfig, deleteWebDAVBackup } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    await deleteWebDAVBackup(cfg, filename)
    return { ok: true }
  }, argsSchema(backupFilenameSchema))
}
