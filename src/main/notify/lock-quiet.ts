// 系统通知的锁屏判据（唯一出处）
//
// 为什么要单独判：隐私锁只保护**应用自己的界面**（渲染层遮罩 + IPC 网关），而 `new Notification()`
// 把正文交给 Windows 的通知中心/锁屏界面 —— 那是一块遮罩与 IPC 网关都管不到的屏幕。
// 提醒正文与 Agent 回复摘要都是明文，锁着的时候弹出去就等于把内容写在锁屏上。
//
// 判据与 `lock/ipc-gate.ts` 同源：只看 `lockService.getStatus().state`。
import { lockService } from '../lock/lock'

/** 当前是否处于锁屏状态（锁屏期间一律不把内容交给 OS 通知面） */
export function shouldSuppressNotification(): boolean {
  return lockService.getStatus().state === 'locked'
}
