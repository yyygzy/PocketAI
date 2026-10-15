// nvidia-smi 实占显存的解析与挂载（V4-Iter-140）
//
// 判据纪律：**采不到就留空，不许填估算值**。
// 所以本文件重点钉三件坏事：① 把解不出的"已用"当 0（等于谎报全空闲）；
// ② 多卡时按数组顺序硬配（WMI 与 nvidia-smi 的顺序不保证一致）；③ 覆盖已有的 WMI 总量。
// fixture 取自本机 GTX 1050 Ti 的真实输出。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/portable', () => ({ APP_ROOT: '/mock/app/root' }))

// 采集接线用：整块打桩 child_process，让"该调用谁、返回什么"完全由本用例决定
const NVIDIA_CSV = 'NVIDIA GeForce GTX 1050 Ti, 4096, 2041'
// GPU_PS_SCRIPT 的输出形状是脚本自己拼的小写键（name/memory/driver），不是 WMI 原始属性名
const WMI_JSON = JSON.stringify([
  { name: 'NVIDIA GeForce GTX 1050 Ti', memory: 4293918720, driver: '31.0.15.3143' }
])
const LSPCI_LINE = '01:00.0 VGA compatible controller: NVIDIA Corporation GP107 [GeForce GTX 1050 Ti]'

const childProcessMock = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => childProcessMock)

import { applyNvidiaRows, parseNvidiaSmiCsv, refreshHardwareInfo } from '../src/main/steward/hardware'
import type { GpuInfo } from '../src/shared/types'

const GPU_1050TI: GpuInfo = {
  name: 'NVIDIA GeForce GTX 1050 Ti',
  memory: 4293918720,
  driver: '31.0.15.3143',
  cuda: true,
  mps: false
}

describe('parseNvidiaSmiCsv', () => {
  it('真实单行输出：name / total / used 都按 MiB 出数', () => {
    expect(parseNvidiaSmiCsv('NVIDIA GeForce GTX 1050 Ti, 4096, 0')).toEqual([
      { name: 'NVIDIA GeForce GTX 1050 Ti', totalMiB: 4096, usedMiB: 0 }
    ])
  })

  it('used=0 是有效读数，不许退化成 null', () => {
    expect(parseNvidiaSmiCsv('X, 4096, 0')[0]!.usedMiB).toBe(0)
  })

  it('带 " MiB" 后缀（部分驱动不加 nounits 时）照样解', () => {
    expect(parseNvidiaSmiCsv('X, 4096 MiB, 2041 MiB')[0]).toMatchObject({ totalMiB: 4096, usedMiB: 2041 })
  })

  it('多卡多行按行出表；空行与空名丢弃', () => {
    const rows = parseNvidiaSmiCsv('A, 8192, 100\n\nB, 2048, 512\n, 1, 2')
    expect(rows.map((r) => r.name)).toEqual(['A', 'B'])
  })

  it('数字列缺失或非数字 ⇒ null（不是 0）', () => {
    expect(parseNvidiaSmiCsv('A, , ')[0]).toEqual({ name: 'A', totalMiB: null, usedMiB: null })
    expect(parseNvidiaSmiCsv('A, N/A, [N/A]')[0]).toEqual({ name: 'A', totalMiB: null, usedMiB: null })
  })

  it('空输入 / null / 未定义 ⇒ 空表，不抛', () => {
    for (const t of ['', '   ', null, undefined]) expect(parseNvidiaSmiCsv(t)).toEqual([])
  })
})

