// License 授权 IPC：状态查询 / 粘贴或导入激活 / 卡密在线激活 / 功能门控 / 指纹
import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import { licenseService } from '../../license/license'
import { activateOnline } from '../../license/activation-client'
import { getDiskFingerprintAsync } from '../../steward/hardware'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { DATA_DIR } from '../../portable'
import { createLogger } from '../../logger'
import { safeHandle, argsSchema, errMsg } from '../safe-handle'
import { issuePathToken, peekPathToken } from '../dialog-path-token'
import {
  licenseCodeSchema,
  licensePathTokenSchema,
  featureSchema
} from '../../../shared/schemas/license'

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
  safeHandle(IPC.LICENSE_ACTIVATE, async (_e, code: unknown) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('请输入激活码内容')
    const status = await licenseService.loadFromStringAsync(code)
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
    // 路径只留在主进程：返回一次性令牌，后续加载只认令牌，不接受渲染层回传路径（M5）
    const filePath = result.filePaths[0]!
    const pathToken = issuePathToken(filePath)
    const status = await licenseService.loadFromFileAsync(filePath)
    persistLicense(status, readLicenseFile(filePath))
    return { canceled: false, status, pathToken }
  })

  // ---------- License 状态 / 导入 / 清除 / 门控 ----------
  // 状态查询等启动期那次加载结束：否则慢盘机器上会先答「未激活」，把付费用户闪成免费版
  safeHandle(IPC.LICENSE_GET_STATUS, async () => {
    await licenseService.waitForBootLoad()
    return licenseService.getStatus()
  })
  // 仅接受 LICENSE_IMPORT_FILE 对话框签发的令牌；渲染层直传路径一律拒绝（M5）
  safeHandle(IPC.LICENSE_LOAD_FILE, async (_e, token: string) => {
    const filePath = peekPathToken(token)
    if (!filePath) throw new Error('授权文件令牌无效或已过期，请重新选择文件')
    const status = await licenseService.loadFromFileAsync(filePath)
    persistLicense(status, readLicenseFile(filePath))
    return status
  }, argsSchema(licensePathTokenSchema))
  safeHandle(IPC.LICENSE_LOAD_STRING, async (_e, content: string) => {
    const status = await licenseService.loadFromStringAsync(content)
    persistLicense(status, content)
    return status
  }, argsSchema(licenseCodeSchema))
  safeHandle(IPC.LICENSE_CLEAR, () => {
    licenseService.clear()
    // 同步删除落盘的 license.lic 并清空记录路径，防止重启后授权「复活」
    try {
      // L3：只允许删应用数据目录内的授权文件；DB 里的路径被篡改时不得变成任意文件删除原语
      const dataDir = path.resolve(DATA_DIR)
      const defaultPath = path.join(dataDir, 'license.lic')
      const stored = appConfigRepo.getLicensePath()
      const licPath = stored ? path.resolve(stored) : defaultPath
      const inside = licPath === defaultPath || licPath.startsWith(dataDir + path.sep)
      if (!inside) {
        log.warn('LICENSE_CLEAR：记录的路径不在应用数据目录内，已拒绝删除')
      } else if (fs.existsSync(licPath)) {
        fs.unlinkSync(licPath)
      }
    } catch (e) {
      log.warn('删除 license.lic 失败:', errMsg(e))
    }
    appConfigRepo.setLicensePath('')
    return { ok: true }
  })
  safeHandle(IPC.LICENSE_HAS_FEATURE, async (_e, feature: string) => {
    await licenseService.waitForBootLoad()
    return licenseService.hasFeature(feature)
  }, argsSchema(featureSchema))
  // 本机硬盘指纹（设置页展示，离线激活时发给卖家；null = 无法读取）
  // 异步取：这条要跑 Get-Partition/Get-PhysicalDisk，在坏驱动的机器上 20s+，不能冻住主线程
  safeHandle(IPC.LICENSE_GET_FINGERPRINT, async () => await getDiskFingerprintAsync())
  // 卡密在线激活：附带本机指纹请求激活服务器，返回的 license 过完整验签+比对后落盘。
  // 业务失败不抛异常（IPC 会丢 Error 自定义属性），统一返回结构化 ActivationResult，
  // 渲染端按 code 走 i18n 差异化提示。
  safeHandle(IPC.LICENSE_ONLINE_ACTIVATE, async (_e, code: unknown) => {
    const result = await activateOnline(
      typeof code === 'string' ? code : '',
      await getDiskFingerprintAsync()
    )
    if (result.ok) persistLicense(result.status, result.license)
    return result
  }, argsSchema(licenseCodeSchema))
}
