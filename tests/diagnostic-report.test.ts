// 管家诊断报告纯函数测试（远程求助文本报告）
import { describe, it, expect } from 'vitest'
import { buildDiagnosticReport, type ReportLabels } from '../src/renderer/src/utils/diagnostic-report'
import type {
  AuditResult,
  DiagnoseResult,
  HardwareInfo,
  HealthReport,
  ModelRecommendation
} from '../src/shared/types'

/** 固定英文标签（测试不依赖 i18n，字段名稳定可断言） */
const L: ReportLabels = {
  title: 'PocketAI Diagnostic Report',
  generatedAt: 'Generated at',
  appVersion: 'App version',
  systemSection: 'System',
  recommendationSection: 'Model recommendation',
  healthSection: 'Data health',
  auditSection: 'Security check',
  diagnoseSection: 'Troubleshooting',
  notRun: 'Not run',
  notAvailable: 'No data',
  suggestion: 'Suggestion',
  fix: 'Fix',
  platform: 'Platform',
  arch: 'Arch',
  hostname: 'Hostname',
  cpu: 'CPU',
  cpuModel: 'Model',
  cores: 'Cores',
  memory: 'Memory',
  total: 'Total',
  free: 'Free',
  gpu: 'GPU',
  gpuNone: 'Not detected',
  driver: 'Driver',
  disk: 'Disk',
  drive: 'Drive',
  type: 'Type',
  mediumType: 'Medium',
  busType: 'Bus',
  volumeLabel: 'Volume',
  filesystem: 'FS',
  capacity: 'Capacity',
  freeSpace: 'Free space',
  removable: 'Removable',
  yes: 'Yes',
  no: 'No',
  /**
   * 156 起 `steward:model-recommend` 只回码 ⇒ 报告这一节按码取文案。
   * 这里给一张**测试专用的假字典**：断言"报告里出现的是解析后的文本"，
   * 而下面那条 not.toMatch(裸码) 断言才是重点——解析器没接上时，报告里会露出 `cpu_mainstream` 这种码。
   */
  rec: (kind, code, params) => {
    const text = REC_TEXT[`${kind}.${code}`] ?? `?${kind}.${code}?`
    return Object.entries(params ?? {}).reduce(
      (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
      text
    )
  },
  diskTypes: { ssd: 'SSD', hdd: 'HDD', usb: 'USB', unknown: 'Unknown' },
  ollamaRunning: 'Running',
  ollamaStopped: 'Stopped',
  installedModels: 'Installed models',
  onlineHint: 'Online advice',
  warnings: 'Warnings',
  integrity: 'DB integrity',
  totalConversations: 'Conversations',
  totalMessages: 'Messages',
  kbCount: 'Knowledge bases',
  attachSize: 'Attachments',
  orphanMessages: 'Orphan messages',
  orphanChunks: 'Orphan chunks',
  score: 'Security score',
  statusOk: 'OK',
  statusWarn: 'Warn',
  statusDanger: 'Danger'
}

/** 码 → 报告文本（只放本用例用到的几条） */
const REC_TEXT: Record<string, string> = {
  'tier.mainstream_cpu': 'Mainstream (CPU)',
  'summary.cpu_mainstream': 'CPU only, about 16GB RAM: 7B quantized is usable, 3B is smoother.',
  'summary.nv_flagship': 'Detected {gpu} (VRAM >=24GB).',
  'tag.primary': 'Top pick',
  'tag.alternate': 'Alternate',
  'reason.qwen7b_q4_cpu_pick': '7B quantized top pick on CPU',
  'reason.llama31_8b_english': 'Alternate for English and general ability',
  'onlineHint.general': 'Local models cover daily chat.',
  'warn.mem_lt8': 'Under 8GB RAM: prefer online models'
}

const hardware: HardwareInfo = {
  cpu: { model: 'Intel Core Ultra 7 155H', cores: 22 },
  memory: { total: 32 * 1024 ** 3, free: 16 * 1024 ** 3 },
  gpus: [
    { name: 'NVIDIA RTX 4060', memory: 8 * 1024 ** 3, driver: '32.0.15', cuda: true, mps: false }
  ],
  disk: {
    type: 'ssd',
    removable: false,
    drive: 'C:',
    volumeLabel: 'System',
    filesystem: 'NTFS',
    totalSpace: 1024 * 1024 ** 3,
    freeSpace: 512 * 1024 ** 3,
    mediumType: 'SSD',
    busType: 'NVMe'
  },
  os: { platform: 'win32', release: '10.0.22631', arch: 'x64', hostname: 'WORKSTATION' }
}

const health: HealthReport = {
  dbIntegrity: { ok: true, details: 'ok' },
  orphanMessages: 0,
  orphanChunks: 2,
  kbCount: 3,
  totalMessages: 1234,
  totalConversations: 56,
  totalAttachmentsBytes: 10 * 1024 ** 2
}

const recommendation: ModelRecommendation = {
  tier: 'mainstream_cpu',
  summary: 'cpu_mainstream',
  summaryParams: {},
  localPicks: [
    { id: 'qwen2.5:7b-instruct-q4_K_M', tag: 'primary', reason: 'qwen7b_q4_cpu_pick', installed: true },
    { id: 'llama3.1:8b', tag: 'alternate', reason: 'llama31_8b_english', installed: false }
  ],
  onlineHint: 'general',
  ollamaRunning: true,
  installedModels: ['qwen2.5:7b', 'nomic-embed-text'],
  warnings: ['mem_lt8']
}

const audit: AuditResult = {
  score: 90,
  checks: [
    { id: 'lock', label: '隐私锁', level: 'ok', detail: '已启用' },
    { id: 'key', label: 'API Key 存储', level: 'warn', detail: '未设主密码', suggestion: '设置主密码启用字段加密' }
  ]
}

const diagnose: DiagnoseResult = {
  items: [
    { id: 'db', label: '数据库', level: 'ok', detail: '正常' },
    { id: 'orphan', label: '孤儿向量块', level: 'warn', detail: '2 个', fix: '执行安全清理' }
  ]
}

const baseData = {
  generatedAt: new Date(2026, 9, 2, 14, 3, 5).getTime(),
  appVersion: '1.2.8',
  hardware,
  integrity: { ok: true, details: 'ok' },
  health,
  recommendation,
  audit,
  diagnose
}

describe('buildDiagnosticReport — 全量数据', () => {
  const report = buildDiagnosticReport(baseData, L)

  it('头部含标题/时间/版本（时间格式 YYYY-MM-DD HH:mm:ss）', () => {
    expect(report).toContain(L.title)
    expect(report).toContain('2026-10-02 14:03:05')
    expect(report).toContain('1.2.8')
  })

  it('① 硬件画像：CPU 型号核数/内存 GB/GPU 名称显存 CUDA/磁盘容量可移动', () => {
    expect(report).toContain('① System')
    expect(report).toContain('Intel Core Ultra 7 155H')
    expect(report).toContain('22')
    expect(report).toContain('32.0 GB')
    expect(report).toContain('NVIDIA RTX 4060')
    expect(report).toContain('8.0 GB')
    expect(report).toContain('CUDA')
    expect(report).toContain('C:')
    expect(report).toContain('NVMe')
  })

  it('② 模型推荐：档位/模型 id/已装标记/在线建议/警告', () => {
    expect(report).toContain('② Model recommendation')
    expect(report).toContain('qwen2.5:7b-instruct-q4_K_M')
    expect(report).toContain('llama3.1:8b')
    expect(report).toContain(L.installedModels + ': qwen2.5:7b, nomic-embed-text')
    expect(report).toContain('Mainstream (CPU)')
    expect(report).toContain('[Top pick] qwen2.5:7b-instruct-q4_K_M ✅')
    expect(report).toContain('7B quantized top pick on CPU')
    expect(report).toContain('Local models cover daily chat.')
    expect(report).toContain('Under 8GB RAM: prefer online models')
    // 解析器一旦没接上，报告里会露出裸码 —— 这条比"含文案"更硬
    expect(report).not.toMatch(/mainstream_cpu|cpu_mainstream|qwen7b_q4_cpu_pick|mem_lt8/)
  })

  it('③ 数据健康：完整性正常 + 各计数与附件占用', () => {
    expect(report).toContain('③ Data health')
    expect(report).toContain('✅ OK')
    expect(report).toContain('56')
    expect(report).toContain('1234')
    expect(report).toContain('10.0 MB')
  })

  it('④ 安全体检：分数 + 每项图标/标签/明细/建议行', () => {
    expect(report).toContain('④ Security check')
    expect(report).toContain('Security score: 90 / 100')
    expect(report).toContain('⚠️ API Key 存储 — 未设主密码')
    expect(report).toContain('Suggestion: 设置主密码启用字段加密')
  })

  it('⑤ 故障诊断：每项图标/明细/修复行', () => {
    expect(report).toContain('⑤ Troubleshooting')
    expect(report).toContain('⚠️ 孤儿向量块 — 2 个')
    expect(report).toContain('Fix: 执行安全清理')
  })

  it('五段顺序固定', () => {
    const i1 = report.indexOf('①')
    const i2 = report.indexOf('②')
    const i3 = report.indexOf('③')
    const i4 = report.indexOf('④')
    const i5 = report.indexOf('⑤')
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
    expect(i3).toBeLessThan(i4)
    expect(i4).toBeLessThan(i5)
  })
})

describe('buildDiagnosticReport — 缺失数据', () => {
  it('全 null 不抛错且段落标注 notRun/notAvailable', () => {
    const empty = buildDiagnosticReport(
      {
        generatedAt: Date.now(),
        appVersion: '',
        hardware: null,
        integrity: null,
        health: null,
        recommendation: null,
        audit: null,
        diagnose: null
      },
      L
    )
    expect(empty).toContain('① System')
    expect(empty).toContain(L.notAvailable)
    expect(empty).toContain('④ Security check')
    expect(empty).toContain(L.notRun)
    expect(empty).toContain('⑤ Troubleshooting')
    // 版本缺失显示占位
    expect(empty).toContain('App version: -')
  })

  it('体检已跑但无任何诊断项：显示整体正常而非空段', () => {
    const r = buildDiagnosticReport({ ...baseData, diagnose: { items: [] } }, L)
    expect(r).toContain('⑤ Troubleshooting')
    expect(r).toContain('✅ OK')
  })

  it('完整性异常输出 details', () => {
    const r = buildDiagnosticReport(
      { ...baseData, integrity: { ok: false, details: 'database disk image is malformed' } },
      L
    )
    expect(r).toContain('❌ database disk image is malformed')
  })

  it('无 GPU 时显示未检测到；可移动磁盘标注 Yes', () => {
    const noGpuHw: HardwareInfo = {
      ...hardware,
      gpus: [],
      disk: { ...hardware.disk, removable: true, type: 'usb' }
    }
    const r = buildDiagnosticReport({ ...baseData, hardware: noGpuHw }, L)
    expect(r).toContain(L.gpuNone)
    expect(r).toContain('Removable: Yes')
    expect(r).toContain('Type: USB')
  })
})
