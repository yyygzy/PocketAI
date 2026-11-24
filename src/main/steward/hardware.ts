// 硬件信息采集（平台管家地基工具）
//
// Windows 说明：wmic 在 Windows 11 24H2+ 已被移除，因此统一改用 PowerShell CIM；
// Win32_VideoController.AdapterRAM 是 uint32，>4GB 显存会溢出，
// 故从注册表 HardwareInformation.qwMemorySize 读取真实显存。
import os from 'node:os'
import fs from 'node:fs'
import { execSync, execFileSync, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { HardwareInfo, GpuInfo, DiskInfo, HardwareProbeState } from '../../shared/types'
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

// ─── WSL 识别 ───────────────────────────────────────────────────────
// WSL2 的 /proc、os.totalmem() 与 df 看到的是虚拟机自己的视图（内存受 .wslconfig 限制、
// 磁盘是 ext4.vhdx），不是宿主机真值。这里只认可证伪的内核/环境证据，绝不按 "linux" 就猜。

export function isWslEnv(
  procVersion: string | null,
  osRelease: string | null,
  env: Record<string, string | undefined> = process.env
): boolean {
  return /microsoft|wsl/i.test(`${procVersion ?? ''} ${osRelease ?? ''}`) || Boolean(env.WSL_DISTRO_NAME)
}

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  try {
    if (isWslEnv(fs.readFileSync('/proc/version', 'utf8'), os.release())) return true
  } catch {
    // 权限/容器里读不到就再看环境变量
  }
  return isWslEnv(null, null)
}

/** 宿主机 PowerShell 路径；环境变量可覆盖，便于非标准挂载点 */
export function wslPowerShellExe(exists: (p: string) => boolean = (p) => fs.existsSync(p)): string | null {
  const override = process.env.POCKETAI_WSL_POWERSHELL
  if (override && exists(override)) return override
  return [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe'
  ].find(exists) ?? null
}

/** `wslpath -w` 的输出 → 宿主机盘符；非 Windows 路径返回 null（不许默认 C:） */
export function windowsDriveFromWslPath(windowsPath: string | null): string | null {
  const m = String(windowsPath ?? '').match(/^([A-Za-z]):[\\/]/)
  return m ? m[1]!.toUpperCase() : null
}

function wslWindowsDrive(): string | null {
  try {
    const out = execFileSync('wslpath', ['-w', APP_ROOT], { encoding: 'utf8', timeout: 3000 })
    return windowsDriveFromWslPath(out.trim())
  } catch {
    return null
  }
}

// ─── PowerShell 辅助（base64 EncodedCommand，规避引号转义问题） ──────

function runPowerShellWith(exe: string, script: string): string | null {
  try {
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    // execFileSync + 参数数组：不经 cmd 解析，安装路径/设备名里的引号与元字符无从逃逸（SEC-21）
    const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    })
    return out.trim()
  } catch {
    return null
  }
}

function runPowerShell(script: string): string | null {
  return runPowerShellWith('powershell', script)
}

/**
 * 异步版 PowerShell：**启动路径上只许用这条**。
 * execFileSync 在真机上能把主线程钉住 15–30s（PowerShell 冷启动 8s + CIM 查询 10–20s），
 * 期间窗口导航、8s 加载重试与 12s 显示兜底计时器全部被推迟——2026-11-16 冷启动白屏的根因。
 */
function runPowerShellAsyncWith(exe: string, script: string, timeoutMs: number): Promise<string | null> {
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { encoding: 'utf8', timeout: Math.max(1000, Math.floor(timeoutMs)), windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).trim())
    )
  })
}

function runPowerShellAsync(script: string, timeoutMs: number): Promise<string | null> {
  return runPowerShellAsyncWith('powershell', script, timeoutMs)
}

export function parseJsonSafe<T>(text: string | null): T | null {
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
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch 'Basic Display|Hyper-V|Virtual Display|Remote Display|GameViewer|VirtualBox|VMware|Parallels|QXL|virtio' })
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

/** 常见虚拟/远程显示适配器：不是机器上的真实显卡，画进硬件画像只会误导模型档位判断 */
const VIRTUAL_GPU_NAME_RE = /basic display|hyper-v|virtual display|remote display|gameviewer|virtualbox|vmware|parallels|qxl|virtio/i

export function isVirtualGpuName(name: string): boolean {
  return VIRTUAL_GPU_NAME_RE.test(String(name ?? ''))
}

export function parseGpuRows(text: string | null): GpuInfo[] {
  const raw = parseJsonSafe<RawGpu[] | RawGpu>(text)
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter((g) => g?.name && !isVirtualGpuName(String(g.name)))
    .map((g) => ({
      name: String(g.name),
      memory: g.memory && g.memory > 0 ? g.memory : undefined,
      driver: g.driver || undefined,
      cuda: /nvidia/i.test(String(g.name)),
      mps: false
    }))
}

function getGpusWin32(): GpuInfo[] {
  return parseGpuRows(runPowerShell(GPU_PS_SCRIPT))
}

