// 数据健康面板：数据体量明细 + 知识库索引状态 + 备份与维护任务运行情况
// 数据来源：dataHealth:get 聚合（只读探测，见 src/main/steward/data-health.ts）
import React, { useCallback, useEffect, useState } from 'react'
import type { DataHealthReport, KbDocStatus } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { reportIpcError } from '../../utils/ipc'
import { formatBytes } from '../../utils/format'

const STATUSES: KbDocStatus[] = ['pending', 'parsing', 'indexing', 'ready', 'error']

function fmtTime(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toLocaleString()
}

export const DataHealthPanel: React.FC = () => {
  const { t } = useI18n()
  const [report, setReport] = useState<DataHealthReport | null>(null)

  const load = useCallback(() => {
    window.pocketai.getDataHealth().then(setReport).catch(reportIpcError('dataHealth.get'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!report) {
    return <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
  }

  const { sizes, kb, backup, tasks } = report

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
        <SizeRow label={t('dh.extensions')} bytes={sizes.extensionsBytes} total={sizes.dataDirBytes} />
        <SizeRow label={t('dh.logs')} bytes={sizes.logsBytes} total={sizes.dataDirBytes} />
        <SizeRow label={t('dh.other')} bytes={sizes.otherBytes} total={sizes.dataDirBytes} />
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

      <div className="mt-3">
        <button onClick={load} className="chip">{t('dh.refresh')}</button>
      </div>
    </div>
  )
}

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-base font-semibold font-mono text-[var(--color-text)] mt-0.5">{value}</div>
  </div>
)

/** 体积明细行：名称 + 体积 + 占比条 */
const SizeRow: React.FC<{ label: string; bytes: number; total: number }> = ({ label, bytes, total }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="text-[var(--color-text-muted)] w-28 shrink-0 truncate">{label}</span>
    <div className="h-1.5 rounded bg-[var(--color-sidebar)] overflow-hidden flex-1">
      <div
        className="h-full rounded bg-[var(--color-accent)] opacity-70"
        style={{ width: `${total > 0 ? Math.max((bytes / total) * 100, bytes > 0 ? 1 : 0) : 0}%` }}
      />
    </div>
    <span className="font-mono text-[var(--color-text)] w-20 text-right shrink-0">{formatBytes(bytes)}</span>
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
