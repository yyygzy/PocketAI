// 平台管家诊断报告拼装（纯函数，可单测）：
// 六块数据全部在管家页渲染端 state，此处零 IPC 拼装为纯文本，主进程只负责落盘。
// 标签通过 ReportLabels 注入（UI 从 i18n 构造），保证语言跟随界面且函数可测。
// 报告用途=远程求助：段落顺序固定，缺失段落不省略（标注未运行/无数据）。
import type {
  AuditResult,
  CheckLevel,
  DiagnoseResult,
  HardwareInfo,
  HealthReport,
  ModelRecommendation
} from '../../../shared/types'
import { formatBytes } from './format'

export interface DiagnosticReportData {
  generatedAt: number
  appVersion: string
  hardware: HardwareInfo | null
  integrity: { ok: boolean; details: string } | null
  health: HealthReport | null
  recommendation: ModelRecommendation | null
  audit: AuditResult | null
  diagnose: DiagnoseResult | null
}

/** 报告本地化标签（由 StewardModule 从 t() 构造） */
export interface ReportLabels {
  title: string
  generatedAt: string
  appVersion: string
  // 段落
  systemSection: string
  recommendationSection: string
  healthSection: string
  auditSection: string
  diagnoseSection: string
  // 通用
  notRun: string
  notAvailable: string
  suggestion: string
  fix: string
  // 硬件字段
  platform: string
  arch: string
  hostname: string
  cpu: string
  cpuModel: string
  cores: string
  memory: string
  total: string
  free: string
  gpu: string
  gpuNone: string
  driver: string
  disk: string
  drive: string
  type: string
  mediumType: string
  busType: string
  volumeLabel: string
  filesystem: string
  capacity: string
  freeSpace: string
  removable: string
  yes: string
  no: string
  diskTypes: Record<'ssd' | 'hdd' | 'usb' | 'unknown', string>
  // 推荐字段
  ollamaRunning: string
  ollamaStopped: string
  installedModels: string
  onlineHint: string
  warnings: string
  // 健康字段
  integrity: string
  totalConversations: string
  totalMessages: string
  kbCount: string
  attachSize: string
  orphanMessages: string
  orphanChunks: string
  score: string
  statusOk: string
  statusWarn: string
  statusDanger: string
}

const LEVEL_MARK: Record<CheckLevel, string> = { ok: '✅', warn: '⚠️', danger: '❌' }

/** 本地时间 YYYY-MM-DD HH:mm:ss（手动 pad，不依赖 locale） */
function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function section(title: string, body: string[]): string {
  return `\n${title}\n${'─'.repeat(28)}\n${body.join('\n')}\n`
}

function kv(label: string, value: string): string {
  return `${label}: ${value || '-'}`
}

