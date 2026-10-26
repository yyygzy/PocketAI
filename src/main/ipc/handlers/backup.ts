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
  backupRestoreArgsSchema,
  isWebdavPasswordUsable,
  WEBDAV_PASSWORD_CHARSET_MSG
} from '../../../shared/schemas/backup'
import { z } from 'zod'
import { issuePathToken, peekPathToken, dropPathToken } from '../dialog-path-token'
import { createLogger } from '../../logger'

const log = createLogger('backup')
import { isNoneMode, newSecretKeys, NONE_MODE_HINT } from '../../crypto/none-mode-gate'

/**
 * §315：配置被**整批**换掉的那几条入口之后（合并＝逐表 `DELETE FROM` 再写入云端那份，
 * merge-service.ts:549；恢复＝整个库文件替换后重开，backup-service.ts:830-845），
 * 主进程里两份「以配置行为键」的内存态要跟着对账，否则旧的那份会继续服务新的记录：
 * - provider 适配器带着旧的 baseUrl 与**已解密**的 Key，而 `getAdapter` 命中缓存时是在
 *   「这条还在不在／还启用吗」两道检查**之前**就返回（providers/manager.ts:13-18）；
 * - MCP 运行时带着旧的子进程，工具列表与权限分级是启动那一刻烤进去的（mcp/manager.ts:297／:583），
 *   而界面只看得到库里那份 ⇒ 云端把「信任只读工具」关掉后，Agent 仍会免确认调用那个旧进程。
 *
 * 两处的手法不同是有意的：适配器是纯值对象，清掉零成本（下次用到时按新记录重建）；
 * MCP 的 `forget` 会**杀进程**，所以只摘「库里已无这条」或「身份字段变了」的那几条——改个名字不该停机。
 *
 * 对账失败不把已经完成的合并／恢复报成失败（库已经换好了，回「失败」只会诱导用户再恢复一次）：
 * 原因带回给能显示它的那一侧（合并有 summary，恢复没有 ⇒ 同时落 main.log）。
 */