describe('applyNvidiaRows', () => {
  it('名字相同 ⇒ 挂上 usedMemory（bytes），并把 MiB 换算对', () => {
    const [g] = applyNvidiaRows([GPU_1050TI], [
      { name: 'NVIDIA GeForce GTX 1050 Ti', totalMiB: 4096, usedMiB: 2041 }
    ])
    expect(g!.usedMemory).toBe(2041 * 1048576)
    // 已有 WMI 总量不被覆盖
    expect(g!.memory).toBe(4293918720)
  })

  it('名字大小写/多空格不同形也算同一张卡', () => {
    const [g] = applyNvidiaRows([{ ...GPU_1050TI, name: 'nvidia  GeForce  GTX 1050 Ti' }], [
      { name: 'NVIDIA GeForce GTX 1050 Ti', totalMiB: 4096, usedMiB: 34 }
    ])
    expect(g!.usedMemory).toBe(34 * 1048576)
  })

  it('WMI 没给出总量时，用 nvidia-smi 的 total 补上', () => {
    const bare: GpuInfo = { name: 'Some NVIDIA Card', cuda: true, mps: false }
    const [g] = applyNvidiaRows([bare], [{ name: 'Some NVIDIA Card', totalMiB: 6144, usedMiB: null }])
    expect(g!.memory).toBe(6144 * 1048576)
    expect(g!.usedMemory).toBeUndefined()
  })

  it('反向对照①：usedMiB 解不出 ⇒ 不写 usedMemory（绝不能落成 0）', () => {
    const [g] = applyNvidiaRows([GPU_1050TI], [
      { name: 'NVIDIA GeForce GTX 1050 Ti', totalMiB: 4096, usedMiB: null }
    ])
    expect(g!.usedMemory).toBeUndefined()
  })

  it('反向对照②：两张卡名字都对不上 ⇒ 一个也不挂，不按顺序硬配', () => {
    const gpus: GpuInfo[] = [
      GPU_1050TI,
      { name: 'Intel(R) UHD Graphics 630', memory: 1073741824, cuda: false, mps: false }
    ]
    const rows = [
      { name: 'GeForce RTX 4090', totalMiB: 24576, usedMiB: 1234 },
      { name: 'Something Else', totalMiB: 1, usedMiB: 1 }
    ]
    const out = applyNvidiaRows(gpus, rows)
    expect(out[0]!.usedMemory).toBeUndefined()
    expect(out[1]!.usedMemory).toBeUndefined()
  })

  it('单卡时允许"一对一"兜底（lspci 的名字与 nvidia-smi 不同形）', () => {
    const [g] = applyNvidiaRows([{ name: 'VGA compatible controller: NVIDIA GP107', cuda: true, mps: false }], [
      { name: 'NVIDIA GeForce GTX 1050 Ti', totalMiB: 4096, usedMiB: 720 }
    ])
    expect(g!.usedMemory).toBe(720 * 1048576)
  })

  it('非 cuda 的卡永远不挂（核显没有独立显存可言）', () => {
    const [g] = applyNvidiaRows([{ name: 'NVIDIA NVLink Shield', cuda: false, mps: false }], [
      { name: 'NVIDIA NVLink Shield', totalMiB: 4096, usedMiB: 10 }
    ])
    expect(g!.usedMemory).toBeUndefined()
  })

  it('rows 为空 ⇒ 原样返回（没有 nvidia-smi 的机器一条都不改）', () => {
    expect(applyNvidiaRows([GPU_1050TI], [])).toEqual([GPU_1050TI])
  })
})

// 接线用例：函数写得再对，没被 getGpus 调用就等于没采到（V4-Iter-139 那批"没接线"教训的同族）
describe('getGpus 接线：采集确实把实占挂上了', () => {
  const setup = (): void => {
    childProcessMock.execFileSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd).toLowerCase()
      if (c.startsWith('powershell')) return WMI_JSON
      if (c.startsWith('nvidia-smi')) return NVIDIA_CSV
      return ''
    })
    childProcessMock.execSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd)
      if (c.startsWith('lspci')) return LSPCI_LINE
      if (c.startsWith('system_profiler')) return 'Chipset Model: Apple M1'
      return ''
    })
  }

  it.runIf(process.platform !== 'darwin')(
    '非 Mac：gpus[0] 带 usedMemory（= nvidia-smi 的 2041MiB 换算字节）',
    () => {
      setup()
      const hw = refreshHardwareInfo()
      const gpu = hw.gpus.find((g) => g.cuda)
      expect(gpu, '本用例需要至少一条 cuda 卡：WMI/lspci 桩里都给了 NVIDIA').toBeDefined()
      expect(gpu!.usedMemory).toBe(2041 * 1048576)
      // 总量：Windows 走 WMI（注册表那条 >4GB 的路径才是准的，不许被 nvidia-smi 顶掉）；
      // Linux 的 lspci 给不出总量 ⇒ 由 nvidia-smi 补，两条路都要钉住
      if (process.platform === 'win32') expect(gpu!.memory).toBe(4293918720)
      else expect(gpu!.memory).toBe(4096 * 1048576)
    }
  )

  it.runIf(process.platform === 'darwin')('Mac：统一内存不是显存，故意留空', () => {
    setup()
    const hw = refreshHardwareInfo()
    expect(hw.gpus.every((g) => g.usedMemory === undefined)).toBe(true)
  })

  it('nvidia-smi 不在场（命令直接失败）⇒ 一条也不挂，采集本身照常出表', () => {
    // 注意别让 gpus 空掉：空数组上的 every 恒真，那就成了一条空断言
    childProcessMock.execSync.mockImplementation((cmd: unknown) =>
      String(cmd).startsWith('lspci') ? LSPCI_LINE : 'Chipset Model: Apple M1'
    )
    childProcessMock.execFileSync.mockImplementation((cmd: unknown) => {
      if (String(cmd).toLowerCase().startsWith('powershell')) return WMI_JSON
      throw new Error('ENOENT: 没有 nvidia-smi')
    })
    const hw = refreshHardwareInfo()
    expect(hw.gpus.length).toBeGreaterThan(0)
    expect(hw.gpus.every((g) => g.usedMemory === undefined)).toBe(true)
  })
})
