// 数据健康面板：数据体量明细 + 知识库索引状态 + 知识库完整性 + 备份与维护任务运行情况
// 数据来源：dataHealth:get 聚合（只读探测，见 src/main/steward/data-health.ts）
// 修复动作：dataHealth:kb-clean / kb-dedup / kb-reindex（见 src/main/knowledge/kb-health.ts）
import React, { useCallback, useEffect, useState } from 'react'
import type { DataHealthReport, KbDocStatus, KbDuplicateGroup } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { reportIpcError, hasIpcFailed, ipcFailText } from '../../utils/ipc'
import { formatBytes } from '../../utils/format'
import { formatVectorIndex } from '../../utils/vector-index'
import { formatTraceLedger } from '../../utils/trace-ledger'

const STATUSES: KbDocStatus[] = ['pending', 'parsing', 'indexing', 'ready', 'error']

function fmtTime(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toLocaleString()
}

export const DataHealthPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, dialog } = useConfirm()
  const [report, setReport] = useState<DataHealthReport | null>(null)
  const [busy, setBusy] = useState(false)

  /** safeHandle 的失败是 resolve 的 `{ok:false}`：弹错并告诉调用方"这次没做成"（返回 true＝失败已处理） */
  const failAction = (r: unknown): boolean => {
    if (!hasIpcFailed(r)) return false
    toast.error(ipcFailText(r, t('common.unknownError')))
    return true
  }

  /** @param refresh 只有面板那颗「刷新」按钮会传 true：连浏览器缓存那一格也重算（V4-Iter-177） */
  const load = useCallback((refresh = false) => {
    window.pocketai.getDataHealth(refresh).then(setReport).catch(reportIpcError('dataHealth.get'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** 修复动作统一包装：执行 → 成功提示 → 刷新报告；fn 返回 null 表示"这次没做成"（失败提示由 fn 自己弹） */
  const runAction = useCallback(
    async (tag: string, fn: () => Promise<string | null>) => {
      setBusy(true)
      try {
        // 原先是无条件 `toast.success(await fn())`：safeHandle 的失败是 resolve 的 `{ok:false}`，
        // 于是绿色提示会说「已清理 undefined 条孤儿向量、undefined 条孤儿分块」，而实际一条都没动（§216）
        const text = await fn()
        if (text !== null) toast.success(text)
        load()
      } catch (e) {
        reportIpcError(tag)(e)
      } finally {
        setBusy(false)
      }
    },
    [toast, load]
  )

  const onClean = () =>
    runAction('dataHealth.kbClean', async () => {
      const r = await window.pocketai.cleanKbOrphans()
      if (failAction(r)) return null
      return t('dh.integrity.cleanDone', { vectors: r.removedVectors, chunks: r.removedChunks })
    })

  const onReindex = () =>
    runAction('dataHealth.kbReindex', async () => {
      const r = await window.pocketai.reindexKbDocs(report!.kb.integrity.brokenDocs.map((d) => d.id))
      if (failAction(r)) return null
      return t('dh.integrity.reindexDone', { count: r.enqueued })
    })

  const onDedup = async (group: KbDuplicateGroup) => {
    const removeCount = group.docs.length - 1
    if (removeCount < 1) return
    if (!(await confirm({ message: t('dh.integrity.dedupConfirm', { count: removeCount }), danger: true }))) return
    runAction('dataHealth.kbDedup', async () => {
      const r = await window.pocketai.deduplicateKbDocs(group.docs[0]!.id)
      if (failAction(r)) return null
      return t('dh.integrity.dedupDone', { count: r.removed })
    })
  }

  /**
   * 「浏览器缓存」那一格旁的只读跳转（打开数据目录本身，不接收任何路径入参）。
   * 这是用户主动点的操作 ⇒ 失败必须弹 toast，不许用 reportIpcError 咽成"点了没反应"（utils/ipc 的边界注释）。
   */
  const onOpenDir = async () => {
    setBusy(true)
    try {
      const r = await window.pocketai.openDataFolder()
      if (hasIpcFailed(r)) toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 清 HTTP 缓存（V4-Iter-189）：落点是"用户按下这颗按钮才动"，不自动、也不在退出时顺手做——
   * 台账 V4-Iter-182 给的理由是一条产品口径：缓存对 USB 冷启动与离线场景是资产不是垃圾。
   * 失败必须弹 toast 且不许显示「已清理」；成功要把前后两个数一起给出来，让人看得见它到底清掉了多少。
   */
  const onClearCache = async () => {
    const shown = report ? formatBytes(report.sizes.browserCacheBytes) : formatBytes(0)
    if (!(await confirm({ message: t('dh.browserCache.clearConfirm', { bytes: shown }), danger: true }))) return
    setBusy(true)
    try {
      const r = await window.pocketai.clearBrowserCache()
      if (hasIpcFailed(r)) {
        toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
      } else {
        toast.success(t('dh.browserCache.clearDone', { before: formatBytes(r.beforeBytes), after: formatBytes(r.afterBytes) }))
      }
      load()
    } catch (e) {
      reportIpcError('dataHealth.clearBrowserCache')(e)
      load()
    } finally {
      setBusy(false)
    }
  }

  if (!report) {
    return <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
  }

  const { sizes, traces, kb, backup, tasks, boot, recentPerf, perfHistory } = report
  const integrity = kb.integrity
  const integrityOk =
    integrity.orphanVectors === 0 &&
    integrity.orphanChunks === 0 &&
    integrity.brokenDocs.length === 0 &&
    integrity.duplicates.length === 0 &&
    integrity.providerIssues.length === 0

  return (
    <div>
      {/* 体积汇总卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
        <StatCard label={t('dh.total')} value={formatBytes(sizes.userDataBytes)} />
        <StatCard label={t('dh.db')} value={formatBytes(sizes.dbBytes)} />
        <StatCard label={t('dh.vectorIndex')} value={formatVectorIndex(kb.vectorIndex, t)} />
        <StatCard label={t('dh.attachments')} value={formatBytes(sizes.attachmentsBytes)} />
      </div>

      {/* 体积明细行 */}
      <div className="mb-4 space-y-1">
        <BarRow label={t('dh.extensions')} ratio={sizes.userDataBytes > 0 ? sizes.extensionsBytes / sizes.userDataBytes : 0} value={formatBytes(sizes.extensionsBytes)} />
        <BarRow label={t('dh.logs')} ratio={sizes.userDataBytes > 0 ? sizes.logsBytes / sizes.userDataBytes : 0} value={formatBytes(sizes.logsBytes)} />
        <BarRow label={t('dh.other')} ratio={sizes.userDataBytes > 0 ? sizes.otherBytes / sizes.userDataBytes : 0} value={formatBytes(sizes.otherBytes)} />
        {/* 浏览器缓存：Electron 自己的档案树，不进上面那颗「合计」，按「刷新」才重算（V4-Iter-177） */}
        <Row
          label={t('dh.browserCache')}
          value={t('dh.browserCacheValue', {
            bytes: formatBytes(sizes.browserCacheBytes),
            count: sizes.browserCacheFiles.toLocaleString('en-US')
          })}
        />
        <div className="flex flex-wrap gap-2">
          <button onClick={onOpenDir} disabled={busy} className="chip">{t('dh.browserCache.open')}</button>
          <button onClick={onClearCache} disabled={busy} className="chip">{t('dh.browserCache.clear')}</button>
        </div>
      </div>

      {/* Agent 运行账本的规模（探测见 agent-trace.repo.countForHealth；为什么报这两个数见台账 V4-Iter-173） */}
      <div className="mb-4 space-y-1">
        <Row label={t('dh.traces')} value={formatTraceLedger(traces, t)} />
      </div>

      {/* 知识库索引状态 */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.kbStatus')}</div>
      {kb.total === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-4">{t('dh.noKbDocs')}</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2">
            <span className="chip">{t('dh.kbTotal', { count: kb.total })}</span>
            {STATUSES.map((st) =>
              kb.byStatus[st] > 0 ? (
                <span key={st} className={`chip ${st === 'error' ? 'chip-danger' : st === 'ready' ? 'chip-accent' : ''}`}>
                  {t(`kb.st.${st}`)} {kb.byStatus[st]}
                </span>
              ) : null
            )}
          </div>
          {kb.errorDocs.length > 0 && (
            <table className="w-full text-xs mb-4">
              <thead>
                <tr className="text-left text-[var(--color-text-muted)]">
                  <th className="py-1 pr-2 font-normal">{t('dh.errorDocs')}</th>
                  <th className="py-1 pr-2 font-normal">{t('dh.reason')}</th>
                  <th className="py-1 font-normal text-right">{t('dh.date')}</th>
                </tr>
              </thead>
              <tbody>
                {kb.errorDocs.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2 truncate max-w-0">
                      <span className="text-[var(--color-text)]">{d.title}</span>
                      <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{d.kbName}</span>
                    </td>
                    <td className="py-1.5 pr-2 truncate max-w-0 text-[var(--color-warning)]" title={d.error ?? ''}>
                      {d.error ?? '-'}
                    </td>
                    <td className="py-1.5 text-right text-[var(--color-text-muted)] whitespace-nowrap">
                      {new Date(d.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {kb.total > 0 && kb.errorDocs.length === 0 && <div className="mb-4" />}

      {/* 知识库完整性（孤儿数据 / 需重建索引 / 重复文档 / 失效模型配置，探测见 kb-health.ts） */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.integrity.title')}</div>
      {integrityOk ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-4">{t('dh.integrity.ok')}</div>
      ) : (
        <div className="space-y-2 mb-4">
          {(integrity.orphanVectors > 0 || integrity.orphanChunks > 0) && (
            <div>
              <div className="space-y-1 mb-1.5">
                {integrity.orphanVectors > 0 && (
                  <Row label={t('dh.integrity.orphanVectors')} value={String(integrity.orphanVectors)} warn />
                )}
                {integrity.orphanChunks > 0 && (
                  <Row label={t('dh.integrity.orphanChunks')} value={String(integrity.orphanChunks)} warn />
                )}
              </div>
              <button onClick={onClean} disabled={busy} className="chip">{t('dh.integrity.clean')}</button>
            </div>
          )}

          {integrity.brokenDocs.length > 0 && (
            <div>
              <table className="w-full text-xs mb-1.5">
                <tbody>
                  {integrity.brokenDocs.slice(0, 10).map((d) => (
                    <tr key={d.id} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5 pr-2 truncate max-w-0">
                        <span className="text-[var(--color-text)]">{d.title}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{d.kbName}</span>
                      </td>
                      <td className="py-1.5 text-right text-[var(--color-warning)] whitespace-nowrap">
                        {t(`dh.integrity.reason.${d.reason}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={onReindex} disabled={busy} className="chip">{t('dh.integrity.reindex')}</button>
            </div>
          )}

          {integrity.duplicates.length > 0 && (
            <div>
              {integrity.duplicates.slice(0, 10).map((g) => (
                <div key={`${g.kbId}-${g.hash.slice(0, 8)}`} className="flex items-center gap-2 text-xs border-t border-[var(--color-border)] py-1.5">
                  <span className="text-[var(--color-warning)] shrink-0">{t('dh.integrity.dupCount', { count: g.docs.length })}</span>
                  <span className="truncate flex-1 text-[var(--color-text)]" title={g.docs.map((d) => d.title).join(' / ')}>
                    <span className="text-[10px] text-[var(--color-text-muted)] mr-1.5">{g.kbName}</span>
                    {g.docs.map((d) => d.title).join(' / ')}
                  </span>
                  <button onClick={() => onDedup(g)} disabled={busy} className="chip shrink-0">
                    {t('dh.integrity.dedup')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {integrity.providerIssues.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {integrity.providerIssues.map((p, i) => (
                  <tr key={`${p.kbId}-${p.role}-${i}`} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2 truncate max-w-0">
                      <span className="text-[10px] text-[var(--color-text-muted)] mr-1.5">{p.kbName}</span>
                      <span className="text-[var(--color-text)]">{t(`dh.integrity.role.${p.role}`)}</span>
                    </td>
                    <td className="py-1.5 text-right text-[var(--color-warning)] whitespace-nowrap">
                      {t(`dh.integrity.issue.${p.issue}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 备份与维护任务 */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.backup')}</div>
      <div className="space-y-1 mb-2">
        <Row
          label={t('dh.backupState')}
          value={
            !backup.configured
              ? t('dh.backupNotConfigured')
              : backup.enabled
                ? t('dh.backupOn', { hours: backup.intervalHours })
                : t('dh.backupOff')
          }
          warn={!backup.configured || !backup.enabled}
        />
        <Row
          label={t('dh.lastOk')}
          value={backup.lastOkAt === null ? t('dh.never') : fmtTime(backup.lastOkAt)}
          warn={backup.lastOkAt === null}
        />
        {backup.lastError && <Row label={t('dh.lastError')} value={backup.lastError} warn />}
      </div>

      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.tasks')}</div>
      <div className="space-y-1">
        <Row label={t('dh.task.kbHealthCheck')} value={tasks.kbHealthCheckLastRunAt === null ? t('dh.never') : fmtTime(tasks.kbHealthCheckLastRunAt)} />
        <Row label={t('dh.task.backupVerify')} value={tasks.backupVerifyLastRunAt === null ? t('dh.never') : fmtTime(tasks.backupVerifyLastRunAt)} />
      </div>

      {/* 本次启动耗时（USB 冷启动可视化；埋点见 src/main/steward/boot-perf.ts） */}
      <div className="mt-4 mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.boot.title')}</div>
      <div className="space-y-1">
        {boot.stages.map((s) => (
          <BarRow
            key={s.id}
            label={t(`dh.boot.${s.id}`)}
            ratio={boot.totalMs > 0 ? s.ms / boot.totalMs : 0}
            value={`${s.ms}ms`}
          />
        ))}
      </div>
      <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
        {t('dh.boot.total', { ms: boot.totalMs })} · {t('dh.boot.hint')}
      </div>

      {/* 最近慢操作（运行期埋点环形缓冲，见 src/main/steward/perf-probe.ts） */}
      <div className="mt-4 mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.perf.title')}</div>
      {recentPerf.length === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('dh.perf.empty')}</div>
      ) : (
        <div className="space-y-1 mb-2">
          {recentPerf.slice(-10).reverse().map((p, i) => {
            const lk = `dh.perf.label.${p.label}`
            const ll = t(lk)
            return (
              <div key={`${p.at}-${i}`} title={p.detail ?? ''}>
                <Row
                  label={ll === lk ? p.label : ll}
                  value={`${p.ms}ms · ${new Date(p.at).toLocaleTimeString()}`}
                  warn={p.ms >= 3000 || p.label === 'kb.degrade'}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* 跨会话慢事件统计（读日志尾部聚合，见 src/main/steward/perf-history.ts） */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.perf.histTitle')}</div>
      {perfHistory.length === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('dh.perf.histEmpty')}</div>
      ) : (
        <div className="space-y-1 mb-2">
          {perfHistory.map((h) => {
            const lk = `dh.perf.label.${h.label}`
            const ll = t(lk)
            const last = h.lastAt > 0 ? new Date(h.lastAt).toLocaleString() : '-'
            return (
              <div key={h.label}>
                <Row
                  label={ll === lk ? h.label : ll}
                  value={t('dh.perf.histRow', {
                    count: h.count,
                    p50: h.p50Ms,
                    max: h.maxMs,
                    last
                  })}
                  warn={h.maxMs >= 3000 || h.label === 'kb.degrade'}
                />
                {/* 同一标签按模型拆开才答得出「哪个模型慢」——混在一起的峰值归因不到具体模型 */}
                {h.byModel.map((m) => (
                  <Row
                    key={m.model}
                    mono
                    label={'· ' + m.model}
                    value={t('dh.perf.histModel', { count: m.count, p50: m.p50Ms, max: m.maxMs })}
                    warn={m.maxMs >= 3000}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => load(true)} className="chip">{t('dh.refresh')}</button>
      </div>
      {dialog}
    </div>
  )
}

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-base font-semibold font-mono text-[var(--color-text)] mt-0.5">{value}</div>
  </div>
)

/** 占比条行：名称 + 比例条 + 右侧值（体积明细 / 启动耗时共用） */
const BarRow: React.FC<{ label: string; ratio: number; value: string }> = ({ label, ratio, value }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="text-[var(--color-text-muted)] w-28 shrink-0 truncate" title={label}>{label}</span>
    <div className="h-1.5 rounded bg-[var(--color-sidebar)] overflow-hidden flex-1">
      <div
        className="h-full rounded bg-[var(--color-accent)] opacity-70"
        style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 1 : 0)}%` }}
      />
    </div>
    <span className="font-mono text-[var(--color-text)] w-20 text-right shrink-0">{value}</span>
  </div>
)

const Row: React.FC<{ label: string; value: string; warn?: boolean; mono?: boolean }> = ({ label, value, warn, mono }) => (
  <div className="flex justify-between gap-4 text-sm">
    <span className={'text-[var(--color-text-muted)] truncate ' + (mono ? 'font-mono' : '')}>{label}</span>
    <span className={`text-right text-xs truncate ${warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text)]'}`} title={value}>
      {value}
    </span>
  </div>
)
