// 硬件信息采集（平台管家地基工具）
//
// Windows 说明：wmic 在 Windows 11 24H2+ 已被移除，因此统一改用 PowerShell CIM；
// Win32_VideoController.AdapterRAM 是 uint32，>4GB 显存会溢出，
// 故从注册表 HardwareInformation.qwMemorySize 读取真实显存。
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { HardwareInfo, GpuInfo, DiskInfo } from '../../shared/types'
import { APP_ROOT } from '../portable'

function getCpu() {
  const cpus = os.cpus()
  return {
    model: cpus[0]?.model?.trim() || 'unknown',
    cores: cpus.length
  }
}

function getMemory() {
  return {
    total: os.totalmem(),
    free: os.freemem()
  }
}

// ─── PowerShell 辅助（base64 EncodedCommand，规避引号转义问题） ──────

function runPowerShell(script: string): string | null {
  try {
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    })
    return out.trim()
  } catch {
    return null
  }
}

function parseJsonSafe<T>(text: string | null): T | null {
  if (!text) return null
  // 剥离 PowerShell 可能混入的 CLIXML/进度输出，截取首个 {...} 或 [...]
  const candidates = [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0)
  if (candidates.length === 0) return null
  const start = Math.min(...candidates)
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  if (end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

// ─── GPU ────────────────────────────────────────────────────────────

interface RawGpu {
  name: string
  memory: number | null
  driver: string | null
}

const GPU_PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$result = @()
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch 'Basic Display|Hyper-V' })
foreach ($g in $gpus) {
  $mem = [uint64]$g.AdapterRAM
  if ($g.PNPDeviceID) {
    $cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
    $matchId = $g.PNPDeviceID.ToLower()
    $sub = Get-ChildItem $cls | Where-Object {
      (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).MatchingDeviceId -eq $matchId
    } | Select-Object -First 1
    if ($sub) {
      $qw = (Get-ItemProperty $sub.PSPath -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
      if ($qw -and [uint64]$qw -gt $mem) { $mem = [uint64]$qw }
    }
  }
  $result += [pscustomobject]@{ name = $g.Name; memory = $mem; driver = $g.DriverVersion }
}
ConvertTo-Json -InputObject $result -Compress
`

function getGpusWin32(): GpuInfo[] {
  const raw = parseJsonSafe<RawGpu[] | RawGpu>(runPowerShell(GPU_PS_SCRIPT))
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter((g) => g?.name)
    .map((g) => ({
      name: String(g.name),
      memory: g.memory && g.memory > 0 ? g.memory : undefined,
      driver: g.driver || undefined,
      cuda: /nvidia/i.test(String(g.name)),
      mps: false
    }))
}

function getGpus(): GpuInfo[] {
  try {
    if (process.platform === 'win32') {
      return getGpusWin32()
    }
    if (process.platform === 'darwin') {
      const out = execSync('system_profiler SPDisplaysDataType', { encoding: 'utf8' })
      const gpus: GpuInfo[] = []
      const re = /Chipset Model:\s*(.+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(out))) {
        gpus.push({ name: m[1]!.trim(), cuda: false, mps: /apple/i.test(m[1]!) })
      }
      return gpus
    }
    // linux
    const out = execSync('lspci 2>/dev/null | grep -i vga', { encoding: 'utf8' })
    const gpus: GpuInfo[] = []
    for (const line of out.trim().split('\n')) {
      if (line) gpus.push({ name: line.trim(), cuda: /nvidia/i.test(line), mps: false })
    }
    return gpus
  } catch {
    return []
  }
}

// ─── 运行介质（APP_ROOT 所在磁盘） ─────────────────────────────────

interface RawDisk {
  drive: string | null
  label: string | null
  fs: string | null
  total: number | null
  free: number | null
  dtype: number | null // Win32_LogicalDisk.DriveType
  medium: string | null // MSFT_PhysicalDisk.MediaType（数字或字符串）
  bus: string | null // MSFT_PhysicalDisk.BusType（数字或字符串）
}

// MSFT_PhysicalDisk 枚举值映射
const MEDIA_MAP: Record<string, string> = { '3': 'HDD', '4': 'SSD', '5': 'Unspecified' }
const BUS_MAP: Record<string, string> = {
  '1': 'SCSI',
  '2': 'ATAPI',
  '3': 'ATA',
  '4': 'IEEE1394',
  '5': 'SSA',
  '6': 'FibreChannel',
  '7': 'USB',
  '8': 'RAID',
  '9': 'iSCSI',
  '10': 'SAS',
  '11': 'SATA',
  '12': 'SD',
  '13': 'MMC',
  '14': 'Virtual',
  '15': 'FileBackedVirtual',
  '17': 'NVMe'
}

function mapEnum(map: Record<string, string>, v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v)
  if (/^[0-9]+$/.test(s)) return map[s] ?? s
  return s
}

function getDiskWin32(driveLetter: string): DiskInfo {
  const info: DiskInfo = {
    type: 'unknown',
    removable: false,
    drive: `${driveLetter}:`,
    volumeLabel: null,
    filesystem: null,
    totalSpace: null,
    freeSpace: null,
    mediumType: null,
    busType: null
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$r = @{ drive = $null; label = $null; fs = $null; total = $null; free = $null; dtype = $null; medium = $null; bus = $null }
$ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveLetter}:'" | Select-Object -First 1
if ($ld) {
  $r.drive = $ld.DeviceID
  $r.label = $ld.VolumeName
  $r.fs = $ld.FileSystem
  $r.total = [string][uint64]$ld.Size
  $r.free = [string][uint64]$ld.FreeSpace
  $r.dtype = [int]$ld.DriveType
  $letter = $ld.DeviceID.TrimEnd(':')
  $part = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($part) {
    $pd = Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
    if ($pd) {
      $r.medium = [string]$pd.MediaType
      $r.bus = [string]$pd.BusType
    }
  }
}
ConvertTo-Json -InputObject $r -Compress
`
  const raw = parseJsonSafe<RawDisk>(runPowerShell(script))
  if (!raw) return info

  info.volumeLabel = raw.label || null
  info.filesystem = raw.fs || null
  info.totalSpace = raw.total ? Number(raw.total) : null
  info.freeSpace = raw.free ? Number(raw.free) : null
  info.mediumType = mapEnum(MEDIA_MAP, raw.medium)
  info.busType = mapEnum(BUS_MAP, raw.bus)

  const isRemovable = raw.dtype === 2 || info.busType === 'USB'
  if (isRemovable) {
    info.type = 'usb'
    info.removable = true
  } else if (info.mediumType === 'SSD') {
    info.type = 'ssd'
  } else if (info.mediumType === 'HDD') {
    info.type = 'hdd'
  } else if (raw.dtype === 3) {
    // 无法识别物理介质时沿用旧行为：本地盘按 SSD 展示
    info.type = 'ssd'
  }
  return info
}

