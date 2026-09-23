// 备份 IPC：本地备份（明文/加密）、WebDAV 配置与备份管理、定时计划
import path from 'node:path'
import { ipcMain } from 'electron'
import { IPC, type WebDAVConfig as WebDAVConfigInput } from '../../../shared/types'
import { getBackupSchedule, setBackupSchedule, noteManualBackup } from '../../backup/backup-scheduler'
import { DATA_DIR } from '../../portable'
import { errMsg } from '../safe-handle'

export function registerBackupHandlers(): void {
  ipcMain.handle(IPC.BACKUP_LOCAL, async () => {
    const { createLocalBackup } = await import('../../backup/backup-service')
    const dir = path.join(DATA_DIR, 'backups')
    return createLocalBackup(dir)
  })
  ipcMain.handle(IPC.BACKUP_LOCAL_ENCRYPTED, async () => {
    const { createEncryptedLocalBackup } = await import('../../backup/backup-service')
    const dir = path.join(DATA_DIR, 'backups')
    try {
      return { ok: true as const, ...(await createEncryptedLocalBackup(dir)) }
    } catch (e) {
      // none 模式等场景：不产出固定密钥假加密包，返回可读错误由 UI 提示
      return { ok: false as const, error: errMsg(e, '加密备份失败') }
    }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_SAVE_CONFIG, async (_e, cfg: WebDAVConfigInput) => {
    const { saveWebDAVConfig } = await import('../../backup/backup-service')
    saveWebDAVConfig(cfg)
    return { ok: true }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_LOAD_CONFIG, async () => {
    const { loadWebDAVConfig } = await import('../../backup/backup-service')
    return loadWebDAVConfig()
  })
  ipcMain.handle(IPC.BACKUP_SCHEDULE_GET, () => getBackupSchedule())
  ipcMain.handle(
    IPC.BACKUP_SCHEDULE_SET,
    (_e, patch: { enabled?: boolean; intervalHours?: number }) =>
      setBackupSchedule(patch ?? {})
  )
  ipcMain.handle(IPC.BACKUP_WEBDAV_TEST, async (_e, cfg: WebDAVConfigInput) => {
    const { testWebDAV } = await import('../../backup/backup-service')
    return testWebDAV(cfg)
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_UPLOAD, async () => {
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
  ipcMain.handle(IPC.BACKUP_WEBDAV_UPLOAD_INCREMENTAL, async () => {
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
  ipcMain.handle(IPC.BACKUP_WEBDAV_LIST, async () => {
    const { loadWebDAVConfig, listWebDAVBackups } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return []
    try { return await listWebDAVBackups(cfg) } catch { return [] }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_RESTORE, async (_e, filename: string) => {
    const {
      loadWebDAVConfig,
      restoreFromWebDAV,
      restoreIncrementalFromWebDAV
    } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    // 按文件名前缀路由：pocketai-inc-* 走增量索引恢复，其余走全量 zip 恢复
    if (filename.startsWith('pocketai-inc-')) {
      try {
        return await restoreIncrementalFromWebDAV(cfg, filename)
      } catch (e) {
        return { ok: false, error: errMsg(e, '增量恢复失败') }
      }
    }
    return restoreFromWebDAV(cfg, filename)
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_DELETE, async (_e, filename: string) => {
    const { loadWebDAVConfig, deleteWebDAVBackup } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    await deleteWebDAVBackup(cfg, filename)
    return { ok: true }
  })
}
