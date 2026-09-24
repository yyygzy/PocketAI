// License 授权 IPC：状态查询 / 粘贴或导入激活 / 卡密在线激活 / 功能门控 / 指纹
import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import { licenseService } from '../../license/license'
import { activateOnline } from '../../license/activation-client'
import { getDiskFingerprint } from '../../steward/hardware'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { DATA_DIR } from '../../portable'
import { createLogger } from '../../logger'
import { safeHandle, argsSchema, errMsg } from '../safe-handle'
import { licenseCodeSchema, filePathSchema, featureSchema } from '../../../shared/schemas/license'

const log = createLogger('license')

/**
 * License 激活成功后持久化：写 DATA_DIR/license.lic（tmp+rename 原子写）并记录路径。
 * 必须由调用方传入 license 原文——licenseService 只保留 payload，不含 signature。
 */
function persistLicense(status: { valid?: boolean }, rawContent: string): void {
  if (!status?.valid || !rawContent) return
  try {
    const target = path.join(DATA_DIR, 'license.lic')
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, rawContent, 'utf8')
    fs.renameSync(tmp, target)
    appConfigRepo.setLicensePath(target)
  } catch (e) {
    log.warn('激活结果落盘失败（重启后可能需要重新激活）:', errMsg(e))
  }
}

/** 已存在的 license.lic 文件内容（导入文件场景复用原文） */
function readLicenseFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

export function registerLicenseHandlers(): void {
  // ---------- 粘贴激活码 / 导入授权文件 ----------
  // 激活成功后统一落盘到 DATA_DIR/license.lic，否则重启后授权丢失
  safeHandle(IPC.LICENSE_ACTIVATE, (_e, code: unknown) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('请输入激活码内容')
    const status = licenseService.loadFromString(code)
    persistLicense(status, code)
    return status
  }, argsSchema(licenseCodeSchema))
  safeHandle(IPC.LICENSE_IMPORT_FILE, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('窗口不可用')
    const result = await dialog.showOpenDialog(win, {
      title: '导入授权文件',
      properties: ['openFile'],
      filters: [{ name: '授权文件', extensions: ['lic', 'txt', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const status = licenseService.loadFromFile(result.filePaths[0]!)
    persistLicense(status, readLicenseFile(result.filePaths[0]!))
    return { canceled: false, status }
  })

  // ---------- License 状态 / 导入 / 清除 / 门控 ----------
  safeHandle(IPC.LICENSE_GET_STATUS, () => licenseService.getStatus())
  safeHandle(IPC.LICENSE_LOAD_FILE, (_e, filePath: string) => {
    const status = licenseService.loadFromFile(filePath)
    persistLicense(status, readLicenseFile(filePath))
    return status
  }, argsSchema(filePathSchema))
  safeHandle(IPC.LICENSE_LOAD_STRING, (_e, content: string) => {
    const status = licenseService.loadFromString(content)
    persistLicense(status, content)
    return status
  }, argsSchema(licenseCodeSchema))
  safeHandle(IPC.LICENSE_CLEAR, () => {
    licenseService.clear()
    // 同步删除落盘的 license.lic 并清空记录路径，防止重启后授权「复活」
    try {
      const licPath = appConfigRepo.getLicensePath() || path.join(DATA_DIR, 'license.lic')
      if (fs.existsSync(licPath)) fs.unlinkSync(licPath)
    } catch (e) {
      log.warn('删除 license.lic 失败:', errMsg(e))
    }
    appConfigRepo.setLicensePath('')
    return { ok: true }
  })
  safeHandle(IPC.LICENSE_HAS_FEATURE, (_e, feature: string) =>
    licenseService.hasFeature(feature),
  argsSchema(featureSchema))
  // 本机硬盘指纹（设置页展示，离线激活时发给卖家；null = 无法读取）
  safeHandle(IPC.LICENSE_GET_FINGERPRINT, () => getDiskFingerprint())
  // 卡密在线激活：附带本机指纹请求激活服务器，返回的 license 过完整验签+比对后落盘。
  // 业务失败不抛异常（IPC 会丢 Error 自定义属性），统一返回结构化 ActivationResult，
  // 渲染端按 code 走 i18n 差异化提示。
  safeHandle(IPC.LICENSE_ONLINE_ACTIVATE, async (_e, code: unknown) => {
    const result = await activateOnline(
      typeof code === 'string' ? code : '',
      getDiskFingerprint()
    )
    if (result.ok) persistLicense(result.status, result.license)
    return result
  }, argsSchema(licenseCodeSchema))
}
