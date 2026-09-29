// 数据健康面板：数据体量明细 + 知识库索引状态 + 知识库完整性 + 备份与维护任务运行情况
// 数据来源：dataHealth:get 聚合（只读探测，见 src/main/steward/data-health.ts）
// 修复动作：dataHealth:kb-clean / kb-dedup / kb-reindex（见 src/main/knowledge/kb-health.ts）
import React, { useCallback, useEffect, useState } from 'react'
import type { DataHealthReport, KbDocStatus, KbDuplicateGroup } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { reportIpcError } from '../../utils/ipc'
import { formatBytes } from '../../utils/format'

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

  const load = useCallback(() => {
    window.pocketai.getDataHealth().then(setReport).catch(reportIpcError('dataHealth.get'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** 修复动作统一包装：执行 → 成功提示 → 刷新报告；失败由 reportIpcError 兜底 */
  const runAction = useCallback(
    async (tag: string, fn: () => Promise<string>) => {
      setBusy(true)
      try {
        toast.success(await fn())
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
      return t('dh.integrity.cleanDone', { vectors: r.removedVectors, chunks: r.removedChunks })
    })

  const onReindex = () =>
    runAction('dataHealth.kbReindex', async () => {
      const r = await window.pocketai.reindexKbDocs(report!.kb.integrity.brokenDocs.map((d) => d.id))
      return t('dh.integrity.reindexDone', { count: r.enqueued })
    })

  const onDedup = async (group: KbDuplicateGroup) => {
    const removeCount = group.docs.length - 1
    if (removeCount < 1) return
    if (!(await confirm({ message: t('dh.integrity.dedupConfirm', { count: removeCount }), danger: true }))) return
    runAction('dataHealth.kbDedup', async () => {
      const r = await window.pocketai.deduplicateKbDocs(group.docs[0]!.id)
      return t('dh.integrity.dedupDone', { count: r.removed })
    })
  }

  if (!report) {
    return <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
  }

  const { sizes, kb, backup, tasks, boot } = report
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
        <StatCard label={t('dh.total')} value={formatBytes(sizes.dataDirBytes)} />
        <StatCard label={t('dh.db')} value={formatBytes(sizes.dbBytes)} />
        <StatCard label={t('dh.vectors')} value={formatBytes(sizes.vectorDbBytes)} />
        <StatCard label={t('dh.attachments')} value={formatBytes(sizes.attachmentsBytes)} />
      </div>

      {/* 体积明细行 */}
      <div className="mb-4 space-y-1">
        <BarRow label={t('dh.extensions')} ratio={sizes.dataDirBytes > 0 ? sizes.extensionsBytes / sizes.dataDirBytes : 0} value={formatBytes(sizes.extensionsBytes)} />
        <BarRow label={t('dh.logs')} ratio={sizes.dataDirBytes > 0 ? sizes.logsBytes / sizes.dataDirBytes : 0} value={formatBytes(sizes.logsBytes)} />
        <BarRow label={t('dh.other')} ratio={sizes.dataDirBytes > 0 ? sizes.otherBytes / sizes.dataDirBytes : 0} value={formatBytes(sizes.otherBytes)} />
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

      <div className="mt-3 flex items-center gap-2">
        <button onClick={load} className="chip">{t('dh.refresh')}</button>
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

const Row: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
  <div className="flex justify-between gap-4 text-sm">
    <span className="text-[var(--color-text-muted)] truncate">{label}</span>
    <span className={`text-right text-xs truncate ${warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text)]'}`} title={value}>
      {value}
    </span>
  </div>
)
