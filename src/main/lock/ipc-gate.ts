// 隐私锁 IPC 网关（P0 修复）
//
// 问题：lockService.lock() 只广播事件给 UI 层，主进程全部数据类 invoke 通道
// 在锁屏期间照常响应 —— 一旦渲染层被注入脚本（XSS 等），可在锁屏状态下
// 直接读取会话/Provider/知识库数据或触发任意操作。
//
// 方案：统一包装 ipcMain.handle。锁屏状态下仅放行白名单内的锁控制类通道，
// 其余 invoke 一律抛 APP_LOCKED 拒绝（fail-closed：后续新增通道默认受保护）。
//
// 注意：必须在所有 IPC 注册（registerIpcHandlers / initPopup）之前调用一次。

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/types'
import { lockService } from './lock'

/** 锁屏时仍可调用的通道：隐私锁控制 + 锁屏 UI 所需的最小只读 */
const LOCK_IPC_WHITELIST: ReadonlySet<string> = new Set<string>([
  IPC.LOCK_GET_STATUS,
  IPC.LOCK_LOCK,
  IPC.LOCK_UNLOCK,
  IPC.LOCK_SET_AUTO_TIMEOUT,
  IPC.LOCK_MARK_ACTIVE,
  IPC.ENCRYPTION_GET_STATUS, // 锁屏 UI 需要 dbEncrypted 决定是否要求输入密码
  IPC.ENCRYPTION_UNLOCK,     // 加密解锁窗：需主密码验证，拦截无安全增益且防叠加锁卡死
  IPC.POPUP_HIDE             // 浮窗 Esc 自隐藏，返回不含用户数据
])

let installed = false

/** 安装锁网关（幂等）：包装 ipcMain.handle，locked 时拦截非白名单 invoke */
export function installLockGate(): void {
  if (installed) return
  installed = true

  const rawHandle = ipcMain.handle.bind(ipcMain) as (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => any
  ) => void
  ;(ipcMain as any).handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => any
  ): void => {
    rawHandle(channel, async (event, ...args) => {
      if (lockService.getStatus().state === 'locked' && !LOCK_IPC_WHITELIST.has(channel)) {
        throw new Error('APP_LOCKED')
      }
      return listener(event, ...args)
    })
  }
}