function getDisk(): DiskInfo {
  try {
    if (process.platform === 'win32') {
      const drive = APP_ROOT.match(/^([A-Za-z]):/)?.[1]?.toUpperCase()
      if (drive) return getDiskWin32(drive)
      return { type: 'unknown', removable: false, drive: null, volumeLabel: null, filesystem: null, totalSpace: null, freeSpace: null, mediumType: null, busType: null }
    }
    const info: DiskInfo = {
      type: 'unknown',
      removable: false,
      drive: null,
      volumeLabel: null,
      filesystem: null,
      totalSpace: null,
      freeSpace: null,
      mediumType: null,
      busType: null
    }
    if (process.platform === 'darwin') {
      const out = execSync(`diskutil info "${APP_ROOT}" | grep "Removable Media"`, { encoding: 'utf8' })
      info.removable = /Removable/i.test(out) && !/Fixed/i.test(out)
      info.type = info.removable ? 'usb' : 'ssd'
    }
    return info
  } catch {
    return { type: 'unknown', removable: false, drive: null, volumeLabel: null, filesystem: null, totalSpace: null, freeSpace: null, mediumType: null, busType: null }
  }
}

/** 实际执行一次硬件采集（CPU/内存/GPU/磁盘/系统，可能调用系统命令，较重） */
function collectHardwareInfo(): HardwareInfo {
  return {
    cpu: getCpu(),
    memory: getMemory(),
    gpus: getGpus(),
    disk: getDisk(),
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      hostname: os.hostname()
    }
  }
}

// 硬件画像在平台启动时只采集一次，之后复用快照；
// 用户在管家页面点「重新检测」时才通过 refreshHardwareInfo() 重新采集。
let cachedHardware: HardwareInfo | null = null

