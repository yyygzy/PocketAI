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
import { logIpcError, reportIpcError, hasIpcFailed, ipcFailText } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { formatBytes } from '../../utils/format'
import { modelRecKey } from '../../../../shared/model-rec-codes'
import { buildDiagnosticReport, type ReportLabels } from '../../utils/diagnostic-report'
import { useToast } from '../../components/ToastProvider'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { StaleValueNotice } from '../../components/StaleValueNotice'
import { useOllamaPull, pickPullState } from '../../hooks/useOllamaPull'

const LEVEL_ICON: Record<CheckLevel, string> = { ok: '✅', warn: '⚠️', danger: '❌' }
const LEVEL_CLS: Record<CheckLevel, string> = {
  ok: 'text-[var(--color-success)]',
  warn: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]'
}

export const StewardModule: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [integrity, setIntegrity] = useState<{ ok: boolean; details: string } | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  // §258：这三发原本是裸值通道 ⇒ safeHandle 的失败对象 `{ok:false,error}` 是 truthy，
  // 而老写法只判那个变量的真值就把它当硬件快照用了 ⇒ 这一屏 render 当场 TypeError（整站进崩溃兜底屏）、
  // 完整性那行显示「❌ undefined」（＝谎报数据库损坏）、健康报告把"没读到"演成「✅ 0」孤儿。
  // 现在通道是信封、每发各留一句原因；成功时把原因收回（不留 §256 那种"陈旧谎报"）。
  const [hwFail, setHwFail] = useState<string | null>(null)
  const [integFail, setIntegFail] = useState<string | null>(null)
  const [healthFail, setHealthFail] = useState<string | null>(null)
  const [recommendation, setRecommendation] = useState<ModelRecommendation | null>(null)
  // §255：这一读失败时以前是"整块不出现"，用户分不清是没读到还是这台机器不该有
  const [recErr, setRecErr] = useState<string | null>(null)
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
  /** 诊断报告导出中（补跑体检/诊断+弹保存框，需禁用按钮） */
  const [exporting, setExporting] = useState(false)

  // 硬件画像在平台启动时由主进程采集一次并缓存：
  //  - 进入管家页面只读取缓存快照（force=false），不重复采集；
  //  - 完整性/健康报告是轻量 DB 统计，每次进入实时读取；
  //  - 用户点「重新检测」时 force=true 才重新执行硬件采集。
  // 模型推荐仅含一次本机 Ollama 端口探测，较轻；其硬件分级使用同一份缓存
  const refreshRecommendation = useCallback(() => {
    window.pocketai
      .recommendModels()
      .then((r) => {
        if (!r.ok || !r.data) {
          setRecErr(ipcFailText(r, t('common.unknownError')))
          return
        }
        setRecErr(null)
        setRecommendation(r.data)
      })
      .catch((e: unknown) => {
        setRecErr(errText(e, t('common.unknownError')))
        logIpcError('steward.recommendModels', e)
      })
  }, [t])

  // 拉取推荐模型：成功后重拉推荐刷新 installed 标记并 toast，失败 toast 展示错误
  const { pulling, pullEvt, pull: pullModel, abort: abortPull, stopUnread } = useOllamaPull({
    onDone: (model) => {
      refreshRecommendation()
      toast.success(`${t('ollama.pullDone')}：${model}`)
    },
    onError: (_model, msg) => toast.error(msg)
  })

  const load = useCallback(async (force = false) => {
    setRefreshing(true)
    const unknown = t('common.unknownError')
    try {
      // reject 面也归一成信封失败 ⇒ 下面每一发只有一条判据（`data: undefined` 是让两支同形状）
      const fail = (e: unknown) => ({ ok: false, data: undefined, error: errText(e, unknown) })
      const [hw, integ, healthReport] = await Promise.all([
        window.pocketai.getHardwareInfo(force).catch((e) => { logIpcError('steward.getHardwareInfo', e); return fail(e) }),
        window.pocketai.checkIntegrity().catch((e) => { logIpcError('steward.checkIntegrity', e); return fail(e) }),
        window.pocketai.getHealthReport().catch((e) => { logIpcError('steward.getHealthReport', e); return fail(e) })
      ])
      // 三发各自接管：读不到 ⇒ 这一块摆原因（旧快照一并清掉，不拿上一份冒充这一份）
      if (hasIpcFailed(hw) || !hw.data) {
        setHardware(null)
        setHwFail(ipcFailText(hw, unknown))
      } else {
        setHwFail(null)
        setHardware(hw.data)
      }
      if (hasIpcFailed(integ) || !integ.data) {
        setIntegrity(null)
        setIntegFail(ipcFailText(integ, unknown))
      } else {
        setIntegFail(null)
        setIntegrity(integ.data)
      }
      if (hasIpcFailed(healthReport) || !healthReport.data) {
        setHealth(null)
        setHealthFail(ipcFailText(healthReport, unknown))
      } else {
        setHealthFail(null)
        setHealth(healthReport.data)
      }
      refreshRecommendation()
      if (force) setManualCheckedAt(Date.now())
    } finally {
      setRefreshing(false)
    }
  }, [refreshRecommendation, t])

  // 仅在挂载时读取一次快照，不设定时器、不在每次点击时重新采集
  useEffect(() => {
    load(false)
  }, [load])

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const result = await window.pocketai.runCleanup()
      // §217：这条 try 只有 finally ⇒ 失败对象既不被 catch 也照样写进 state，清理面板报的是假数字
      if (hasIpcFailed(result)) {
        toast.error(ipcFailText(result, t('common.unknownError')))
        return
      }
      setCleanupResult(result)
      const report = await window.pocketai.getHealthReport()
      // §258：通道改信封 ⇒ 数据在 `report.data`；没带数据也算读不到（不许拿旧快照冒充刚清理完的状态）
      if (hasIpcFailed(report) || !report.data) {
        toast.error(ipcFailText(report, t('common.unknownError')))
        return
      }
      setHealthFail(null)
      setHealth(report.data)
      // 静默刷新诊断结果（孤儿数据可能已被清除）
      // §255 复核：这一发是"顺带更新"⇒ 设计内静默。§268 按实测改口两处原话：
      //  · 清理的可见回执是上面那块 `cleanupResult` 结果面板（:142 写／:682 渲染），不是 toast；
      //  · "上一份诊断还在屏上"只在用户先前手动跑过诊断时成立，否则那一块整块不出现（fail-closed）。
      // 闸门的单条 if 视角看不见这段注释，所以它仍留在 CAP 名单里计数（同 §251 的 995／1450 两档）
      window.pocketai.runDiagnose().then((r) => {
        if (r.ok && r.data) setDiagnose(r.data)
      }).catch(reportIpcError('steward.runDiagnose'))
    } finally {
      setCleaning(false)
    }
  }

  const handleVacuum = async () => {
    setCleaning(true)
    try {
      const bytes = await window.pocketai.runVacuum()
      // 失败不判就 setVacuumBytes({ok:false}) ⇒ 非有限值走 formatBytes 的 '-' ⇒ 界面显示「VACUUM 回收 -」，像真跑过（§216）
      if (hasIpcFailed(bytes)) {
        toast.error(ipcFailText(bytes, t('common.unknownError')))
        return
      }
      setVacuumBytes(bytes)
      const report = await window.pocketai.getHealthReport()
      // §258：同 handleCleanup——判失败面也判"没有数据"
      if (hasIpcFailed(report) || !report.data) {
        toast.error(ipcFailText(report, t('common.unknownError')))
        return
      }
      setHealthFail(null)
      setHealth(report.data)
    } finally {
      setCleaning(false)
    }
  }

  const handleAudit = async () => {
    setChecking('audit')
    try {
      const r = await window.pocketai.runAudit()
      // §255：这颗键是用户按的，失败却只把 checking 收掉——屏上什么都不说，看着像"点了没反应"
      if (!r.ok || !r.data) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      setAudit(r.data)
    } finally {
      setChecking(null)
    }
  }

  const handleDiagnose = async () => {
    setChecking('diagnose')
    try {
      const r = await window.pocketai.runDiagnose()
      if (!r.ok || !r.data) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      setDiagnose(r.data)
    } finally {
      setChecking(null)
    }
  }

  // 导出诊断报告（远程求助）：先补跑安全体检/故障诊断保证内容最新，
  // 再拼装纯文本交主进程弹保存框；体检/诊断失败容忍为 null（报告标注未运行）。
  const handleExport = async () => {
    setExporting(true)
    try {
      // §229：第三发原本是 `.catch(() => null)`，连痕都没留，报告里那行就退化成 `-`——
      // 一份拿去远程求助的纯文本说"版本未知"却不说是为什么未知；两个兄弟各自都有留痕。
      let versionReject: string | null = null
      const [auditRes, diagnoseRes, updateInfo] = await Promise.all([
        window.pocketai.runAudit().catch((e) => { logIpcError('steward.export.audit', e); return null }),
        window.pocketai.runDiagnose().catch((e) => { logIpcError('steward.export.diagnose', e); return null }),
        window.pocketai.getUpdateInfo().catch((e: unknown) => {
          versionReject = errText(e, t('common.unknownError'))
          logIpcError('steward.export.updateInfo', e)
          return null
        })
      ])
      // 读到就报版本号；没读到就把「读不到：原因」写进报告（那是一份纯文本，没有界面脸可挂）
      const appVersion = updateInfo && !hasIpcFailed(updateInfo)
        ? updateInfo.currentVersion
        : t('common.loadFailed', {
            msg: updateInfo ? ipcFailText(updateInfo, t('common.unknownError')) : versionReject ?? t('common.unknownError')
          })
      const nextAudit = auditRes?.ok && auditRes.data ? auditRes.data : audit
      const nextDiagnose = diagnoseRes?.ok && diagnoseRes.data ? diagnoseRes.data : diagnose
      if (auditRes?.ok && auditRes.data) setAudit(auditRes.data)
      if (diagnoseRes?.ok && diagnoseRes.data) setDiagnose(diagnoseRes.data)

      const labels: ReportLabels = {
        title: t('steward.reportTitle'),
        generatedAt: t('steward.reportGenTime'),
        appVersion: t('steward.reportVersion'),
        systemSection: t('steward.system'),
        recommendationSection: t('steward.reportSecRec'),
        healthSection: t('steward.dataHealth'),
        auditSection: t('steward.reportSecAudit'),
        diagnoseSection: t('steward.reportSecDiagnose'),
        notRun: t('steward.reportNotRun'),
        notAvailable: t('steward.reportNotAvailable'),
        suggestion: t('steward.reportSuggestion'),
        fix: t('steward.reportFix'),
        platform: t('steward.platform'),
        arch: t('steward.arch'),
        hostname: t('steward.hostname'),
        cpu: t('steward.cpu'),
        cpuModel: t('steward.cpuModel'),
        cores: t('steward.cores'),
        memory: t('steward.memory'),
        total: t('steward.total'),
        free: t('steward.free'),
        gpu: t('steward.gpu'),
        gpuNone: t('steward.notDetected'),
        driver: t('steward.driver'),
        disk: t('steward.disk'),
        drive: t('steward.drive'),
        type: t('steward.type'),
        mediumType: t('steward.mediumType'),
        busType: t('steward.busType'),
        volumeLabel: t('steward.volumeLabel'),
        filesystem: t('steward.filesystem'),
        capacity: t('steward.capacity'),
        freeSpace: t('steward.freeSpace'),
        removable: t('steward.removable'),
        yes: t('steward.portableYes'),
        no: t('steward.no'),
        diskTypes: {
          ssd: t('steward.dt.ssd'),
          hdd: t('steward.dt.hdd'),
          usb: t('steward.dt.usb'),
          unknown: t('steward.dt.unknown')
        },
        ollamaRunning: t('steward.ollamaRunning'),
        ollamaStopped: t('steward.ollamaStopped'),
        installedModels: t('steward.reportInstalledModels'),
        rec: (kind, code, params) => t(modelRecKey(kind, code), params),
        onlineHint: t('steward.reportOnlineHint'),
        warnings: t('steward.reportWarnings'),
        integrity: t('steward.integrity'),
        totalConversations: t('steward.totalConv'),
        totalMessages: t('steward.totalMessages'),
        kbCount: t('steward.kbCount'),
        attachSize: t('steward.attachSize'),
        orphanMessages: t('steward.orphanMessages'),
        orphanChunks: t('steward.orphanChunks'),
        score: t('steward.reportScore'),
        statusOk: t('steward.reportStatusOk'),
        statusWarn: t('steward.reportStatusWarn'),
        statusDanger: t('steward.reportStatusDanger')
      }

      const content = buildDiagnosticReport(
        {
          generatedAt: Date.now(),
          appVersion,
          hardware,
          integrity,
          health,
          recommendation,
          audit: nextAudit,
          diagnose: nextDiagnose
        },
        labels
      )
      const r = await window.pocketai.exportStewardReport(content)
      if (!r.ok) {
        toast.error(t('steward.exportFail'))
        return
      }
      if (!r.canceled) toast.success(t('steward.exportOk'))
    } catch (e) {
      logIpcError('steward.exportReport', e)
      toast.error(t('steward.exportFail'))
    } finally {
      setExporting(false)
    }
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
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => load(true)} disabled={refreshing} className="btn-ghost text-xs disabled:opacity-50">
            {refreshing ? t('steward.refreshing') : t('steward.recheck')}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            title={t('steward.reportTitle')}
            className="btn-ghost text-xs disabled:opacity-50"
          >
            {exporting ? t('steward.exporting') : t('steward.exportReport')}
          </button>
        </div>
      </div>

      {(integrity || integFail) && (
        <Section title={t('steward.integrity')}>
          {/* 两档互斥：读不到时 integrity 已被清空，不会同时摆 */}
          {integFail && <LoadFailNotice msg={integFail} />}
          {integrity && (
            <Row
              label="integrity_check"
              value={integrity.ok ? '✅ ok' : `❌ ${integrity.details}`}
            />
          )}
        </Section>
      )}

      {/* §258：读不到时这一整块不出现＝用户分不清"这台机器没有画像"还是"没读到"⇒ 同一块位置摆原因 */}
      {hwFail && (
        <Section title={t('steward.system')}>
          <LoadFailNotice msg={hwFail} />
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
      {!recommendation && recErr && (
        <Section title={t('steward.modelRec')}>
          <LoadFailNotice msg={recErr} />
        </Section>
      )}
      {recommendation && (
        <Section title={t('steward.modelRec')}>
          {/* §345：这一发会被 `load(force)` 与"拉完一个模型"重跑；失败侧旧推荐留着，
              但那三个档位徽标与「下载」那颗键都照旧值摆 ⇒ 要点名"没能刷新成最新" */}
          {recErr && (
            <div className="mb-2">
              <StaleValueNotice what={t('steward.modelRec')} msg={recErr} onRetry={refreshRecommendation} testid="steward-rec-stale-retry" />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-accent)] text-[var(--color-on-accent)]">
              {t(modelRecKey('tier', recommendation.tier))}
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
          <p className="text-xs text-[var(--color-text-muted)] mb-3 leading-relaxed">
            {t(modelRecKey('summary', recommendation.summary), recommendation.summaryParams)}
          </p>
          <div className="space-y-2">
            {recommendation.localPicks.map((p) => {
              const pullState = pickPullState({
                installed: p.installed,
                ollamaRunning: recommendation.ollamaRunning,
                pulling,
                model: p.id
              })
              return (
                <div key={p.id} className="rounded-lg border border-[var(--color-border)] p-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="badge badge-overlay">
                      {t(modelRecKey('tag', p.tag))}
                    </span>
                    <span className="font-mono text-xs">{p.id}</span>
                    {p.installed && (
                      <span className="text-[10px] text-[var(--color-success)]">{t('steward.installed')}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">
                    {t(modelRecKey('reason', p.reason))}
                  </p>
                  {pullState === 'pulling' && pullEvt ? (
                    <div className="mt-2 space-y-1">
                      <div className="h-1.5 rounded bg-[var(--color-hover-overlay)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                          style={{ width: `${pullEvt.percent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
                        <span className="truncate">
                          {t('ollama.pulling')} · {pullEvt.status} · {pullEvt.percent.toFixed(0)}%
                        </span>
                        <button
                          className="shrink-0 text-[var(--color-warning)] hover:underline"
                          onClick={abortPull}
                        >
                          ✕ {t('ollama.abort')}
                        </button>
                      </div>
                      {/* §267：那颗 ✕ 没送到 ⇒ 说一句（✕ 还挂着，再按一次就是重发，所以不另配重试键） */}
                      {stopUnread && (
                        <div role="alert" className="text-[10px] text-[var(--color-danger)] leading-relaxed">
                          {t('common.stopNotSent', { msg: ipcFailText(stopUnread, t('common.unknownError')) })}
                        </div>
                      )}
                    </div>
                  ) : pullState === 'pullable' || pullState === 'busy-other' || pullState === 'disabled' ? (
                    <div className="mt-1.5 flex justify-end">
                      <button
                        className="text-[10px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-50"
                        disabled={pullState !== 'pullable'}
                        title={pullState === 'disabled' ? t('steward.pullNeedRunning') : t(modelRecKey('reason', p.reason))}
                        onClick={() => void pullModel(p.id)}
                      >
                        ⬇️ {t('ollama.pullBtn')}
                      </button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-3 leading-relaxed">☁️ {t(modelRecKey('onlineHint', recommendation.onlineHint))}</p>
          {recommendation.warnings.length > 0 && (
            <div className="mt-2 space-y-1">
              {recommendation.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-[var(--color-warning)]">⚠️ {t(modelRecKey('warn', w))}</p>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 数据健康报告 */}
      {healthFail && (
        <Section title={t('steward.dataHealth')}>
          <LoadFailNotice msg={healthFail} />
        </Section>
      )}

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
