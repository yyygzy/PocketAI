import React, { useCallback, useEffect, useState } from 'react'
import type {
  HardwareInfo,
  HealthReport,
  CleanupResult,
  ModelRecommendation,
  AuditResult,
  DiagnoseResult,
  CheckLevel
} from '../../../../shared/types'
import { useI18n } from '../../i18n'

const LEVEL_ICON: Record<CheckLevel, string> = { ok: '✅', warn: '⚠️', danger: '❌' }
const LEVEL_CLS: Record<CheckLevel, string> = {
  ok: 'text-[var(--color-success)]',
  warn: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]'
}

export const StewardModule: React.FC = () => {
  const { t } = useI18n()
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [integrity, setIntegrity] = useState<{ ok: boolean; details: string } | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [recommendation, setRecommendation] = useState<ModelRecommendation | null>(null)
  const [audit, setAudit] = useState<AuditResult | null>(null)
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null)
  const [checking, setChecking] = useState<'audit' | 'diagnose' | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const [vacuumBytes, setVacuumBytes] = useState<number | null>(null)
  const [cleaning, setCleaning] = useState(false)
  /** 最近一次「手动重新检测」完成时间；null 表示展示的是启动时自动检测的快照 */
  const [manualCheckedAt, setManualCheckedAt] = useState<number | null>(null)
  /** 检测请求进行中（手动重新检测较慢，需禁用按钮） */
  const [refreshing, setRefreshing] = useState(false)

  // 硬件画像在平台启动时由主进程采集一次并缓存：
  //  - 进入管家页面只读取缓存快照（force=false），不重复采集；
  //  - 完整性/健康报告是轻量 DB 统计，每次进入实时读取；
  //  - 用户点「重新检测」时 force=true 才重新执行硬件采集。
  const load = useCallback(async (force = false) => {
    setRefreshing(true)
    try {
      const [hw, integ, healthReport] = await Promise.all([
        window.pocketai.getHardwareInfo(force).catch(() => null),
        window.pocketai.checkIntegrity().catch(() => null),
        window.pocketai.getHealthReport().catch(() => null)
      ])
      if (hw) setHardware(hw)
      if (integ) setIntegrity(integ)
      if (healthReport) setHealth(healthReport)
      // 模型推荐仅含一次本机 Ollama 端口探测，较轻；其硬件分级使用同一份缓存
      window.pocketai
        .recommendModels()
        .then((r) => {
          if (r.ok && r.data) setRecommendation(r.data)
        })
        .catch(() => {})
      if (force) setManualCheckedAt(Date.now())
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 仅在挂载时读取一次快照，不设定时器、不在每次点击时重新采集
  useEffect(() => {
    load(false)
  }, [load])

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const result = await window.pocketai.runCleanup()
      setCleanupResult(result)
      const report = await window.pocketai.getHealthReport()
      setHealth(report)
      // 静默刷新诊断结果（孤儿数据可能已被清除）
      window.pocketai.runDiagnose().then((r) => {
        if (r.ok && r.data) setDiagnose(r.data)
      })
    } finally {
      setCleaning(false)
    }
  }

  const handleVacuum = async () => {
    setCleaning(true)
    try {
      const bytes = await window.pocketai.runVacuum()
      setVacuumBytes(bytes)
      const report = await window.pocketai.getHealthReport()
      setHealth(report)
    } finally {
      setCleaning(false)
    }
  }

  const handleAudit = async () => {
    setChecking('audit')
    try {
      const r = await window.pocketai.runAudit()
      if (r.ok && r.data) setAudit(r.data)
    } finally {
      setChecking(null)
    }
  }

  const handleDiagnose = async () => {
    setChecking('diagnose')
    try {
      const r = await window.pocketai.runDiagnose()
      if (r.ok && r.data) setDiagnose(r.data)
    } finally {
      setChecking(null)
    }
  }

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
    return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
  }

  const fmtDiskType = (v: string) => {
    const map: Record<string, string> = {
      ssd: t('steward.dt.ssd'),
      hdd: t('steward.dt.hdd'),
      usb: t('steward.dt.usb'),
      unknown: t('steward.dt.unknown')
    }
    return map[v] ?? v
  }

  const fmtBus = (v: string) => {
    const map: Record<string, string> = {
      NVMe: 'NVMe',
      SATA: 'SATA',
      USB: 'USB',
      ATA: 'ATA',
      SAS: 'SAS',
      SCSI: 'SCSI',
      RAID: 'RAID',
      SD: 'SD',
      MMC: 'MMC',
      Virtual: t('steward.bus.virtual')
    }
    return map[v] ?? v
  }

  const fmtClock = (ms: number) => {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-text-muted)]">
          {t('steward.subtitle')}
          <span className="ml-2 text-[11px]">
            {refreshing
              ? t('steward.refreshing')
              : manualCheckedAt
                ? t('steward.lastChecked', { time: fmtClock(manualCheckedAt) })
                : t('steward.startupSnapshot')}
          </span>
        </p>
        <button onClick={() => load(true)} disabled={refreshing} className="btn-ghost text-xs disabled:opacity-50">
          {refreshing ? t('steward.refreshing') : t('steward.recheck')}
        </button>
      </div>

      {integrity && (
        <Section title={t('steward.integrity')}>
          <Row
            label="integrity_check"
            value={integrity.ok ? '✅ ok' : `❌ ${integrity.details}`}
          />
        </Section>
      )}

      {hardware && (
        <>
          <Section title={t('steward.system')}>
            <Row label={t('steward.platform')} value={`${hardware.os.platform} ${hardware.os.release}`} />
            <Row label={t('steward.arch')} value={hardware.os.arch} />
            {hardware.os.hostname && <Row label={t('steward.hostname')} value={hardware.os.hostname} />}
          </Section>
          <Section title={t('steward.cpu')}>
            <Row label={t('steward.cpuModel')} value={hardware.cpu.model} />
            <Row label={t('steward.cores')} value={String(hardware.cpu.cores)} />
          </Section>
          <Section title={t('steward.memory')}>
            <Row label={t('steward.total')} value={formatBytes(hardware.memory.total)} />
            <Row label={t('steward.free')} value={formatBytes(hardware.memory.free)} />
          </Section>
          <Section title={t('steward.gpu')}>
            {hardware.gpus.length === 0 ? (
              <Row label="-" value={t('steward.notDetected')} />
            ) : (
              hardware.gpus.map((g, i) => (
                <Row
                  key={i}
                  label={g.name}
                  value={
                    [
                      g.memory ? formatBytes(g.memory) : '',
                      g.driver ? `${t('steward.driver')} ${g.driver}` : '',
                      g.cuda ? '· CUDA' : '',
                      g.mps ? '· MPS' : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }
                />
              ))
            )}
          </Section>
          <Section title={t('steward.disk')}>
            {hardware.disk.drive && <Row label={t('steward.drive')} value={hardware.disk.drive} />}
            <Row label={t('steward.type')} value={fmtDiskType(hardware.disk.type)} />
            {hardware.disk.mediumType && <Row label={t('steward.mediumType')} value={hardware.disk.mediumType} />}
            {hardware.disk.busType && <Row label={t('steward.busType')} value={fmtBus(hardware.disk.busType)} />}
            {hardware.disk.volumeLabel && <Row label={t('steward.volumeLabel')} value={hardware.disk.volumeLabel} />}
            {hardware.disk.filesystem && <Row label={t('steward.filesystem')} value={hardware.disk.filesystem} />}
            {hardware.disk.totalSpace != null && <Row label={t('steward.capacity')} value={formatBytes(hardware.disk.totalSpace)} />}
            {hardware.disk.freeSpace != null && <Row label={t('steward.freeSpace')} value={formatBytes(hardware.disk.freeSpace)} />}
            <Row
              label={t('steward.removable')}
              value={hardware.disk.removable ? t('steward.portableYes') : t('steward.no')}
            />
          </Section>
        </>
      )}

      {/* 模型推荐（硬件画像） */}
      {recommendation && (
        <Section title={t('steward.modelRec')}>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-accent)] text-[var(--color-on-accent)]">
              {recommendation.tier}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full ${
              recommendation.ollamaRunning
                ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]'
            }`}>
              Ollama {recommendation.ollamaRunning ? t('steward.ollamaRunning') : t('steward.ollamaStopped')}
            </span>
            {recommendation.installedModels.length > 0 && (
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {t('steward.installedCount', { n: recommendation.installedModels.length })}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mb-3 leading-relaxed">{recommendation.summary}</p>
          <div className="space-y-2">
            {recommendation.localPicks.map((p) => (
              <div key={p.id} className="rounded-lg border border-[var(--color-border)] p-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)]">
                    {p.tag}
                  </span>
                  <span className="font-mono text-xs">{p.id}</span>
                  {p.installed && (
                    <span className="text-[10px] text-[var(--color-success)]">{t('steward.installed')}</span>
                  )}
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">{p.reason}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-3 leading-relaxed">☁️ {recommendation.onlineHint}</p>
          {recommendation.warnings.length > 0 && (
            <div className="mt-2 space-y-1">
              {recommendation.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-[var(--color-warning)]">⚠️ {w}</p>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 数据健康报告 */}
      {health && (
        <Section title={t('steward.dataHealth')}>
          <Row label={t('steward.totalConv')} value={String(health.totalConversations)} />
          <Row label={t('steward.totalMessages')} value={String(health.totalMessages)} />
          <Row label={t('steward.kbCount')} value={String(health.kbCount)} />
          <Row label={t('steward.attachSize')} value={formatBytes(health.totalAttachmentsBytes)} />
          <Row
            label={t('steward.orphanMessages')}
            value={health.orphanMessages > 0 ? `⚠️ ${health.orphanMessages}` : '✅ 0'}
          />
          <Row
            label={t('steward.orphanChunks')}
            value={health.orphanChunks > 0 ? `⚠️ ${health.orphanChunks}` : '✅ 0'}
          />
        </Section>
      )}

      {/* 安全检测 */}
      <Section title={t('steward.security')}>
        <div className="flex items-center gap-3">
          <button
            onClick={handleAudit}
            disabled={checking !== null}
            className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {checking === 'audit' ? t('steward.auditing') : t('steward.startAudit')}
          </button>
          {audit && (
            <span className="text-sm">
              {t('steward.securityScore')}
              <span className={audit.score >= 80 ? 'text-[var(--color-success)]' : audit.score >= 50 ? 'text-[var(--color-warning)]' : 'text-[var(--color-danger)]'}>
                {audit.score}
              </span>
              <span className="text-[var(--color-text-muted)]"> / 100</span>
            </span>
          )}
        </div>
        {audit && (
          <div className="mt-3 space-y-2">
            {audit.checks.map((c) => (
              <div key={c.id} className="text-sm">
                <div className="flex items-start gap-2">
                  <span>{LEVEL_ICON[c.level]}</span>
                  <div className="min-w-0">
                    <span className={`font-medium ${LEVEL_CLS[c.level]}`}>{c.label}</span>
                    <span className="text-[var(--color-text-muted)] ml-2">{c.detail}</span>
                  </div>
                </div>
                {c.suggestion && (
                  <p className="text-[11px] text-[var(--color-text-muted)] ml-6 mt-0.5">💡 {c.suggestion}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 故障诊断 */}
      <Section title={t('steward.diagnosis')}>
        <button
          onClick={handleDiagnose}
          disabled={checking !== null}
          className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text)] disabled:opacity-50 hover:bg-[var(--color-hover-overlay)] transition-colors"
        >
          {checking === 'diagnose' ? t('steward.diagnosing') : t('steward.startDiagnose')}
        </button>
        {diagnose && (
          <div className="mt-3 space-y-2">
            {diagnose.items.map((it) => (
              <div key={it.id} className="text-sm">
                <div className="flex items-start gap-2">
                  <span>{LEVEL_ICON[it.level]}</span>
                  <div className="min-w-0">
                    <span className="text-[var(--color-text-muted)]">{it.label}：</span>
                    <span className={LEVEL_CLS[it.level]}>{it.detail}</span>
                  </div>
                </div>
                {it.fix && (
                  <p className="text-[11px] text-[var(--color-text-muted)] ml-6 mt-0.5">🔧 {it.fix}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 垃圾清理 */}
      <Section title={t('steward.cleanup')}>
        <div className="flex gap-2">
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {cleaning ? t('steward.cleaning') : t('steward.startCleanup')}
          </button>
          <button
            onClick={handleVacuum}
            disabled={cleaning}
            className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text)] disabled:opacity-50 hover:bg-[var(--color-hover-overlay)] transition-colors"
          >
            {t('steward.vacuum')}
          </button>
        </div>
        <p className="text-[11px] text-[var(--color-text-muted)] mt-2">
          {t('steward.cleanupHint')}
        </p>
        {cleanupResult && (
          <div className="mt-2 px-2 py-1.5 rounded bg-[var(--color-success-bg)] text-[11px] text-[var(--color-success)]">
            {t('steward.cleanupResult', {
              m: cleanupResult.removedOrphanMessages,
              c: cleanupResult.removedOrphanChunks,
              b: formatBytes(cleanupResult.vacuumedBytes)
            })}
          </div>
        )}
        {vacuumBytes !== null && (
          <div className="mt-2 px-2 py-1.5 rounded bg-[var(--color-success-bg)] text-[11px] text-[var(--color-success)]">
            {t('steward.vacuumResult', { b: formatBytes(vacuumBytes) })}
          </div>
        )}
      </Section>
    </div>
  )
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-[var(--color-sidebar)] rounded-lg border border-[var(--color-border)] p-4">
    <h3 className="text-sm font-semibold mb-3 text-[var(--color-accent)]">{title}</h3>
    <div className="space-y-1.5">{children}</div>
  </div>
)

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-4 text-sm">
    <span className="text-[var(--color-text-muted)] truncate">{label}</span>
    <span className="text-right">{value || '-'}</span>
  </div>
)