/** 获取硬件画像（首次调用时采集并缓存，后续直接返回快照） */
export function getHardwareInfo(): HardwareInfo {
  if (!cachedHardware) {
    cachedHardware = collectHardwareInfo()
  }
  return cachedHardware
}

/** 重新采集硬件画像并刷新缓存（仅响应用户手动刷新） */
export function refreshHardwareInfo(): HardwareInfo {
  cachedHardware = collectHardwareInfo()
  return cachedHardware
}

// ─── 硬盘物理序列号指纹（License 绑定用） ────────────────────────────
//
// 设计目标：APP_ROOT 所在物理硬盘的出厂序列号，跨系统一致、不可篡改。
// 用于 Node-locked License：一个 license.lic 只能在这一个硬盘上使用，
// 但同一硬盘插任意电脑都能验签通过（符合便携定位）。
//
// 注意：用序列号的 SHA-256 作为 fingerprint，避免明文暴露硬件信息。

function getDiskSerialWin32(): string | null {
  // APP_ROOT 形如 E:\...，取盘符
  const drive = APP_ROOT.match(/^([A-Za-z]):/)?.[1]?.toUpperCase()
  if (!drive) return null
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$letter = '${drive}'
$part = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $part) { exit 0 }
$pd = Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
if ($pd -and $pd.SerialNumber) { Write-Output $pd.SerialNumber.Trim() }
`
  const out = runPowerShell(script)
  return out && out.trim() ? out.trim() : null
}

function getDiskSerialDarwin(): string | null {
  try {
    // 1. 找到 APP_ROOT 所在卷的设备标识，如 disk2s1
    const info = execSync(`diskutil info "${APP_ROOT}"`, { encoding: 'utf8' })
    const devMatch = info.match(/Device Identifier:\s*(disk\d+)(?:s\d+)?/)
    if (!devMatch) return null
    const wholeDisk = devMatch[1] // disk2

    // 2. 从该物理盘的 IORegistry 中取序列号
    //    IOBlockStorageDriver 节点下有 BSD Name = disk2，其父节点 IOBlockStorageDevice 有 Serial Number
    const ioreg = execSync(
      `ioreg -c IOBlockStorageDriver -r -l -w 0`,
      { encoding: 'utf8' }
    )
    // 按 "+-o" 分割每个设备块
    const blocks = ioreg.split(/\+-o /)
    for (const block of blocks) {
      if (new RegExp(`"BSD Name"\\s*=\\s*"${wholeDisk}"`).test(block)) {
        const snMatch = block.match(/"Serial Number"\s*=\s*"([^"]+)"/)
        if (snMatch) return snMatch[1]!.trim()
      }
    }
    return null
  } catch {
    return null
  }
}

function getDiskSerialLinux(): string | null {
  try {
    // 找 APP_ROOT 所在设备
    const stat = execSync(`df "${APP_ROOT}" | tail -1`, { encoding: 'utf8' })
    const devMatch = stat.match(/^(\/dev\/[a-z]+\d*)/)
    if (!devMatch) return null
    // /dev/sdb1 → /sys/block/sdb/device/serial
    let dev = devMatch[1]!.replace('/dev/', '')
    // 去掉分区号
    dev = dev.replace(/\d+$/, '')
    const serial = execSync(`cat /sys/block/${dev}/device/serial 2>/dev/null`, { encoding: 'utf8' }).trim()
    return serial || null
  } catch {
    return null
  }
}

/** 缓存的硬盘指纹，避免每次验签都跑系统命令 */
let cachedFingerprint: string | null | undefined = undefined

/**
 * 获取 APP_ROOT 所在硬盘的物理序列号指纹（SHA-256 前 16 位 hex）。
 * 同一硬盘跨系统一致；返回 null 表示无法获取（此时 License 不绑定设备）。
 */
export function getDiskFingerprint(): string | null {
  if (cachedFingerprint !== undefined) return cachedFingerprint
  let serial: string | null = null
  try {
    if (process.platform === 'win32') serial = getDiskSerialWin32()
    else if (process.platform === 'darwin') serial = getDiskSerialDarwin()
    else serial = getDiskSerialLinux()
  } catch {
    serial = null
  }
  if (!serial) {
    cachedFingerprint = null
    return null
  }
  cachedFingerprint = createHash('sha256').update(serial).digest('hex').slice(0, 16)
  return cachedFingerprint
}
