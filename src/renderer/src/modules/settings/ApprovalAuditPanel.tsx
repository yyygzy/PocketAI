// 审批明细屏（P0-2c-3，只读 v1）：数据来自 approval_events（v53），跨会话的审计视图。
// 口径：只展示 args_redacted 与 args_digest 的短哈希；不展示原始参数、不展示工具结果（表里也没有）。
// 分页策略：固定 PAGE_SIZE 条「加载更多」，服务端 zod 硬顶 100/次，本屏累计硬顶 500 条——
//   跨会话审计是翻阅而不是精确翻页，避免 COUNT 全表；排序固定 created_at DESC, id DESC，追加行序稳定。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovalAuditQuery,
  ApprovalAuditRow,
  ApprovalExportFormat,
  ApprovalExportQuery,
  ConversationRecord
} from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { approvalReasonText } from '../../utils/approval-reason'

const PAGE_SIZE = 50
/** 本屏累计加载硬顶：再多请用筛选缩小范围，避免把 10 万行账本拖进渲染进程 */
const CLIENT_CAP = 500

type DecisionValue = ApprovalAuditRow['decision']
type TFn = (key: string, params?: Record<string, string | number>) => string

/** 本地日期串（YYYY-MM-DD）→ 当天 00:00 的毫秒；空/非法返回 undefined（不筛） */
function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

/** 本地日期串 → 次日 00:00 减 1ms（闭区间，含当天整日） */
function dayEnd(value: string): number | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime() - 1
}

function decisionText(decision: DecisionValue, t: TFn): string {
  switch (decision) {
    case 'auto_allow':
      return t('approvalAudit.decision.autoAllow')
    case 'user_approve':
      return t('approvalAudit.decision.userApprove')
    case 'user_deny':
      return t('approvalAudit.decision.userDeny')
    case 'timeout_deny':
      return t('approvalAudit.decision.timeoutDeny')
    case 'policy_deny':
      return t('approvalAudit.decision.policyDeny')
    default:
      return decision
  }
}

function decisionTone(decision: DecisionValue): string {
  switch (decision) {
    case 'auto_allow':
      return 'text-[var(--color-success)] bg-[var(--color-success-bg)]'
    case 'user_approve':
      return 'text-[var(--color-accent)] bg-[var(--color-info-bg)]'
    case 'timeout_deny':
      return 'text-[var(--color-warning)] bg-[var(--color-warning-bg)]'
    case 'user_deny':
    case 'policy_deny':
      return 'text-[var(--color-danger)] bg-[var(--color-danger-bg)]'
    default:
      return 'text-[var(--color-text-muted)]'
  }
}

function scopeText(scope: ApprovalAuditRow['scope'], t: TFn): string {
  return scope === 'session' ? t('approvalAudit.scope.session') : t('approvalAudit.scope.once')
}

function actorText(actor: string, t: TFn): string {
  return actor === 'local_user' ? t('approvalAudit.actor.localUser') : actor
}