// ─── 实占显存（V4-Iter-140）────────────────────────────────────────
//
// 为什么不能从 WMI 拿：Win32_VideoController 只有总量，没有"当前已用"。
// 为什么只认 nvidia-smi：它是唯一能在无驱动之外给出**实占**的本地命令；
// AMD/Mac/CPU-only 一律留 undefined（判据据此退回保守档），**不填估算值**——
// 填了就会被当成测得的事实，这正是 V-0 之前我犯过的错。
const NVIDIA_SMI_ARGS = ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits']

export interface NvidiaSmiRow {
  name: string
  /** MiB；解析不出数字时为 null（不许当 0） */
  totalMiB: number | null
  usedMiB: number | null
}

/** nvidia-smi 的 CSV 输出解析（纯函数，用例直接喂真实输出当 fixture） */
export function parseNvidiaSmiCsv(text: string | null | undefined): NvidiaSmiRow[] {
  const out: NvidiaSmiRow[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',').map((p) => p.trim())
    const name = parts[0] ?? ''
    if (!name) continue
    // nounits 出来是 "4096" / "0"；某些驱动会带 " MiB" 后缀，剥掉非数字再解
    const toMiB = (v: string | undefined): number | null => {
      const digits = String(v ?? '').replace(/[^\d.]/g, '')
      if (!digits) return null
      const n = Number(digits)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
    }
    out.push({ name, totalMiB: toMiB(parts[1]), usedMiB: toMiB(parts[2]) })
  }
  return out
}

function queryNvidiaSmi(): NvidiaSmiRow[] {
  if (process.platform === 'darwin') return []
  // Windows 下 System32 里是 nvidia-smi.exe；先试带扩展名，PATH 解析失败再试裸名
  const exes = process.platform === 'win32' ? ['nvidia-smi.exe', 'nvidia-smi'] : ['nvidia-smi']
  for (const exe of exes) {
    try {
      const out = execFileSync(exe, NVIDIA_SMI_ARGS, { encoding: 'utf8', timeout: 3000 })
      const rows = parseNvidiaSmiCsv(out)
      if (rows.length > 0) return rows
    } catch {
      // 命令不存在 / 驱动不在场：当作"未测得"，交由调用方退回保守档
    }
  }
  return []
}

/**
 * **异步**现采一次显存实占（V4-Iter-146 判据屏用；boot 那条走上面的同步版）。
 *
 * 为什么要单开一条异步的：`execFileSync` 最坏 3s 会把主进程事件循环钉住。boot 阶段付一次无所谓，
 * 但"进设置页那一屏就采一次"是用户随时会做的事，卡住的是一整条推理流 + 所有 IPC + 窗口消息。
 * 采不到（无独显 / 驱动不在 / Mac / 超时）一律返回空数组 ⇒ 界面画"采不到"，
 * **不许填估算值**（填了就会被当成测得的事实，这正是 V-0 之前犯过的错，见上面注释）。
 */
export async function readGpuMemoryLive(): Promise<NvidiaSmiRow[]> {
  if (process.platform === 'darwin') return []
  const exes = process.platform === 'win32' ? ['nvidia-smi.exe', 'nvidia-smi'] : ['nvidia-smi']
  for (const exe of exes) {
    // execFile **只在真要采的时候取**：本仓有整模块打桩 `node:child_process` 的用例
    // （hardware-nvidia-usage 只给了 execFileSync），模块顶层留一个 `promisify(execFile)`
    // 就会在 import 阶段因为"mock 里没这个导出"而炸掉那个文件。
    const stdout = await new Promise<string | null>((resolve) => {
      execFile(exe, NVIDIA_SMI_ARGS, { encoding: 'utf8', timeout: 3000 }, (err, out) => resolve(err ? null : String(out)))
    })
    const rows = parseNvidiaSmiCsv(stdout)
    if (rows.length > 0) return rows
  }
  return []
}

const normalizeGpuName = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * 把 nvidia-smi 的行挂到 WMI/lspci 采到的 GPU 上（纯函数：用例直接喂两张表，不用起进程）。
 * 匹配不上一律不挂 —— **绝不按数组顺序硬配**，多卡机器上两边顺序并不保证一致。
 */
export function applyNvidiaRows(gpus: GpuInfo[], rows: NvidiaSmiRow[]): GpuInfo[] {
  if (rows.length === 0) return gpus
  return gpus.map((g) => {
    if (!g.cuda) return g
    const target = normalizeGpuName(g.name)
    const row =
      rows.find((r) => normalizeGpuName(r.name) === target) ??
      (gpus.length === 1 && rows.length === 1 ? rows[0] : undefined)
    if (!row) return g
    if (row.usedMiB === null) {
      // 解不出"已用"就什么都不写 —— 把 null 当 0 等于谎报"显存全空闲"
      const total = g.memory ?? (row.totalMiB === null ? undefined : row.totalMiB * 1048576)
      return total === undefined || total === g.memory ? g : { ...g, memory: total }
    }
    return {
      ...g,
      usedMemory: row.usedMiB * 1048576,
      // WMI 那边偶有 AdapterRAM 缺失/溢出的卡，nvidia-smi 的总量补得上就顺手补，补不上维持原值
      memory: g.memory ?? (row.totalMiB === null ? undefined : row.totalMiB * 1048576)
    }
  })
}

