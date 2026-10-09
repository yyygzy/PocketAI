// 备份 IPC：本地备份（明文/加密）、本地恢复、WebDAV 配置与备份管理、定时计划
import path from 'node:path'
import { dialog, BrowserWindow } from 'electron'
import { IPC, type WebDAVConfig as WebDAVConfigInput, type MergeStrategy } from '../../../shared/types'
import { getBackupSchedule, setBackupSchedule, noteManualBackup } from '../../backup/backup-scheduler'
import { DATA_DIR } from '../../portable'
import { safeHandle, errMsg, argsSchema } from '../safe-handle'
import {
  webdavConfigSchema,
  backupSchedulePatchSchema,
  backupFilenameSchema,
  mergeExecutePayloadSchema,
  backupRestoreArgsSchema
} from '../../../shared/schemas/backup'
import { z } from 'zod'
import { issuePathToken, peekPathToken, dropPathToken } from '../dialog-path-token'
import { isNoneMode, newSecretKeys, NONE_MODE_HINT } from '../../crypto/none-mode-gate'

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
    const { saveWebDAVConfig, loadWebDAVConfig } = await import('../../backup/backup-service')
    // B2：备份口令是真正保护备份包的密钥，none 模式下只会用公开可复现的固定密钥混淆 → 拒绝新值。
    // 与已存口令一致（UI 空着口令框只改地址/目录）照常保存；加密模式切换流程直连 service，不经此闸。
    const prev = loadWebDAVConfig()?.passwordCipher ?? ''
    if (isNoneMode() && newSecretKeys({ pwd: cfg.passwordCipher }, { pwd: prev }).length > 0) {
      return {
        ok: false as const,
        error: `未设置主密码，备份口令不会被保存（它决定加密备份包能否被解开）。${NONE_MODE_HINT}`
      }
    }
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
    (_e, patch: { enabled?: boolean; intervalHours?: number; retentionCount?: number }) =>
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
  // 本地恢复（SEC-6）：文件路径只能来自本进程对话框签发的令牌——
  // 此前渲染端可直接回传绝对路径跳过选择器，注入一次即可用任意文件整库替换。
  safeHandle(IPC.BACKUP_LOCAL_RESTORE, async (e, payload?: { restoreToken?: string; backupPassword?: string }) => {
    const { restoreFromLocalFile } = await import('../../backup/backup-service')
    let token = typeof payload?.restoreToken === 'string' ? payload.restoreToken : ''
    let filePath = peekPathToken(token)
    if (!filePath) {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
      if (!win) return { ok: false, error: '窗口不可用' }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [
          { name: 'PocketAI 备份（zip / enc.zip）', extensions: ['zip'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (canceled || !filePaths?.length) return { ok: true, canceled: true }
      filePath = filePaths[0]!
      token = issuePathToken(filePath)
    }
    try {
      const r = await restoreFromLocalFile(filePath, { backupPassword: payload?.backupPassword || undefined })
      if (r.ok) {
        dropPathToken(token)
        return r
      }
      // 需密码/密码错误：同一份文件留给下次重试，只回令牌与文件名（不回路径）
      if (r.code) return { ...r, restoreToken: token, fileName: path.basename(filePath) }
      dropPathToken(token)
      return r
    } catch (e) {
      dropPathToken(token)
      return { ok: false, error: errMsg(e, '本地恢复失败') }
    }
  }, argsSchema(backupRestoreArgsSchema))

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
  safeHandle(IPC.BACKUP_WEBDAV_MERGE_SCAN, async (_e, filename: unknown, backupPassword?: unknown) => {
    const { scanMergeConflicts } = await import('../../backup/merge-service')
    const { loadWebDAVConfig } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV', tables: [], attachmentsToAdd: 0 }
    const fn = backupFilenameSchema.parse(filename)
    const pwd = z.string().min(1).nullish().parse(backupPassword ?? null) ?? undefined
    try {
      return await scanMergeConflicts(cfg, fn, { backupPassword: pwd })
    } catch (e) {
      return { ok: false, error: errMsg(e, '扫描冲突失败'), tables: [], attachmentsToAdd: 0 }
    }
  })
  safeHandle(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, async (_e, payload: { filename: string; strategy: MergeStrategy; backupPassword?: string }) => {
    const { executeMerge } = await import('../../backup/merge-service')
    const { loadWebDAVConfig } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      return await executeMerge(cfg, payload.filename, payload.strategy, {
        backupPassword: payload.backupPassword || undefined
      })
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