export const ApprovalAuditPanel: React.FC = () => {
  const { t } = useI18n()
  const [conversationId, setConversationId] = useState('')
  const [decision, setDecision] = useState<'' | DecisionValue>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<ApprovalAuditRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [exporting, setExporting] = useState<ApprovalExportFormat | null>(null)
  const [exportMsg, setExportMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  // 条件变化/并发请求的序号：只有最后一次发起的请求能落 state，避免旧响应盖掉新筛选
  const seqRef = useRef(0)

  const hasFilters = conversationId !== '' || decision !== '' || from !== '' || to !== ''

  const buildQuery = useCallback(
    (offset: number, limit: number): ApprovalAuditQuery => {
      const q: ApprovalAuditQuery = { offset, limit }
      if (conversationId) q.conversationId = conversationId
      if (decision) q.decision = decision
      const start = dayStart(from)
      const end = dayEnd(to)
      if (start !== undefined) q.from = start
      if (end !== undefined) q.to = end
      return q
    },
    [conversationId, decision, from, to]
  )

  const loadFailureText = useCallback(
    (value: unknown) => ipcFailText(value as { error?: string }, t('common.unknownError')),
    [t]
  )

  /** 条件变化 → 重置到第一页（失败时清空列表：不许把上一次条件的行留在新筛选下面） */
  useEffect(() => {
    const seq = ++seqRef.current
    setLoading(true)
    // 条件一变，进行中的"加载更多"就作废：不清会留下 disabled 的按钮
    setLoadingMore(false)
    setInitialized(false)
    setLoadErr(null)
    setRows([])
    setHasMore(false)
    window.pocketai
      .listApprovalEvents(buildQuery(0, PAGE_SIZE))
      .then((r) => {
        if (seq !== seqRef.current) return
        if (hasIpcFailed(r)) {
          setLoadErr(loadFailureText(r))
          setInitialized(true)
          setLoading(false)
          return
        }
        setRows(Array.isArray(r.rows) ? r.rows : [])
        setHasMore(Boolean(r.hasMore))
        setInitialized(true)
        setLoading(false)
      })
      .catch((e) => {
        if (seq !== seqRef.current) return
        logIpcError('approvalAudit.list', e)
        // catch 也要落到"读取失败"常驻句上：不许把 reject 画成"没有记录"
        setLoadErr(t('common.unknownError'))
        setInitialized(true)
        setLoading(false)
      })
  }, [buildQuery, loadFailureText, t])

  // 会话筛选的下拉选项：活动 + 归档两侧合并（审批记录可能来自已归档会话）。
  // 选项读失败只降级成"只剩全部会话"，不影响列表本身；失败原因记日志而不是篡改列表状态。
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.pocketai.listConversations(),
      window.pocketai.listConversations(undefined, undefined, true)
    ])
      .then(([active, archived]) => {
        if (cancelled) return
        const merged = new Map<string, ConversationRecord>()
        for (const c of [...(Array.isArray(active) ? active : []), ...(Array.isArray(archived) ? archived : [])]) {
          merged.set(c.id, c)
        }
        setConversations([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100))
      })
      .catch((e) => logIpcError('approvalAudit.conversations', e))
    return () => {
      cancelled = true
    }
  }, [])

  const loadMore = () => {
    if (loadingMore || loading || !hasMore || rows.length >= CLIENT_CAP) return
    const seq = ++seqRef.current
    const remaining = Math.min(PAGE_SIZE, CLIENT_CAP - rows.length)
    setLoadingMore(true)
    setLoadErr(null)
    window.pocketai
      .listApprovalEvents(buildQuery(rows.length, remaining))
      .then((r) => {
        if (seq !== seqRef.current) return
        if (hasIpcFailed(r)) {
          // 追加失败保留已读到的行，只在顶部报"这次没读到更多"，不把整屏清空
          setLoadErr(loadFailureText(r))
          return
        }
        setRows((prev) => [...prev, ...(Array.isArray(r.rows) ? r.rows : [])].slice(0, CLIENT_CAP))
        setHasMore(Boolean(r.hasMore))
      })
      .catch((e) => {
        if (seq !== seqRef.current) return
        logIpcError('approvalAudit.listMore', e)
        setLoadErr(t('common.unknownError'))
      })
      .finally(() => {
        if (seq === seqRef.current) setLoadingMore(false)
      })
  }

  const clearFilters = () => {
    setConversationId('')
    setDecision('')
    setFrom('')
    setTo('')
  }

  /**
   * 导出当前筛选条件的结果集（JSON/CSV）。范围只带四项筛选，不带 offset/limit——
   * 行数上限由主进程的硬顶决定；截断时主进程回报 truncated，这里明确提示"只导出了前 N 行"。
   */
  const runExport = (format: ApprovalExportFormat): void => {
    if (exporting || loading || rows.length === 0) return
    setExporting(format)
    setExportMsg(null)
    const query: ApprovalExportQuery = { format }
    if (conversationId) query.conversationId = conversationId
    if (decision) query.decision = decision
    const start = dayStart(from)
    const end = dayEnd(to)
    if (start !== undefined) query.from = start
    if (end !== undefined) query.to = end
    window.pocketai
      .exportApprovalEvents(query)
      .then((r) => {
        if (hasIpcFailed(r)) {
          setExportMsg({
            kind: 'err',
            text: t('approvalAudit.export.failed', { msg: ipcFailText(r, t('common.unknownError')) })
          })
          return
        }
        if (r.canceled) return
        setExportMsg(
          r.truncated
            ? { kind: 'warn', text: t('approvalAudit.export.truncated', { n: r.exportedRows, max: r.maxRows }) }
            : { kind: 'ok', text: t('approvalAudit.export.done', { n: r.exportedRows }) }
        )
      })
      .catch((e) => {
        logIpcError('approvalAudit.export', e)
        setExportMsg({
          kind: 'err',
          text: t('approvalAudit.export.failed', { msg: t('common.unknownError') })
        })
      })
      .finally(() => setExporting(null))
  }

  const conversationTitle = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of conversations) map.set(c.id, c.title)
    return map
  }, [conversations])

  const showEmptyNoRecords = initialized && !loading && !loadErr && rows.length === 0 && !hasFilters
  const showEmptyFiltered = initialized && !loading && !loadErr && rows.length === 0 && hasFilters

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
          {t('approvalAudit.intro')}
        </p>
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          {t('approvalAudit.privacy')}
        </p>
      </div>

      {/* 筛选：四项可同时生效；条件变化即从第一页重取 */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          <span>{t('approvalAudit.filter.conversation')}</span>
          <select
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] max-w-[220px]"
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
          >
            <option value="">{t('approvalAudit.filter.allConversations')}</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          <span>{t('approvalAudit.filter.decision')}</span>
          <select
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)]"
            value={decision}
            onChange={(e) => setDecision(e.target.value as '' | DecisionValue)}
          >
            <option value="">{t('approvalAudit.filter.allDecisions')}</option>
            <option value="auto_allow">{t('approvalAudit.decision.autoAllow')}</option>
            <option value="user_approve">{t('approvalAudit.decision.userApprove')}</option>
            <option value="user_deny">{t('approvalAudit.decision.userDeny')}</option>
            <option value="timeout_deny">{t('approvalAudit.decision.timeoutDeny')}</option>
            <option value="policy_deny">{t('approvalAudit.decision.policyDeny')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          <span>{t('approvalAudit.filter.from')}</span>
          <input
            type="date"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)]"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          <span>{t('approvalAudit.filter.to')}</span>
          <input
            type="date"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)]"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {hasFilters && (
          <button
            className="text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={clearFilters}
          >
            {t('approvalAudit.filter.clear')}
          </button>
        )}
      </div>

      {/* 导出：范围＝上面这套筛选条件的结果集；主进程有独立硬上限，截断会明说 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
          disabled={exporting !== null || loading || rows.length === 0}
          onClick={() => runExport('json')}
        >
          {t('approvalAudit.export.json')}
        </button>
        <button
          className="text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
          disabled={exporting !== null || loading || rows.length === 0}
          onClick={() => runExport('csv')}
        >
          {t('approvalAudit.export.csv')}
        </button>
        {exporting && (
          <span className="text-[11px] text-[var(--color-text-muted)]">{t('approvalAudit.export.exporting')}</span>
        )}
        <span className="text-[11px] text-[var(--color-text-muted)]">{t('approvalAudit.export.hint')}</span>
      </div>
      {exportMsg && (
        <p
          className={`text-[11px] ${
            exportMsg.kind === 'err'
              ? 'text-[var(--color-danger)]'
              : exportMsg.kind === 'warn'
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--color-success)]'
          }`}
        >
          {exportMsg.text}
        </p>
      )}

      {/* 读取失败：与"没有记录"分开展示；有旧行时只在顶部提示追加失败 */}
      {loadErr && rows.length === 0 && <LoadFailNotice msg={loadErr} />}
      {loadErr && rows.length === 0 && (
        <button
          className="text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          onClick={() => {
            // 重取当前条件的第一页；effect 只认条件变化，这里显式发一发
            const seq = ++seqRef.current
            setLoading(true)
            setLoadErr(null)
            window.pocketai
              .listApprovalEvents(buildQuery(0, PAGE_SIZE))
              .then((r) => {
                if (seq !== seqRef.current) return
                if (hasIpcFailed(r)) {
                  setLoadErr(loadFailureText(r))
                  return
                }
                setRows(Array.isArray(r.rows) ? r.rows : [])
                setHasMore(Boolean(r.hasMore))
                setInitialized(true)
              })
              .catch((e) => {
                if (seq !== seqRef.current) return
                logIpcError('approvalAudit.retry', e)
                setLoadErr(t('common.unknownError'))
              })
              .finally(() => {
                if (seq === seqRef.current) setLoading(false)
              })
          }}
        >
          {t('agent.retryRead')}
        </button>
      )}
      {loadErr && rows.length > 0 && <LoadFailNotice msg={loadErr} />}

      {loading && (
        <p className="text-xs text-[var(--color-text-muted)]">{t('approvalAudit.loading')}</p>
      )}

      {/* 空态三态之二：真的没有记录 vs 条件筛空——两句不同，且筛空给一键清空 */}
      {showEmptyNoRecords && (
        <div className="rounded border border-[var(--color-border)] px-3 py-4 text-xs text-[var(--color-text-muted)] leading-relaxed">
          <p>{t('approvalAudit.empty.noRecords')}</p>
          <p className="mt-1 text-[11px]">{t('approvalAudit.empty.noRecordsHint')}</p>
        </div>
      )}
      {showEmptyFiltered && (
        <div className="rounded border border-[var(--color-border)] px-3 py-4 text-xs text-[var(--color-text-muted)] leading-relaxed">
          <p>{t('approvalAudit.empty.filtered')}</p>
          <button
            className="mt-2 text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text)]"
            onClick={clearFilters}
          >
            {t('approvalAudit.filter.clear')}
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-[var(--color-border)] px-3 py-2.5 space-y-1.5">
              <div className="flex items-start gap-2 flex-wrap">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${decisionTone(row.decision)}`}>
                  {decisionText(row.decision, t)}
                </span>
                <span className="text-xs text-[var(--color-text)] min-w-0 break-words">
                  {approvalReasonText(row.reasonCode, t) || '—'}
                </span>
                <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{scopeText(row.scope, t)}</span>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                <span>
                  {t('approvalAudit.field.tool')}：
                  <span className="font-mono text-[var(--color-text)]">{row.toolName}</span>
                  {row.toolId !== row.toolName && <span className="font-mono"> ({row.toolId})</span>}
                </span>
                <span>
                  {t('approvalAudit.field.actor')}：{actorText(row.actor, t)}
                </span>
                <span>
                  {t('approvalAudit.field.conversation')}：
                  {/* §436：截断位只包数据本身，字段名留在外面——句子与数据同挂一个 truncate
                      会被 §410 记成"混合位"，也说不清被截掉的到底是标签还是标题。
                      再补 title：悬停能看到完整标题，而不是只靠省略号猜。 */}
                  <span
                    className="truncate max-w-[280px]"
                    title={conversationTitle.get(row.conversationId) ?? `#${row.conversationId.slice(0, 8)}`}
                  >
                    {conversationTitle.get(row.conversationId) ?? `#${row.conversationId.slice(0, 8)}`}
                  </span>
                </span>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                <span>
                  {t('approvalAudit.field.requestedAt')}：{new Date(row.requestedAt).toLocaleString()}
                </span>
                <span>
                  {t('approvalAudit.field.decidedAt')}：{new Date(row.decidedAt).toLocaleString()}
                </span>
                <span>
                  {t('approvalAudit.field.waited')}：
                  {t('approvalAudit.waitSeconds', {
                    s: Math.max(0, Math.round((row.decidedAt - row.requestedAt) / 1000))
                  })}
                </span>
              </div>

              <div className="text-[11px] text-[var(--color-text-muted)]">
                {t('approvalAudit.field.digest')}：
                <span className="font-mono text-[var(--color-text)]">{row.argsDigest ? row.argsDigest.slice(0, 10) : '—'}</span>
              </div>
              {row.argsRedacted ? (
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text)] font-mono">
                  {row.argsRedacted}
                </pre>
              ) : (
                <div className="text-[11px] text-[var(--color-text-muted)]">—</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && hasMore && rows.length < CLIENT_CAP && (
        <button
          className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          disabled={loadingMore || loading}
          onClick={loadMore}
        >
          {loadingMore ? t('approvalAudit.loadingMore') : t('approvalAudit.loadMore')}
        </button>
      )}
      {rows.length > 0 && hasMore && rows.length >= CLIENT_CAP && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {t('approvalAudit.capReached', { n: CLIENT_CAP })}
        </p>
      )}
    </div>
  )
}