/**
 * 只有 NVIDIA 卡在场才去探测：核显机器不必为一条注定失败的命令付进程创建开销。
 * Mac 走不到这里——统一内存不等于显存，留空比填估算值诚实。
 */
function attachUsedMemory(gpus: GpuInfo[]): GpuInfo[] {
  if (!gpus.some((g) => g.cuda)) return gpus
  return applyNvidiaRows(gpus, queryNvidiaSmi())
}

function getGpus(): GpuInfo[] {
  try {
    if (process.platform === 'win32') {
      return attachUsedMemory(getGpusWin32())
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
    // lspci 的名字与 nvidia-smi 不同形，单卡时靠"一对一"兜底；多卡对不上就不填（见 applyNvidiaRows）
    return attachUsedMemory(gpus)
  } catch {
    return []
  }
}

/**
 * Windows GPU 采集（异步）：`ok=false` 表示**这次没采到**（PowerShell 失败/超时），
 * 不是"这台机器没有显卡"——界面据此区分「没测到」与「未检测到独显」。
 */
async function probeGpusWin32(deadline: number, exe = 'powershell'): Promise<{ gpus: GpuInfo[]; ok: boolean }> {
  const text = await runPowerShellAsyncWith(exe, GPU_PS_SCRIPT, deadline - Date.now())
  // 解析不出 JSON（null / 被超时杀掉）⇒ 没采到；输出 `[]` 才是"确实没有可报告的显卡"
  if (text === null || parseJsonSafe<RawGpu[] | RawGpu>(text) === null) return { gpus: [], ok: false }
  const gpus = parseGpuRows(text)
  if (!gpus.some((g) => g.cuda)) return { gpus, ok: true }
  // 预算已经花光就不再为 nvidia-smi 多付一条进程：返回的总量仍然是 WMI 的真实读数
  if (deadline - Date.now() < 500) return { gpus, ok: true }
  return { gpus: applyNvidiaRows(gpus, await readGpuMemoryLive()), ok: true }
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

export function mapEnum(map: Record<string, string>, v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v)
  if (/^[0-9]+$/.test(s)) return map[s] ?? s
  return s
}

/**
 * §377：介质没探测出来就是"不知道"——本地盘不许推断成 SSD（机械盘被画成 SSD 会把用户支去慢盘上还以为快；
 * 同文件 GPU 段早就立了"不许填估算值"的纪律，这里不能例外）。
 * 只有三类证据才给结论：可移除（DriveType=2 或总线 USB）→ usb；物理盘报了介质 → ssd/hdd；其余 → unknown。
 */
export function deriveDiskTypeWin32(input: {
  dtype: number | null
  mediumType: string | null
  busType: string | null
}): DiskInfo['type'] {
  if (input.dtype === 2 || input.busType === 'USB') return 'usb'
  if (input.mediumType === 'SSD') return 'ssd'
  if (input.mediumType === 'HDD') return 'hdd'
  return 'unknown'
}

/** §377：diskutil 那行只分得出可移动与固定，固定卷是 SSD 还是 HDD 它没说 ⇒ 不许替它说 */
export function deriveDiskTypeDarwin(removable: boolean): DiskInfo['type'] {
  return removable ? 'usb' : 'unknown'
}

function emptyDiskWin32(driveLetter: string): DiskInfo {
  return {
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
}

/**
 * 磁盘快段：盘符/卷标/文件系统/容量/DriveType 只查 `Win32_LogicalDisk`。
 *
 * 为什么要把磁盘探测拆成两段：同一条脚本里混进 `Get-Partition` + `Get-PhysicalDisk`
 * （为了拿介质/总线）会让整条命令在本机跑到 22–36s——30s 的向导预算必被它吃光，
 * 结果连"磁盘多大、还剩多少"这种本来 10s 就能拿到的真数据都一起丢了。
 * 拆开后快段独立负责 `got.disk`，慢段只补 type/medium/bus，慢段失败不影响快段读数。
 */
function logicalDiskPsScript(driveLetter: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$r = @{ drive = $null; label = $null; fs = $null; total = $null; free = $null; dtype = $null }
$ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveLetter}:'" | Select-Object -First 1
if ($ld) {
  $r.drive = $ld.DeviceID
  $r.label = $ld.VolumeName
  $r.fs = $ld.FileSystem
  $r.total = [string][uint64]$ld.Size
  $r.free = [string][uint64]$ld.FreeSpace
  $r.dtype = [int]$ld.DriveType
}
ConvertTo-Json -InputObject $r -Compress
`
}

/**
 * 磁盘慢段：只补介质（HDD/SSD）与总线（NVMe/SATA/USB）。
 *
 * 不用 `Get-Partition`/`Get-PhysicalDisk`（本机单独 22.56s，加载 Storage 模块太贵），
 * 改走 `Win32_LogicalDiskToPartition` 关联 + Storage 命名空间直查 `MSFT_PhysicalDisk`
 * （本机 11.38s，读数与 cmdlet 那条一致：SSD / NVMe）。
 * 拿不到就什么都不写——留下 unknown 由 §377 的派生规则处理，绝不猜。
 */
function physicalDiskPsScript(driveLetter: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$r = @{ medium = $null; bus = $null }
$link = Get-CimInstance -ClassName Win32_LogicalDiskToPartition | Where-Object { [string]$_.Dependent.DeviceID -eq '${driveLetter}:' } | Select-Object -First 1
if ($link) {
  $idx = $null
  if ([string]$link.Antecedent.DeviceID -match 'Disk #(\\d+)') { $idx = $matches[1] }
  if ($idx -ne $null) {
    $pd = Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk -Filter "DeviceId='$idx'" | Select-Object -First 1
    if ($pd) {
      $r.medium = [string]$pd.MediaType
      $r.bus = [string]$pd.BusType
    }
  }
}
ConvertTo-Json -InputObject $r -Compress
`
}

function applyDiskRaw(info: DiskInfo, raw: RawDisk | null): DiskInfo {
  if (!raw) return info

  info.volumeLabel = raw.label || null
  info.filesystem = raw.fs || null
  info.totalSpace = raw.total ? Number(raw.total) : null
  info.freeSpace = raw.free ? Number(raw.free) : null
  info.mediumType = mapEnum(MEDIA_MAP, raw.medium)
  info.busType = mapEnum(BUS_MAP, raw.bus)

  info.type = deriveDiskTypeWin32({ dtype: raw.dtype, mediumType: info.mediumType, busType: info.busType })
  info.removable = info.type === 'usb'
  return info
}

function getDiskWin32(driveLetter: string): DiskInfo {
  // 同步兜底只取快段：慢段（Get-Partition/Get-PhysicalDisk）同步跑能钉住主线程 20s+
  return applyDiskRaw(emptyDiskWin32(driveLetter), parseDiskRaw(runPowerShell(logicalDiskPsScript(driveLetter))))
}

/**
 * 只收「对象」形状的磁盘 JSON：`parseJsonSafe` 对数组也会成功，
 * 而把 GPU 那种 `[...]` 误当成磁盘读数会让 `ok` 变成 true（＝谎报测到了磁盘）。
 */
function parseDiskRaw(text: string | null): RawDisk | null {
  const raw = parseJsonSafe<RawDisk>(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw
}

/**
 * 磁盘探测：快段定 `ok`，慢段只补介质/总线。
 * - 两段**并行**跑（各自受同一个截止时间约束）：本机快段 ~10s、慢段 ~11s，并行后总耗时仍由 GPU 那条 ~15–20s 决定；
 * - 慢段拿不到 ⇒ 只留 unknown，磁盘容量/剩余照样是真实读数；
 * - 快段没回来 ⇒ `ok=false`（＝没测到），界面画「没测到」而不是画一份空磁盘当结论。
 */
async function probeDiskWin32(driveLetter: string, deadline: number, exe = 'powershell'): Promise<{ disk: DiskInfo; ok: boolean }> {
  const slowAt = deadline - Date.now()
  // 预算已不足 3s 就不再多起一条注定被杀的 PowerShell（冷启动本身就要 7–9s）
  const slowPromise = slowAt >= 3000
    ? runPowerShellAsyncWith(exe, physicalDiskPsScript(driveLetter), slowAt)
    : Promise.resolve(null)
  const [fastText, slowText] = await Promise.all([
    runPowerShellAsyncWith(exe, logicalDiskPsScript(driveLetter), Math.max(0, deadline - Date.now())),
    slowPromise
  ])

  const raw = parseDiskRaw(fastText)
  const info = applyDiskRaw(emptyDiskWin32(driveLetter), raw)
  const slow = parseDiskRaw(slowText)
  if (slow) {
    info.mediumType = mapEnum(MEDIA_MAP, slow.medium)
    info.busType = mapEnum(BUS_MAP, slow.bus)
    info.type = deriveDiskTypeWin32({ dtype: raw?.dtype ?? null, mediumType: info.mediumType, busType: info.busType })
    info.removable = info.type === 'usb'
  }
  return { disk: info, ok: raw !== null }
}

/** 「不知道」的磁盘结论：网页号/容量一律 null，type=unknown（§377：不探测就不许推断） */
function emptyDisk(): DiskInfo {
  return {
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
}

/**
 * Linux 磁盘采集：df -T 拿容量/文件系统，lsblk 拿介质类型。
 * 两条都是毫秒级轻量 CLI（无需 root），符合 collectHardwareProbe 对非 win32「同步实现即可」的前提。
 * §377 口径：采不到的字段保持 null，不推断。
 */
function getDiskLinux(): DiskInfo {
  const info = emptyDisk()
  // df -T -B1 <路径> 输出 7 列：Filesystem Type 1B-blocks Used Available Capacity Mounted-on
  const out = execFileSync('df', ['-T', '-B1', APP_ROOT], { encoding: 'utf8' })
  const line = out.trim().split('\n').at(-1) ?? ''
  const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+\d+\s+(\d+)\s+\d+%?\s+(.+)$/)
  if (!m) return info
  info.filesystem = m[2]!
  info.totalSpace = Number(m[3])
  info.freeSpace = Number(m[4])
  info.drive = m[5]!.trim() // Linux 无盘符：挂载点承担同一语义
  // 设备名 → 整盘名（与 getDiskSerialLinux 同规则）：nvme0n1p4→nvme0n1 / mmcblk0p2→mmcblk0 / sda12→sda
  const devMatch = m[1]!.match(/^\/dev\/([A-Za-z0-9]+)$/)
  if (!devMatch) return info
  let dev = devMatch[1]!
  if (/^(nvme\d+n\d+|mmcblk\d+)p\d+$/.test(dev)) dev = dev.replace(/p\d+$/, '')
  else dev = dev.replace(/\d+$/, '')
  // lsblk -J：JSON 输出免列对齐（util-linux 新旧版本的 ROTA/RM 布尔形态不同，一并兼容）
  try {
    const lb = execFileSync('lsblk', ['-d', '-J', '-o', 'TRAN,ROTA,RM,LABEL', `/dev/${dev}`], { encoding: 'utf8' })
    const parsed = parseJsonSafe<{
      blockdevices?: Array<{ tran?: string | null; rota?: boolean | string | number | null; rm?: boolean | string | number | null; label?: string | null }>
    }>(lb)
    const d = parsed?.blockdevices?.[0]
    if (!d) return info
    if (d.label) info.volumeLabel = d.label
    if (d.tran && d.tran !== 'null') {
      const tran = d.tran.toLowerCase()
      info.busType = tran === 'nvme' ? 'NVMe' : tran === 'sata' ? 'SATA' : tran === 'usb' ? 'USB' : d.tran.toUpperCase()
    }
    info.removable = d.rm === true || d.rm === 1 || d.rm === '1' || d.tran === 'usb'
    if (d.rota === false || d.rota === 0 || d.rota === '0') info.mediumType = 'SSD'
    else if (d.rota === true || d.rota === 1 || d.rota === '1') info.mediumType = 'HDD'
  } catch {
    // lsblk 不可用（极简发行版/容器）：容量与文件系统已拿到，介质/总线保持 null
  }
  if (info.removable) info.type = 'usb'
  else if (info.mediumType === 'SSD') info.type = 'ssd'
  else if (info.mediumType === 'HDD') info.type = 'hdd'
  return info
}

function getDisk(): DiskInfo {
  try {
    if (process.platform === 'win32') {
      const drive = APP_ROOT.match(/^([A-Za-z]):/)?.[1]?.toUpperCase()
      if (drive) return getDiskWin32(drive)
      return emptyDisk()
    }
    if (process.platform === 'linux') return getDiskLinux()
    const info = emptyDisk()
    if (process.platform === 'darwin') {
      // SEC-21：execFileSync + JS 侧过滤，替代 shell 字符串拼接与管道
      const out = execFileSync('diskutil', ['info', APP_ROOT], { encoding: 'utf8' })
      const line = out.split('\n').find((l) => l.includes('Removable Media')) ?? ''
      info.removable = /Removable/i.test(line) && !/Fixed/i.test(line)
      info.type = deriveDiskTypeDarwin(info.removable)
    }
    return info
  } catch {
    return emptyDisk()
  }
}

function getOsInfo(): HardwareInfo['os'] {
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname()
  }
}

/**
 * 还没采到时的最小快照：只有 os 级信息，`gpus: []` / `disk.type: 'unknown'` 表示「未知」而非结论。
 * §377 纪律：不知道就写不知道，不填估算值。
 */
function provisionalHardware(): HardwareInfo {
  return { cpu: getCpu(), memory: getMemory(), gpus: [], disk: emptyDisk(), os: getOsInfo() }
}

// ─── 探测调度（能力页 8s 先答 + 后台补采；向导 30s 等真数据） ─────────
//
// 为什么要分档：这台机器 PowerShell 冷启动 7–9s，GPU 那条 15–20s；磁盘拆成快段（Win32_LogicalDisk，~10s）
// 与慢段（CIM 直查 MSFT_PhysicalDisk，~11s）后并行跑，三路一起约 15–20s。
// 能力页只需要尽快给个答复（先画「探测中」，后台补完自动更正），
// 向导要拿这份数据出模型建议（等不到就必须明说「没测到」，不许拿降级值冒充结论）。

/** 交互路径（能力页）最多等这么久就先出结果，其余交给后台补采 */
export const HARDWARE_INTERACTIVE_WAIT_MS = 8000
/** 后台补采预算：三路 PowerShell 并行约 15–20s，留 30s 给慢机器 */
export const HARDWARE_BACKGROUND_BUDGET_MS = 30000
/** 向导等真数据的上限：等不到就判「没测到」，不能拿降级快照给模型建议 */
export const HARDWARE_WIZARD_WAIT_MS = 30000
const HARDWARE_MAX_WAIT_MS = 60000

interface ProbeSnapshot {
  info: HardwareInfo
  got: HardwareProbeState
}

let cachedProbe: ProbeSnapshot | null = null
let activeProbe: { promise: Promise<ProbeSnapshot>; budgetMs: number; gen: number } | null = null
let probeGen = 0
let backgroundProbe: Promise<void> | null = null

function probeComplete(snapshot: ProbeSnapshot | null): boolean {
  return !!snapshot && snapshot.got.gpus && snapshot.got.disk
}

/** WSL 的 CPU/内存真值只能问宿主：Win32_Processor + Win32_ComputerSystem/OperatingSystem */
const HOST_SYSTEM_PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$c = Get-CimInstance Win32_Processor | Select-Object -First 1
$m = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1
$o = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1
[pscustomobject]@{
  model = [string]$c.Name
  cores = [int]$c.NumberOfLogicalProcessors
  total = [string][uint64]$m.TotalPhysicalMemory
  free  = [string]([uint64]$o.FreePhysicalMemory * 1024)
} | ConvertTo-Json -Compress
`

export interface HostSystemRaw {
  model: string
  cores: number | null
  total: number
  free: number | null
}

export function parseHostSystemJson(text: string | null): HostSystemRaw | null {
  const raw = parseJsonSafe<Record<string, unknown>>(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const total = Number(raw.total)
  if (!raw.model || !Number.isFinite(total) || total <= 0) return null
  const cores = Number(raw.cores)
  const free = Number(raw.free)
  return {
    model: String(raw.model).trim(),
    cores: Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : null,
    total,
    free: Number.isFinite(free) && free >= 0 ? free : null
  }
}

async function probeHostSystem(exe: string, deadline: number): Promise<HostSystemRaw | null> {
  const text = await runPowerShellAsyncWith(exe, HOST_SYSTEM_PS_SCRIPT, Math.max(0, deadline - Date.now()))
  return parseHostSystemJson(text)
}

/**
 * WSL 专用：经 /mnt/c 下的宿主 powershell.exe 取 CPU/内存/GPU/磁盘真值。
 * 一条宿主查询都没成功 ⇒ 返回 null，让调用方退回原生 Linux 视图（至少给出 WSL 自己的数据）。
 */
async function collectHardwareProbeWsl(exe: string, budgetMs: number): Promise<ProbeSnapshot | null> {
  const base = provisionalHardware()
  const deadline = Date.now() + budgetMs
  const drive = wslWindowsDrive()
  const work = (async (): Promise<ProbeSnapshot | null> => {
    const [sys, gpu, disk] = await Promise.all([
      probeHostSystem(exe, deadline),
      probeGpusWin32(deadline, exe),
      drive ? probeDiskWin32(drive, deadline, exe) : Promise.resolve({ disk: base.disk, ok: false })
    ])
    const anyHost = Boolean(sys) || gpu.ok || disk.ok
    if (!anyHost) return null
    return {
      info: {
        ...base,
        cpu: { model: sys?.model || base.cpu.model, cores: sys?.cores ?? base.cpu.cores },
        memory: { total: sys?.total ?? base.memory.total, free: sys?.free ?? base.memory.free },
        gpus: gpu.gpus,
        disk: disk.disk
      },
      got: { gpus: gpu.ok, disk: disk.ok }
    }
  })()
  return await waitAtMost(work, deadline)
}

/** 超时或命令失败一律降级成「未知」，并把没采到的字段在 `got` 里标 false */
async function collectHardwareProbe(budgetMs: number): Promise<ProbeSnapshot> {
  const base = provisionalHardware()
  if (process.platform !== 'win32') {
    // WSL：/proc 与 df 看到的是虚拟机，不是宿主机；能连上宿主 PowerShell 就取真值
    if (isWsl()) {
      const exe = wslPowerShellExe()
      if (exe) {
        const host = await collectHardwareProbeWsl(exe, budgetMs)
        if (host) return host
      }
    }
    // Mac/原生 Linux 那几条命令都是轻量 CLI（system_profiler / lspci / diskutil），沿用同步实现即可
    return { info: { ...base, gpus: getGpus(), disk: getDisk() }, got: { gpus: true, disk: true } }
  }
  const drive = APP_ROOT.match(/^([A-Za-z]):/)?.[1]?.toUpperCase()
  const deadline = Date.now() + budgetMs
  const work = (async (): Promise<ProbeSnapshot> => {
    const [gpu, disk] = await Promise.all([
      probeGpusWin32(deadline),
      drive ? probeDiskWin32(drive, deadline) : Promise.resolve({ disk: base.disk, ok: false })
    ])
    return { info: { ...base, gpus: gpu.gpus, disk: disk.disk }, got: { gpus: gpu.ok, disk: disk.ok } }
  })()
  // 单条子命令的 timeout 只保证杀进程，杀不掉（PowerShell 卡在磁盘 IO）时还要有独立截止时间
  const raced = await waitAtMost(work, deadline)
  return raced ?? { info: base, got: { gpus: false, disk: false } }
}

function startProbe(budgetMs: number): { promise: Promise<ProbeSnapshot>; budgetMs: number; gen: number } {
  const gen = ++probeGen
  const probe = {
    budgetMs,
    gen,
    promise: collectHardwareProbe(budgetMs)
      .catch((): ProbeSnapshot => ({ info: provisionalHardware(), got: { gpus: false, disk: false } }))
      .then((snapshot) => {
        // 只有最新一趟能写缓存（旧探测被淘汰后不许覆盖新结果），且降级结果不许盖掉已有的真实读数
        if (gen === probeGen && (probeComplete(snapshot) || !probeComplete(cachedProbe))) {
          cachedProbe = snapshot
        }
        return snapshot
      })
      .finally(() => {
        if (activeProbe && activeProbe.gen === gen) activeProbe = null
      })
  }
  activeProbe = probe
  return probe
}

/** 等到 deadline 为止；超时返回 null（不抛错、不取消底层探测） */
function waitAtMost<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    timer.unref?.()
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

/**
 * 后台补采：交互等待没等满就排一趟 30s 冷探测，采到后覆盖缓存——
 * 能力页轮询 `probeHardwareInfo()` 就能自动更正，不用用户再点一次。
 */
function scheduleBackgroundProbe(): void {
  if (backgroundProbe || probeComplete(cachedProbe)) return
  backgroundProbe = (async () => {
    // 先让在跑的那趟（可能是 8s 的短探测）收尾，避免两套 PowerShell 同时抢机器
    const running = activeProbe
    if (running) await waitAtMost(running.promise, Date.now() + running.budgetMs + 2000)
    if (probeComplete(cachedProbe)) return
    const probe = startProbe(HARDWARE_BACKGROUND_BUDGET_MS)
    await waitAtMost(probe.promise, Date.now() + HARDWARE_BACKGROUND_BUDGET_MS + 5000)
  })()
    .catch(() => undefined)
    .finally(() => {
      backgroundProbe = null
    })
}

export interface HardwareProbeOptions {
  /** true = 用户点了「重新检测」：忽略缓存重采 */
  force?: boolean
  /** 本次最多等多久（缺省＝能力页那 8s；向导传 30s） */
  waitMs?: number
}

export interface HardwareProbeResult {
  info: HardwareInfo
  got: HardwareProbeState
  /** true ⇒ 有字段没采到（超时/命令失败）；界面必须画成「没测到/探测中」，不许当结论 */
  incomplete: boolean
  /** true ⇒ 后台补采还在跑（能力页据此显示「探测中」并轮询） */
  probing: boolean
}

/**
 * 硬件探测统一入口。并发调用共享同一趟探测；等不满 `waitMs` 就交已有快照并排后台补采。
 * - 能力页：`{ waitMs: 8000 }`（默认）→ 8s 内给答复，剩下的后台补；
 * - 向导：`{ waitMs: 30000 }` → 等真数据，超时才判「没测到」；
 * - 重新检测：`{ force: true }` → 无视缓存重采。
 */
export async function probeHardwareInfo(opts: HardwareProbeOptions = {}): Promise<HardwareProbeResult> {
  const waitMs = Math.min(HARDWARE_MAX_WAIT_MS, Math.max(1000, Math.floor(opts.waitMs ?? HARDWARE_INTERACTIVE_WAIT_MS)))
  const deadline = Date.now() + waitMs

  if (!opts.force && probeComplete(cachedProbe)) {
    return { info: cachedProbe!.info, got: cachedProbe!.got, incomplete: false, probing: false }
  }

  // 复用一趟预算够长的在跑探测（避免两套 PowerShell 并行）；否则（重测 / 旧探测预算太短）另起一趟
  let probe = activeProbe
  if (!probe || opts.force || probe.budgetMs < waitMs) probe = startProbe(waitMs)

  const finished = await waitAtMost(probe.promise, deadline)
  const snapshot = finished ?? cachedProbe
  const complete = !!finished && probeComplete(finished)
  if (!complete) scheduleBackgroundProbe()
  return {
    info: snapshot?.info ?? provisionalHardware(),
    got: snapshot?.got ?? { gpus: false, disk: false },
    incomplete: !complete,
    probing: !complete
  }
}

/**
 * 同步读快照（不采集、不阻塞）。
 * 尚未采完时返回 os 级最小快照——调用方拿到的是「未知」，不是一份伪造的完整画像。
 * 需要真实读数且能 await 的路径（IPC、向导、能力页）一律走 probeHardwareInfo()。
 */
export function getHardwareInfo(): HardwareInfo {
  return cachedProbe?.info ?? provisionalHardware()
}

/**
 * 异步采集（按能力页那 8s 预算）并写缓存；`got` 明细请直接用 probeHardwareInfo()。
 */
export async function getHardwareInfoAsync(force = false): Promise<HardwareInfo> {
  return (await probeHardwareInfo({ force })).info
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
  const out = runPowerShell(diskSerialScript(drive))
  return out && out.trim() ? out.trim() : null
}

function diskSerialScript(drive: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$letter = '${drive}'
$part = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $part) { exit 0 }
$pd = Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
if ($pd -and $pd.SerialNumber) { Write-Output $pd.SerialNumber.Trim() }
`
}

