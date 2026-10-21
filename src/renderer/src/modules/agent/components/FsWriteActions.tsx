// fs_write 结果卡上的「还原到写入前」（V4-Iter-231）
//
// 为什么按钮挂在结果卡上而不是别处：快照 id 是那次写入自己带回来的（`fs-tools.ts` 的 execute 返回体），
// 卡片是它唯一的自然归属点——用户看完"改了什么"就在同一屏决定"要不要退回去"。
//
// 两条界面口径按既有纪律走：
//  · **没留快照时不出现按钮**（`snapshotId` 为 null），并说一句为什么——出现一个注定失败的按钮更糟；
//  · 失败走 toast + `role="status"`，不冒充读数（§228 那条口径：操作类反馈不是"读不到"）。
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import { errText } from '../../../utils/error'
import { hasIpcFailed, ipcFailureText, logIpcError } from '../../../utils/ipc'

interface FsWriteResult {
  path?: unknown
  created?: unknown
  bytes?: unknown
  snapshotId?: unknown
  notRestorable?: unknown
}

/** 只认"有字符串 snapshotId 且没被标成不可还原"这一种形状；解析失败一律当"没有还原入口" */
function readSnapshotId(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as FsWriteResult
    if (parsed.notRestorable) return null
    return typeof parsed.snapshotId === 'string' && parsed.snapshotId ? parsed.snapshotId : null
  } catch {
    return null
  }
}

/** 结果里带 `notRestorable` 时给一句原话（旧内容过大或不是文本 ⇒ 压根没留快照） */
export function isNotRestorable(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as FsWriteResult
    return typeof parsed.notRestorable === 'string' && parsed.notRestorable.length > 0
  } catch {
    return false
  }
}

export const FsWriteActions: React.FC<{ resultContent: string }> = ({ resultContent }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'restored' | 'removed' | null>(null)

  const snapshotId = readSnapshotId(resultContent)
  if (!snapshotId) {
    return isNotRestorable(resultContent) ? (
      <div role="status" className="mt-1 text-[11px] text-[var(--color-text-muted)]">
        {t('agent.fsWrite.notRestorable')}
      </div>
    ) : null
  }

  const restore = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await window.pocketai.restoreFileWrite(snapshotId)
      if (hasIpcFailed(res)) {
        // 还原失败时按钮必须还能再点（除了"已被用过"那一档由主进程拒绝），否则用户只剩一句提示
        // 走字典而不是 ipcFailText：还原被拒时用户要的是一句能懂的话，不是 SNAPSHOT_DIVERGED
        toast.error(ipcFailureText(res, t))
        return
      }
      setDone(res.removed ? 'removed' : 'restored')
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
      logIpcError('agent.restoreFileWrite', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        className="btn-ghost text-[11px]"
        disabled={busy || done !== null}
        onClick={() => void restore()}
      >
        {done === 'restored'
          ? `✓ ${t('agent.fsWrite.restored')}`
          : done === 'removed'
            ? `✓ ${t('agent.fsWrite.removed')}`
            : t('agent.fsWrite.restore')}
      </button>
      {busy && (
        <span role="status" className="text-[11px] text-[var(--color-text-muted)]">
          {t('common.saving')}
        </span>
      )}
    </div>
  )
}