async function reconcileAfterConfigSwap(): Promise<{ stopped: string[]; error?: string }> {
  try {
    const { providerManager } = await import('../../providers/manager')
    const { mcpManager } = await import('../../mcp/manager')
    providerManager.invalidate()
    return { stopped: await mcpManager.reconcileRuntimes() }
  } catch (e) {
    const error = errMsg(e)
    log.warn('配置整批替换后的运行时对账失败:', error)
    return { stopped: [], error }
  }
}

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
    const { saveWebDAVConfig, loadWebDAVConfig, restoreWebDAVPassword } = await import('../../backup/backup-service')
    // 先回填掩码，再判定：顺序反了会把「只改地址/目录」的保存当成改口令，
    // none 模式下误拒、db 模式下把 '••••' 存成真口令（鉴权永久失败）
    const resolved = restoreWebDAVPassword(cfg)
    if (!resolved) {
      return { ok: false as const, error: '口令栏是掩码占位，而本机还没有已存口令：请输入真实备份口令后再保存。' }
    }
    // B2：备份口令是真正保护备份包的密钥，none 模式下只会用公开可复现的固定密钥混淆 → 拒绝新值。
    // 与已存口令一致（UI 空着口令框只改地址/目录）照常保存；加密模式切换流程直连 service，不经此闸。
    const prev = loadWebDAVConfig()?.passwordCipher ?? ''
    const changed = newSecretKeys({ pwd: resolved.passwordCipher }, { pwd: prev }).length > 0
    // SEC-37：新输入/改动的口令必须落在底层可编码的 Latin1 范围内，否则包在构造 Basic 头时
    // 当场抛错、请求根本发不出（存量的超范围口令不回头拦，免得把「只改目录」也锁死）
    if (changed && !isWebdavPasswordUsable(resolved.passwordCipher)) {
      return { ok: false as const, error: WEBDAV_PASSWORD_CHARSET_MSG }
    }
    if (isNoneMode() && changed) {
      return {
        ok: false as const,
        error: `未设置主密码，备份口令不会被保存（它决定加密备份包能否被解开）。${NONE_MODE_HINT}`
      }
    }
    saveWebDAVConfig(resolved)
    return { ok: true }
  }, argsSchema(webdavConfigSchema))
  safeHandle(IPC.BACKUP_WEBDAV_LOAD_CONFIG, async () => {
    const { loadWebDAVConfig, maskWebDAVConfig } = await import('../../backup/backup-service')
    return maskWebDAVConfig(loadWebDAVConfig())
  })
  safeHandle(IPC.BACKUP_SCHEDULE_GET, () => getBackupSchedule())
  safeHandle(
    IPC.BACKUP_SCHEDULE_SET,
    (_e, patch: { enabled?: boolean; intervalHours?: number; retentionCount?: number }) =>
      setBackupSchedule(patch ?? {}),
    argsSchema(backupSchedulePatchSchema)
  )
  safeHandle(IPC.BACKUP_WEBDAV_TEST, async (_e, cfg: WebDAVConfigInput) => {
    const { testWebDAV, restoreWebDAVPassword } = await import('../../backup/backup-service')
    const resolved = restoreWebDAVPassword(cfg)
    if (!resolved) return { ok: false as const, message: '口令栏是掩码占位，而本机还没有已存口令：请输入真实备份口令后再测试。' }
    // 测试不写盘，因此一律校验：连存量的超范围口令也给一句可读原因，
    // 而不是底层那句 The string to be encoded contains characters outside of the Latin1 range
    if (!isWebdavPasswordUsable(resolved.passwordCipher)) {
      return { ok: false as const, message: WEBDAV_PASSWORD_CHARSET_MSG }
    }
    return testWebDAV(resolved)
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
    // 196：列表拉不到就说拉不到。咽成 [] 会让界面显示「没有备份」，而 SettingsModule 那句
    // bk.listFail 从此没有触发路径（safeHandle 的抛错转 {ok:false} 也走不到渲染层的 catch）。
    try {
      return await listWebDAVBackups(cfg)
    } catch (e) {
      log.warn('WebDAV 备份列表获取失败:', errMsg(e))
      return { ok: false as const, error: errMsg(e) }
    }
  })
  // 本地恢复（SEC-6）：文件路径只能来自本进程对话框签发的令牌——
  // 此前渲染端可直接回传绝对路径跳过选择器，注入一次即可用任意文件整库替换。
  safeHandle(IPC.BACKUP_LOCAL_RESTORE, async (e, payload?: { restoreToken?: string; backupPassword?: string }) => {
    const { restoreFromLocalFile } = await import('../../backup/backup-service')
    let token = typeof payload?.restoreToken === 'string' ? payload.restoreToken : ''
    let filePath = peekPathToken(token)
    if (!filePath) {
      // §323：带了令牌却已过期 ⇒ 明确失败，绝不重弹选择器。重弹会把「用户取消」回成
      // {ok:true, canceled:true}（渲染层只看 ok 就报「恢复成功」），还可能让用户在第二只框里
      // 选了另一份备份、被当成原来那份整库替换（不可逆）。同一条规则 assistants.ts 早已写下。
      if (token) return { ok: false, error: '备份文件的选择已过期，请重新选择文件恢复' }
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
    } finally {
      // §315：失败也可能发生在库文件已被替换之后 ⇒ 对账不问成败（helper 自己吞错，不带偏这次结果）
      await reconcileAfterConfigSwap()
    }
  // §323：入参整条可选——首选用那一发是 `restoreLocalBackup()`（payload undefined），
  // 而 tuple 里的对象 schema 不接受 undefined ⇒ 两种形状都被挡在门外（「参数至少需要 1 项」／
  // 「参数类型不对」），这颗键点了必失败、连选择器都弹不出。同 lock.ts:66 的写法。
  }, argsSchema(backupRestoreArgsSchema.optional()))

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
      } finally {
        await reconcileAfterConfigSwap() // §315：同本地恢复，对账不问成败
      }
    }
    try {
      return await restoreFromWebDAV(cfg, fn, { backupPassword: pwd })
    } finally {
      await reconcileAfterConfigSwap() // §315
    }
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
    let result: { ok: boolean; error?: string; summary?: string; code?: string; mcpStopped?: number; reconcileFailed?: boolean }
    try {
      result = await executeMerge(cfg, payload.filename, payload.strategy, {
        backupPassword: payload.backupPassword || undefined
      })
    } catch (e) {
      result = { ok: false, error: errMsg(e, '合并失败') }
    }
    // §315：整表覆盖排在附件合并之前，所以"失败"的那一发也可能已经把配置换掉了 ⇒ 对账不问成败
    const rec = await reconcileAfterConfigSwap()
    if (result.ok) {
      // 结果走**结构化字段**回给界面（渲染层在合并成功那句后面拼上它，见 SettingsModule 的 doMergeExecute），
      // 不写进 summary：那条通道渲染层一个字都不读（成功分支只挑 mergeOk／mergeCredNote 拼），
      // 往里写字＝留一句没人读的话（而"悄悄停掉了用户的 Server"恰恰必须让用户看见）
      if (rec.error) result.reconcileFailed = true
      else if (rec.stopped.length > 0) result.mcpStopped = rec.stopped.length
    }
    return result
  }, argsSchema(mergeExecutePayloadSchema))
  safeHandle(IPC.BACKUP_WEBDAV_DELETE, async (_e, filename: string) => {
    const { loadWebDAVConfig, deleteWebDAVBackup } = await import('../../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    await deleteWebDAVBackup(cfg, filename)
    return { ok: true }
  }, argsSchema(backupFilenameSchema))
}