/**
 * 指纹探测的独立预算：绑盘判定必须拿到真实序列号，**不允许降级**，
 * 所以这里不套硬件画像那 8s 总预算（同一条 Get-Partition/Get-PhysicalDisk 在坏驱动机器上可跑 20s+）。
 */
const FINGERPRINT_PROBE_TIMEOUT_MS = 30000

async function getDiskSerialWin32Async(): Promise<string | null> {
  const drive = APP_ROOT.match(/^([A-Za-z]):/)?.[1]?.toUpperCase()
  if (!drive) return null
  const out = await runPowerShellAsync(diskSerialScript(drive), FINGERPRINT_PROBE_TIMEOUT_MS)
  return out && out.trim() ? out.trim() : null
}

/** WSL 下 /sys/block 是 ext4.vhdx 的虚拟盘，序列号必须问宿主 */
function getDiskSerialWsl(): string | null {
  const exe = wslPowerShellExe()
  const drive = wslWindowsDrive()
  if (!exe || !drive) return null
  const out = runPowerShellWith(exe, diskSerialScript(drive))
  return out && out.trim() ? out.trim() : null
}

async function getDiskSerialWslAsync(): Promise<string | null> {
  const exe = wslPowerShellExe()
  const drive = wslWindowsDrive()
  if (!exe || !drive) return null
  const out = await runPowerShellAsyncWith(exe, diskSerialScript(drive), FINGERPRINT_PROBE_TIMEOUT_MS)
  return out && out.trim() ? out.trim() : null
}

