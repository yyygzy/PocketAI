import React, { useEffect, useState } from 'react'
import type { HardwareInfo } from '../../../../shared/types'
import { useI18n } from '../../i18n'

export const StewardModule: React.FC = () => {
  const { t } = useI18n()
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [integrity, setIntegrity] = useState<{ ok: boolean; details: string } | null>(null)

  const load = () => {
    window.pocketai.getHardwareInfo().then(setHardware)
    window.pocketai.checkIntegrity().then(setIntegrity)
  }
  useEffect(() => {
    load()
  }, [])

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

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-text-muted)]">{t('steward.subtitle')}</p>
        <button onClick={load} className="btn-ghost text-xs">{t('steward.recheck')}</button>
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
