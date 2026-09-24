// 加密 IPC：主密码设置/解锁/轮换/启停、恢复密钥、剪贴板敏感内容守卫
import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, dialog, app } from 'electron'
import { IPC } from '../../../shared/types'
import { dbService } from '../../db/database'
import { masterKeyManager } from '../../crypto/master-key'
import { exportFieldCredentials, restoreFieldCredentials } from '../../crypto/credential-rotation'
import { recoveryKeyManager } from '../../crypto/recovery-key'
import { clipboardGuard } from '../../crypto/clipboard-guard'
import { unlockCoordinator } from '../../crypto/unlock-coordinator'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { lockService } from '../../lock/lock'
import { denyNewWindows } from '../../net/external-links'
import type { WebDAVConfig } from '../../backup/backup-service'
import { createLogger } from '../../logger'
import { safeHandle, errMsg, argsSchema, z } from '../safe-handle'
import {
  masterPasswordSchema,
  recoveryCodeSchema,
  recoverPayloadSchema
} from '../../../shared/schemas/encryption'

const log = createLogger('encryption')

export function registerEncryptionHandlers(): void {
  safeHandle(IPC.ENCRYPTION_GET_STATUS, () => ({
    mode: masterKeyManager.getMode(),
    unlocked: masterKeyManager.hasKey(),
    // 用模式判断而非「是否有 key」：锁定清 key 后此字段必须仍为 true，
    // 否则锁屏 UI 会误判为无密码模式，用户无法提交密码解锁
    dbEncrypted: masterKeyManager.getMode() === 'db',
    fieldEncrypted: masterKeyManager.hasKey(),
    masterPasswordVerified: masterKeyManager.hasKey()
  }))
  safeHandle(IPC.ENCRYPTION_UNLOCK, (_e, password: string) => {
    // Boot 阶段：交给 unlock coordinator
    if (unlockCoordinator.isWaiting()) {
      unlockCoordinator.submit({ password })
      return { ok: true }
    }
    // 运行时解锁（加密锁后重新打开 DB）
    const salt = appConfigRepo.getMasterPasswordSalt()
    try {
      const masterKey = masterKeyManager.setKey(password, salt ?? undefined)
      dbService.open(masterKey)
      dbService.getHandle().prepare('SELECT 1').get()
      // 关闭解锁窗口
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.getTitle().includes('解锁') || win.getTitle().includes('Unlock')) {
          win.close()
        }
      }
      // 与隐私锁状态机同步（加密锁已把 lockService 置为 locked）
      lockService.unlock()
      return { ok: true }
    } catch {
      masterKeyManager.clear()
      dbService.close()
      return { ok: false, error: '密码错误' }
    }
  }, argsSchema(masterPasswordSchema))
  safeHandle(IPC.ENCRYPTION_SET_MASTER_PASSWORD, (_e, password: string) => {
    unlockCoordinator.submit({ setPassword: password })
    return { ok: true }
  }, argsSchema(masterPasswordSchema))
  safeHandle(IPC.ENCRYPTION_LOCK, () => {
    // 先进隐私锁状态机（同步触发 onStateChange → 清密钥 + 关库），
    // 使 IPC 网关与主窗口遮罩在加密锁期间同样生效
    lockService.lock('manual')
    masterKeyManager.clear()
    dbService.close()
    // 显示解锁窗口供用户重新解锁
    const unlockWin = new BrowserWindow({
      width: 420, height: 440, resizable: false, minimizable: false,
      maximizable: false, show: false, frame: true, autoHideMenuBar: true,
      title: '墨匣 Moxia - PocketAI — 解锁', backgroundColor: '#1e1e2e',
      icon: process.platform === 'win32'
        ? path.join(app.getAppPath(), 'build/icon/icon.ico')
        : path.join(__dirname, '../../build/icon/icon-256.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/unlock.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true
      }
    })
    unlockWin.on('ready-to-show', () => unlockWin.show())
    denyNewWindows(unlockWin.webContents)
    if (process.env['ELECTRON_RENDERER_URL']) {
      const base = new URL(process.env['ELECTRON_RENDERER_URL'])
      base.pathname = '/unlock.html'
      base.search = '?mode=unlock'
      unlockWin.loadURL(base.toString())
    } else {
      unlockWin.loadFile(path.join(__dirname, '../renderer/unlock.html'), { query: { mode: 'unlock' } })
    }
    return { ok: true }
  })
  safeHandle(IPC.ENCRYPTION_CHANGE_PASSWORD, async (_e, oldPassword: string, newPassword: string) => {
    // 密码轮换：用旧密码打开 → rekey → 更新 salt
    const salt = appConfigRepo.getMasterPasswordSalt()
    // config.json 中的恢复包与 DB 开闭无关，rekey 前记录
    const hadRecovery = recoveryKeyManager.hasRecovery()
    // 保存当前正确密钥，验证失败时回滚
    const currentKey = masterKeyManager.getDbKey()
    const oldKey = masterKeyManager.setKey(oldPassword, salt ?? undefined)
    // 关闭 DB 并用旧密钥重新打开，真正校验旧密码
    dbService.close()
    try {
      dbService.open(oldKey)
      dbService.getHandle().prepare('SELECT 1').get()
    } catch {
      // 旧密码错误，回滚到正确密钥
      dbService.close()
      if (currentKey) {
        masterKeyManager.setRawKey(currentKey)
        dbService.open(currentKey)
      } else {
        dbService.open()
      }
      return { ok: false, error: '旧密码错误' }
    }
    // ⚠️ key 还没切换，先用旧 key 取出 WebDAV 明文密码 + 字段级凭据快照
    let webDAVPassword: string | null = null
    let savedCfg: WebDAVConfig | null = null
    try {
      const { loadWebDAVConfig } = await import('../../backup/backup-service')
      const oldCfg = loadWebDAVConfig()
      if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
    } catch { /* 无配置或解密失败，忽略 */ }
    const fieldSnapshot = exportFieldCredentials()

    // rekey
    dbService.getHandle().pragma('journal_mode = DELETE')
    const newSalt = masterKeyManager.generateSalt()
    appConfigRepo.setMasterPasswordSalt(newSalt)
    const newKey = masterKeyManager.setKey(newPassword, newSalt)
    const hex = newKey.toString('hex')
    dbService.getHandle().pragma(`rekey = "x'${hex}'"`)
    // 重新打开
    dbService.close()
    dbService.open(newKey)
    dbService.getHandle().pragma('journal_mode = WAL')

    // ⚠️ key 已切换，用新 key 重新加密 WebDAV 密码
    if (webDAVPassword && savedCfg) {
      try {
        const { saveWebDAVConfig } = await import('../../backup/backup-service')
        savedCfg.passwordCipher = webDAVPassword
        saveWebDAVConfig(savedCfg)  // 直接复用 oldCfg，避免第二次 load 时 key mismatch
      } catch (e) { log.warn('WebDAV 凭据重加密失败:', errMsg(e)) }
    }
    restoreFieldCredentials(fieldSnapshot)

    // masterKey 已换 → 旧恢复包解密的是旧 key，必须重生（用户需重新保存新恢复码）
    let newRecoveryCode: string | undefined
    if (hadRecovery) {
      newRecoveryCode = recoveryKeyManager.enableRecovery(newKey)
    }

    log.info('密码轮换成功')
    return { ok: true, recoveryCode: newRecoveryCode }
  }, argsSchema(masterPasswordSchema, masterPasswordSchema))
  safeHandle(IPC.ENCRYPTION_DISABLE, async (_e, password: string) => {
    // 禁用加密：用密码验证 → rekey 空密码 → 清 app_config
    const salt = appConfigRepo.getMasterPasswordSalt()
    // 保存当前密钥，验证失败时回滚
    const currentKey = masterKeyManager.getDbKey()
    const derivedKey = masterKeyManager.setKey(password, salt ?? undefined)
    // 关闭 DB 并用密钥重新打开，真正校验密码
    dbService.close()
    try {
      dbService.open(derivedKey)
      dbService.getHandle().prepare('SELECT 1').get()
    } catch {
      dbService.close()
      if (currentKey) {
        masterKeyManager.setRawKey(currentKey)
        dbService.open(currentKey)
      } else {
        dbService.open()
      }
      return { ok: false, error: '密码错误' }
    }
    // ⚠️ key 还没切换，先用 master key 取出 WebDAV 明文密码 + 字段级凭据快照
    let webDAVPassword: string | null = null
    let savedCfg: WebDAVConfig | null = null
    try {
      const { loadWebDAVConfig } = await import('../../backup/backup-service')
      const oldCfg = loadWebDAVConfig()
      if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
    } catch { /* 忽略 */ }
    const fieldSnapshot = exportFieldCredentials()

    dbService.getHandle().pragma('journal_mode = DELETE')
    dbService.getHandle().pragma("rekey = ''")
    dbService.close()
    masterKeyManager.init('none')  // ← key 切换为 fixed key
    dbService.open()
    appConfigRepo.setEncryptionMode('none')
    appConfigRepo.setHasMasterPassword(false)
    appConfigRepo.clearMasterPasswordSalt()
    log.info('已禁用加密')

    // ⚠️ key 已切为 fixed，用 fixed key 重新加密 WebDAV 密码
    if (webDAVPassword && savedCfg) {
      try {
        const { saveWebDAVConfig } = await import('../../backup/backup-service')
        savedCfg.passwordCipher = webDAVPassword
        saveWebDAVConfig(savedCfg)  // 复用 oldCfg，避免 key mismatch
      } catch (e) { log.warn('WebDAV 凭据重加密失败:', errMsg(e)) }
    }
    restoreFieldCredentials(fieldSnapshot)
    // 已无主密码，恢复密钥失去意义（也避免残留包指向旧 masterKey）
    recoveryKeyManager.disableRecovery()
    return { ok: true }
  }, argsSchema(masterPasswordSchema))
  safeHandle(IPC.ENCRYPTION_ENABLE, async (_e, password: string) => {
    // 设置页启用加密（DB 当前是明文打开状态）
    if (masterKeyManager.isDbEncrypted()) {
      return { ok: false, error: '已经加密' }
    }
    // ⚠️ 当前是 fixed key 模式，先取出 WebDAV 明文密码 + 字段级凭据快照
    let webDAVPassword: string | null = null
    let savedCfg: WebDAVConfig | null = null
    try {
      const { loadWebDAVConfig } = await import('../../backup/backup-service')
      const oldCfg = loadWebDAVConfig()
      if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
    } catch { /* 忽略 */ }
    const fieldSnapshot = exportFieldCredentials()

    const newSalt = masterKeyManager.generateSalt()
    const masterKey = masterKeyManager.setKey(password, newSalt)  // ← key 切换为 master key
    appConfigRepo.setMasterPasswordSalt(newSalt)
    appConfigRepo.setEncryptionMode('db')
    appConfigRepo.setHasMasterPassword(true)
    dbService.enableEncryption(masterKey)
    // 防御：清掉历史残留恢复包（其包裹的是过去的 masterKey，对新库无效且会误导）
    recoveryKeyManager.disableRecovery()
    log.info('已启用加密')

    // ⚠️ key 已切为 master，用 master key 重新加密 WebDAV 密码
    if (webDAVPassword && savedCfg) {
      try {
        const { saveWebDAVConfig } = await import('../../backup/backup-service')
        savedCfg.passwordCipher = webDAVPassword
        saveWebDAVConfig(savedCfg)  // 复用 oldCfg，避免 key mismatch
      } catch (e) { log.warn('WebDAV 凭据重加密失败:', errMsg(e)) }
    }
    restoreFieldCredentials(fieldSnapshot)
    return { ok: true }
  }, argsSchema(masterPasswordSchema))

  // ---------- 恢复密钥 ----------
  safeHandle(IPC.ENCRYPTION_HAS_RECOVERY, () => recoveryKeyManager.hasRecovery())

  safeHandle(IPC.ENCRYPTION_GENERATE_RECOVERY, () => {
    // 仅 db 模式且已解锁：需要当前 masterKey 才能包裹
    const masterKey = masterKeyManager.getDbKey()
    if (!masterKeyManager.isDbEncrypted() || !masterKey) {
      return { ok: false as const, error: '请先设置主密码并保持解锁状态' }
    }
    const code = recoveryKeyManager.enableRecovery(masterKey)
    return { ok: true as const, code }
  })

  safeHandle(IPC.ENCRYPTION_DISABLE_RECOVERY, () => {
    recoveryKeyManager.disableRecovery()
    return { ok: true }
  })

  // 忘记密码：恢复码还原 masterKey → 打开 DB → rekey 为新密码。
  // 成功后 DB 保持打开、manager 持有新 key；渲染端随后调用 unlockEncryption(newPassword)
  // 完成 boot 协调器提交或运行时关解锁窗 + lockService.unlock()。
  safeHandle(
    IPC.ENCRYPTION_RECOVER,
    async (_e, payload: { code: string; newPassword: string } | undefined) => {
      const code = payload?.code?.trim() ?? ''
      const newPassword = payload?.newPassword ?? ''
      if (!code) return { ok: false, error: '请输入恢复密钥' }
      if (newPassword.length < 6) return { ok: false, error: '新密码至少 6 位' }

      if (masterKeyManager.getMode() !== 'db') {
        return { ok: false, error: '当前未启用主密码，无需恢复' }
      }

      // 1) 恢复码 → 旧 masterKey（GCM 校验失败即报错，不会动 DB）
      let rawKey: Buffer
      try {
        rawKey = recoveryKeyManager.recoverMasterKey(code)
      } catch (e) {
        return { ok: false, error: errMsg(e) }
      }

      // 2) 用旧 key 打开 DB 并验证
      dbService.close()
      masterKeyManager.setRawKey(rawKey)
      try {
        dbService.open(rawKey)
        dbService.getHandle().prepare('SELECT 1').get()
      } catch {
        masterKeyManager.clear()
        dbService.close()
        return { ok: false, error: '恢复密钥与当前数据库不匹配' }
      }

      // 3) 旧 key 下导出全部需重加密的凭据（WebDAV 密码 + 字段级凭据）
      let webDAVPassword: string | null = null
      let savedCfg: WebDAVConfig | null = null
      try {
        const { loadWebDAVConfig } = await import('../../backup/backup-service')
        const oldCfg = loadWebDAVConfig()
        if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
      } catch { /* 无配置或解密失败，忽略 */ }
      const fieldSnapshot = exportFieldCredentials()

      // 4) rekey 为新密码
      try {
        dbService.getHandle().pragma('journal_mode = DELETE')
        const newSalt = masterKeyManager.generateSalt()
        appConfigRepo.setMasterPasswordSalt(newSalt)
        const newKey = masterKeyManager.setKey(newPassword, newSalt)
        const hex = newKey.toString('hex')
        dbService.getHandle().pragma(`rekey = "x'${hex}'"`)
        dbService.close()
        dbService.open(newKey)
        dbService.getHandle().pragma('journal_mode = WAL')

        // 5) 新 key 下重加密凭据
        if (webDAVPassword && savedCfg) {
          try {
            const { saveWebDAVConfig } = await import('../../backup/backup-service')
            savedCfg.passwordCipher = webDAVPassword
            saveWebDAVConfig(savedCfg)
          } catch (e) { log.warn('恢复后 WebDAV 凭据重加密失败:', errMsg(e)) }
        }
        restoreFieldCredentials(fieldSnapshot)

        // 6) 旧恢复码包裹的是旧 masterKey → 生成新恢复码，要求用户重新保存
        const newRecoveryCode = recoveryKeyManager.enableRecovery(newKey)
        log.info('恢复密钥重置密码成功')
        return { ok: true, recoveryCode: newRecoveryCode }
      } catch (e) {
        log.error('恢复后 rekey 失败:', errMsg(e))
        return { ok: false, error: `重置失败：${errMsg(e)}` }
      }
    },
    argsSchema(recoverPayloadSchema)
  )

  // 恢复码另存为文本文件（设置页与重置成功页共用）
  safeHandle(IPC.ENCRYPTION_SAVE_RECOVERY_FILE, async (e, code: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const content =
      '墨匣 恢复密钥\n' +
      '==============================\n' +
      '忘记主密码时，凭此码在解锁页重置密码。\n' +
      '请妥善保管（建议离线保存），任何人拿到它都可以重置你的密码。\n\n' +
      `${code}\n`
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: '墨匣-恢复密钥.txt',
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (canceled || !filePath) return { ok: true as const, canceled: true }
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
    return { ok: true as const, path: filePath }
  }, argsSchema(recoveryCodeSchema))

  // ---------- 剪贴板守卫 ----------
  // 复制敏感内容（恢复码等）：TTL 到期自动清除；锁屏/应用隐藏时立即清除
  safeHandle(IPC.CLIPBOARD_COPY_SENSITIVE, (_e, text: string, ttlMs?: number) => {
    if (typeof text !== 'string' || !text) return { ok: false, error: '无效内容' }
    clipboardGuard.copySensitive(text, typeof ttlMs === 'number' ? ttlMs : undefined)
    return { ok: true }
  }, argsSchema(z.string(), z.number().optional()))
}
