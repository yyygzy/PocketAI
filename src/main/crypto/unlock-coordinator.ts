// UnlockCoordinator：解锁流程协调器
//
// 为什么需要这个模块？
// - index.ts（boot 流程）需要等渲染进程提交密码 → Promise.resolve
// - ipc/index.ts（ENCRYPTION_UNLOCK handler）需要把渲染进程的结果传回 boot → resolve
//
// 不能用动态 import 回 import('../index')，因为 index.ts 已经在顶部 import ipc/index.ts，
// 会导致循环依赖（Node.js 的模块解析会返回不完整的模块对象）。
//
// 解法：用 EventEmitter + 一次性 Promise 订阅，独立模块被双方依赖。

import { EventEmitter } from 'node:events'

export interface UnlockPasswordPayload {
  password: string
  /** handler 已在同一趟 boot 里预验证过这把口令（见 ipc/handlers/encryption.ts 的 boot 分支） */
  preverified?: true
}

type UnlockResult =
  | UnlockPasswordPayload      // 已加密 DB 的解锁
  | { setPassword: string }    // 明文 DB 首次设置密码
  | null                       // 用户关闭了窗口（放弃）

/**
 * boot 拿到解锁载荷后，要不要**再验一趟**（一趟 = 一次 scrypt 派生 + 真正开库，本机约 0.7 秒）。
 *
 * 两个条件同时成立才不验：handler 给了 `preverified` 令牌，且那把派生出来的密钥此刻还在内存里。
 * 令牌必须与实际状态一起判——中途 `masterKeyManager.clear()` 过（锁屏流程插进来等）就回退成"boot 自己再验一趟"，
 * 不能让"声称验过"与"到底有没有可用密钥"脱钩。
 * 异常态（config 标了口令、库却能明文打开）走的是**不带令牌**的 submit，因此永远回退：那条路上 boot 是唯一的验证点。
 */
export function bootNeedsReverify(result: UnlockPasswordPayload, hasMasterKey: boolean): boolean {
  return !(result.preverified === true && hasMasterKey)
}

export class UnlockCoordinator extends EventEmitter {
  private waiting = false
  private resolver: ((result: UnlockResult) => void) | null = null

  /** boot() 调用：开始等待渲染进程提交密码 */
  waitForUnlock(): Promise<UnlockResult> {
    return new Promise((resolve) => {
      this.waiting = true
      this.resolver = resolve
    })
  }

  /** IPC handler 调用：渲染进程提交了密码 */
  submit(result: UnlockResult): void {
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      this.waiting = false
      r(result)
    }
  }

  /** boot() 调用：解锁窗口关闭（用户放弃） */
  cancel(): void {
    this.submit(null)
  }

  isWaiting(): boolean {
    return this.waiting
  }
}

export const unlockCoordinator = new UnlockCoordinator()