export function buildDiagnosticReport(d: DiagnosticReportData, L: ReportLabels): string {
  const lines: string[] = []
  lines.push(L.title)
  lines.push('='.repeat(40))
  lines.push(kv(L.generatedAt, fmtDateTime(d.generatedAt)))
  lines.push(kv(L.appVersion, d.appVersion || '-'))

  // ① 硬件画像 + 系统
  if (d.hardware) {
    const hw = d.hardware
    const sysBody = [
      kv(L.platform, `${hw.os.platform} ${hw.os.release}`.trim()),
      kv(L.arch, hw.os.arch)
    ]
    if (hw.os.hostname) sysBody.push(kv(L.hostname, hw.os.hostname))
    sysBody.push(
      '',
      `[${L.cpu}]`,
      kv(L.cpuModel, hw.cpu.model),
      kv(L.cores, String(hw.cpu.cores)),
      '',
      `[${L.memory}]`,
      kv(L.total, formatBytes(hw.memory.total)),
      kv(L.free, formatBytes(hw.memory.free)),
      '',
      `[${L.gpu}]`
    )
    if (hw.gpus.length === 0) {
      sysBody.push(L.gpuNone)
    } else {
      hw.gpus.forEach((g, i) => {
        const extras = [
          g.memory ? formatBytes(g.memory) : '',
          g.driver ? `${L.driver} ${g.driver}` : '',
          g.cuda ? 'CUDA' : '',
          g.mps ? 'MPS' : ''
        ].filter(Boolean)
        sysBody.push(`${i + 1}. ${g.name}${extras.length ? ` (${extras.join(' / ')})` : ''}`)
      })
    }
    sysBody.push('', `[${L.disk}]`)
    if (hw.disk.drive) sysBody.push(kv(L.drive, hw.disk.drive))
    sysBody.push(kv(L.type, L.diskTypes[hw.disk.type] ?? hw.disk.type))
    if (hw.disk.mediumType) sysBody.push(kv(L.mediumType, hw.disk.mediumType))
    if (hw.disk.busType) sysBody.push(kv(L.busType, hw.disk.busType))
    if (hw.disk.volumeLabel) sysBody.push(kv(L.volumeLabel, hw.disk.volumeLabel))
    if (hw.disk.filesystem) sysBody.push(kv(L.filesystem, hw.disk.filesystem))
    if (hw.disk.totalSpace != null) sysBody.push(kv(L.capacity, formatBytes(hw.disk.totalSpace)))
    if (hw.disk.freeSpace != null) sysBody.push(kv(L.freeSpace, formatBytes(hw.disk.freeSpace)))
    sysBody.push(kv(L.removable, hw.disk.removable ? L.yes : L.no))
    lines.push(section(`① ${L.systemSection}`, sysBody))
  } else {
    lines.push(section(`① ${L.systemSection}`, [L.notAvailable]))
  }

  // ② 模型推荐
  if (d.recommendation) {
    const r = d.recommendation
    const body = [
      r.tier,
      r.summary,
      '',
      kv('Ollama', r.ollamaRunning ? L.ollamaRunning : L.ollamaStopped),
      kv(L.installedModels, r.installedModels.length ? r.installedModels.join(', ') : '-'),
      ''
    ]
    r.localPicks.forEach((p) => {
      body.push(`[${p.tag}] ${p.id} ${p.installed ? '✅' : ''}`.trimEnd())
      body.push(`    ${p.reason}`)
    })
    body.push('', `${L.onlineHint}: ${r.onlineHint}`)
    if (r.warnings.length) body.push('', `${L.warnings}:`, ...r.warnings.map((w) => `⚠️ ${w}`))
    lines.push(section(`② ${L.recommendationSection}`, body))
  } else {
    lines.push(section(`② ${L.recommendationSection}`, [L.notAvailable]))
  }

  // ③ 数据健康
  const healthBody: string[] = []
  if (d.integrity) {
    healthBody.push(
      d.integrity.ok
        ? `${L.integrity}: ✅ ${L.statusOk}`
        : `${L.integrity}: ❌ ${d.integrity.details}`
    )
  } else {
    healthBody.push(`${L.integrity}: ${L.notAvailable}`)
  }
  if (d.health) {
    const h = d.health
    healthBody.push(
      kv(L.totalConversations, String(h.totalConversations)),
      kv(L.totalMessages, String(h.totalMessages)),
      kv(L.kbCount, String(h.kbCount)),
      kv(L.attachSize, formatBytes(h.totalAttachmentsBytes)),
      kv(L.orphanMessages, String(h.orphanMessages)),
      kv(L.orphanChunks, String(h.orphanChunks))
    )
  } else {
    healthBody.push(L.notAvailable)
  }
  lines.push(section(`③ ${L.healthSection}`, healthBody))

  // ④ 安全体检
  if (d.audit) {
    const body: string[] = [`${L.score}: ${d.audit.score} / 100`, '']
    for (const c of d.audit.checks) {
      body.push(`${LEVEL_MARK[c.level]} ${c.label} — ${c.detail}`)
      if (c.suggestion) body.push(`    ${L.suggestion}: ${c.suggestion}`)
    }
    lines.push(section(`④ ${L.auditSection}`, body))
  } else {
    lines.push(section(`④ ${L.auditSection}`, [L.notRun]))
  }

  // ⑤ 故障诊断
  if (d.diagnose) {
    const body: string[] = []
    d.diagnose.items.forEach((it) => {
      body.push(`${LEVEL_MARK[it.level]} ${it.label} — ${it.detail}`)
      if (it.fix) body.push(`    ${L.fix}: ${it.fix}`)
    })
    lines.push(section(`⑤ ${L.diagnoseSection}`, body.length ? body : [`✅ ${L.statusOk}`]))
  } else {
    lines.push(section(`⑤ ${L.diagnoseSection}`, [L.notRun]))
  }

  return lines.join('\n')
}
