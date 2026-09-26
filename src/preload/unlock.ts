// preload/unlock.ts：解锁窗口的最小能力暴露（最小权限原则）
//
// 解锁窗（unlock.html）只需 5 个加密/恢复相关方法。
// 与主窗口 preload/index.ts 分离，避免解锁窗渲染进程被攻陷时
// 拿到备份、许可证、文件系统等全部能力。
//
// 注意：renderer 侧 window.pocketai 仍声明为完整 PocketAPI 类型
// （便于复用类型），但本 preload 运行时仅暴露以下子集；
// UnlockPage 只调用这 5 个方法，其余在解锁窗上下文中为 undefined。
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { PocketAPI } from './index'

// 显式约束为 PocketAPI 的子集：主 preload 改签名时此处编译失败，
// 保证解锁窗暴露的方法与主契约一致（三段式契约对齐）。
type UnlockApiShape = Pick<
  PocketAPI,
  | 'unlockEncryption'
  | 'getAuthLockState'
  | 'setMasterPassword'
  | 'recoverWithCode'
  | 'saveRecoveryFile'
  | 'copySensitiveToClipboard'
>

const api: UnlockApiShape = {
  // ── 解锁 / 设密 ──
  unlockEncryption: (password) => ipcRenderer.invoke(IPC.ENCRYPTION_UNLOCK, password),
  getAuthLockState: () => ipcRenderer.invoke(IPC.ENCRYPTION_AUTH_STATUS),
  setMasterPassword: (password) =>
    ipcRenderer.invoke(IPC.ENCRYPTION_SET_MASTER_PASSWORD, password),

  // ── 恢复码 ──
  recoverWithCode: (code, newPassword) =>
    ipcRenderer.invoke(IPC.ENCRYPTION_RECOVER, { code, newPassword }),
  saveRecoveryFile: (
    code: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_SAVE_RECOVERY_FILE, code),

  // ── 敏感剪贴板（恢复码 30s 自动清除） ──
  copySensitiveToClipboard: (
    text: string,
    ttlMs?: number
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CLIPBOARD_COPY_SENSITIVE, text, ttlMs)
}

contextBridge.exposeInMainWorld('pocketai', api)

export type UnlockAPI = typeof api