function getDiskSerialDarwin(): string | null {
  try {
    // 1. 找到 APP_ROOT 所在卷的设备标识，如 disk2s1
    //    SEC-21：一律 execFileSync + 参数数组，安装路径含引号/元字符也不参与 shell 解析
    const info = execFileSync('diskutil', ['info', APP_ROOT], { encoding: 'utf8' })
    const devMatch = info.match(/Device Identifier:\s*(disk\d+)(?:s\d+)?/)
    if (!devMatch) return null
    const wholeDisk = devMatch[1] // disk2

    // 2. 从该物理盘的 IORegistry 中取序列号
    //    IOBlockStorageDriver 节点下有 BSD Name = disk2，其父节点 IOBlockStorageDevice 有 Serial Number
    const ioreg = execFileSync('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-l', '-w', '0'], {
      encoding: 'utf8'
    })
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
    // 找 APP_ROOT 所在设备（SEC-21：不再走 shell 管道，tail 在 JS 里取）
    const stat = execFileSync('df', [APP_ROOT], { encoding: 'utf8' })
    const lastLine = stat.trim().split('\n').at(-1) ?? ''
    // 注意：设备名里字母数字交错（nvme0n1p4），不能按 [a-z]+\d* 截——
    // 那会把 /dev/nvme0n1p4 截成 /dev/nvme0，序列号路径必错（1.3.0 Linux 指纹恒 null 的根因）
    const devMatch = lastLine.match(/^(\/dev\/[A-Za-z0-9]+)/)
    if (!devMatch) return null
    let dev = devMatch[1]!.replace('/dev/', '')
    // 分区名 → 整盘名：nvme0n1p4 → nvme0n1；mmcblk0p2 → mmcblk0；sda1/sda12 → sda
    if (/^(nvme\d+n\d+|mmcblk\d+)p\d+$/.test(dev)) dev = dev.replace(/p\d+$/, '')
    else dev = dev.replace(/\d+$/, '')
    // 序列号统一在 /sys/block/<整盘>/device/serial（SATA/NVMe 都适用；拿不到返回 null）
    const serial = fs.readFileSync(`/sys/block/${dev}/device/serial`, 'utf8').trim()
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
    else if (isWsl()) serial = getDiskSerialWsl()
    else serial = getDiskSerialLinux()
  } catch {
    serial = null
  }
  cachedFingerprint = fingerprintOf(serial)
  return cachedFingerprint
}

/**
 * 异步版指纹：**判定语义与同步版完全一致**（同一个序列号、同一个哈希、同一个缓存），
 * 只是把 Windows 那条 20s+ 的 Get-Partition/Get-PhysicalDisk 从主线程挪出去。
 * 启动期加载 license 必须走这条——同步版会把窗口导航与兜底计时器一起冻住。
 */
export async function getDiskFingerprintAsync(): Promise<string | null> {
  if (cachedFingerprint !== undefined) return cachedFingerprint
  let serial: string | null = null
  try {
    if (process.platform === 'win32') serial = await getDiskSerialWin32Async()
    else if (process.platform === 'darwin') serial = getDiskSerialDarwin()
    else if (isWsl()) serial = await getDiskSerialWslAsync()
    else serial = getDiskSerialLinux()
  } catch {
    serial = null
  }
  cachedFingerprint = fingerprintOf(serial)
  return cachedFingerprint
}

function fingerprintOf(serial: string | null): string | null {
  if (!serial) return null
  return createHash('sha256').update(serial).digest('hex').slice(0, 16)
}
