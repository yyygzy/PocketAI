// 全局工具调用审批弹窗（shell_exec 等 confirm 级工具）
// 主进程通过 AGENT_TOOL_APPROVAL_EVENT 推送请求，用户在此允许/拒绝。
// 多条请求按到达顺序排队；5 分钟无应答主进程会自动按拒绝处理。
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type { ToolApprovalRequestEvent } from '../../../shared/types'

export const ToolApprovalDialog: React.FC = () => {
  const { t } = useI18n()
  const [queue, setQueue] = useState<ToolApprovalRequestEvent[]>([])
  // 防双击：同一帧重复点击不得连吞两条排队审批
  const [busy, setBusy] = useState(false)
  const [staleNote, setStaleNote] = useState(false)

  useEffect(() => {
    // 返回值为退订函数
    return window.pocketai.onToolApprovalRequest((evt) => {
      setQueue((prev) => [...prev, evt])
    })
  }, [])

  const current = queue[0] ?? null

  // 切到下一条审批时重置按钮锁与超时提示
  useEffect(() => {
    setBusy(false)
    setStaleNote(false)
  }, [current?.approvalId])

  const respond = async (approved: boolean) => {
    const head = queue[0]
    if (!head || busy) return
    setBusy(true)
    const res = await window.pocketai.respondToolApproval(head.approvalId, approved)
    if (!res.ok) {
      // 主进程已按 5 分钟超时自动拒绝：保留弹窗并提示，不允许误以为已放行
      setStaleNote(true)
      setBusy(false)
      return
    }
    setQueue((prev) => prev.slice(1))
  }

  if (!current) return null

  // reason code → 文案；缺失时回退显示原始 code（宁可信息不丢）
  const reasonKey = `agent.approval.reason.${current.reason}`
  const reasonText = t(reasonKey)
  const reasonLabel = reasonText === reasonKey ? current.reason : reasonText
  const isDanger = current.risk === 'danger'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm p-4">
      <div className="w-[min(640px,94vw)] max-h-[85vh] flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)] shrink-0">
          <span className="text-lg leading-none">{isDanger ? '⚠️' : '🔧'}</span>
          <h3 className="text-sm font-semibold">{t('agent.approval.title')}</h3>
          <span
            className="ml-auto rounded px-2 py-0.5 text-[11px] font-medium"
            style={{
              color: isDanger ? 'var(--color-danger)' : 'var(--color-text-muted)',
              background: isDanger ? 'var(--color-danger-bg)' : 'var(--color-hover-overlay)'
            }}
          >
            {current.toolName}
          </span>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-auto min-h-0 px-5 py-4 space-y-3">
          <p
            className="text-xs rounded-md px-2.5 py-1.5"
            style={{
              color: isDanger ? 'var(--color-danger)' : 'var(--color-accent)',
              background: isDanger ? 'var(--color-danger-bg)' : 'var(--color-accent-soft)'
            }}
          >
            {isDanger ? '🛑 ' : 'ℹ️ '}
            {reasonLabel}
          </p>

          {current.cwd && (
            <div className="text-xs text-[var(--color-text-muted)]">
              <span className="opacity-70">{t('agent.approval.cwd')}: </span>
              <span className="font-mono break-all">{current.cwd}</span>
            </div>
          )}

          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1">
              {t('agent.approval.command')}
            </div>
            <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs leading-relaxed">
              {current.command}
            </pre>
          </div>

          <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {t('agent.approval.warning')}
          </p>
        </div>

        {/* 操作区（允许键不做 autofocus，防止回车误放行） */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--color-border)] shrink-0">
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {staleNote ? t('agent.approval.expired') : t('agent.approval.autoRejectHint')}
          </span>
          <div className="flex gap-2">
            {staleNote ? (
              <button className="btn-ghost text-xs" onClick={() => setQueue((prev) => prev.slice(1))}>
                {t('agent.approval.close')}
              </button>
            ) : (
              <>
                <button className="btn-ghost text-xs" disabled={busy} onClick={() => void respond(false)}>
                  {t('agent.approval.deny')}
                </button>
                <button
                  className="btn-primary text-xs"
                  disabled={busy}
                  style={
                    isDanger
                      ? {
                          borderColor: 'var(--color-danger)',
                          color: 'var(--color-danger)',
                          background: 'var(--color-danger-bg)'
                        }
                      : undefined
                  }
                  onClick={() => void respond(true)}
                >
                  {t('agent.approval.allow')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
