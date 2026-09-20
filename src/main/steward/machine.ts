// 机器指纹（首启向导「换电脑检测」用）
//
// 目的：便携盘（U 盘/移动硬盘）场景下，同一份数据目录可能被插到不同电脑。
// 用 Windows 系统指纹 MachineGuid 识别「换电脑」，触发向导重新体检
// （硬件画像变化 → 本地模型推荐档位可能变化，用户需重新确认）。
//
// 隐私考量：MachineGuid 是本机随机 GUID，不联网、不上报，仅在本地比对。
// 非 Windows 平台退化为 hostname + CPU 型号哈希（项目当前仅打包 Windows，
// 保留跨平台兜底以免开发环境误报换机器）。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let cachedMachineId: string | null = null

async function readWindowsMachineGuid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: 5000, windowsHide: true }
    )
    // 输出形如 "    MachineGuid    REG_SZ    xxxx-xxxx-..."
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/** 跨平台兜底指纹：hostname + 首个 CPU 型号（开发环境足够稳定） */
function fallbackMachineId(): string {
  const cpuModel = os.cpus()[0]?.model ?? 'unknown-cpu'
  return createHash('sha256')
    .update(`${os.hostname()}|${cpuModel}`)
    .digest('hex')
    .slice(0, 32)
}

/** 当前机器指纹（进程内缓存；注册表读取仅首次执行一次） */
export async function getMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId
  const guid = process.platform === 'win32' ? await readWindowsMachineGuid() : null
  cachedMachineId = guid ?? fallbackMachineId()
  return cachedMachineId
}
