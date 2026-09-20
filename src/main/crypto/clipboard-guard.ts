// 剪贴板敏感内容守卫
// 复制敏感文本（恢复码等）到剪贴板后启动定时清除：
//   - TTL 到期时仅当剪贴板内容仍是该敏感文本才清空（不覆盖用户后续复制的内容）
//   - 锁屏 / 应用隐藏时立即清除仍在等待期的敏感内容
//
// 清空使用 clipboard.clear()；读取失败（个别 Linux 环境权限受限）时静默跳过，
// 保守起见此时不清空——避免误覆盖用户剪贴板。

import { clipboard } from 'electron'

export const SENSITIVE_CLIPBOARD_TTL_MS = 30_000

class ClipboardGuard {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null

  /** 复制敏感文本并安排 TTL 后自动清除（同一时间只跟踪最近一次） */
  copySensitive(text: string, ttlMs: number = SENSITIVE_CLIPBOARD_TTL_MS): void {
    const ttl = Math.max(1000, ttlMs)
    void clipboard.writeText(text)
    this.pending = text
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.purge()
    }, ttl)
  }

  /** 立即清除等待期内的敏感内容（TTL 到期 / 锁屏 / 应用隐藏联动） */
  async purge(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const text = this.pending
    this.pending = null
    if (text === null) return
    try {
      // 用户已复制其他内容顶掉了敏感文本 → 无需再动剪贴板
      const current = await clipboard.readText()
      if (current === text) clipboard.clear()
    } catch {
      // 读取失败时不动剪贴板
    }
  }
}

export const clipboardGuard = new ClipboardGuard()
