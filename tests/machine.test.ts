// 机器指纹模块测试
//
// 覆盖 src/main/steward/machine.ts 的 getMachineId 平台分支与缓存：
// - win32：reg 读 MachineGuid 正常 / 失败 / 输出不匹配 → fallback
// - linux：/etc/machine-id 合法 32hex / 非法 / 读失败 → fallback
// - darwin（其余平台）：直接 fallback（hostname+CPU 哈希）
// - 进程内缓存：二次调用不再触发系统指纹读取
//
// 策略：
// - 模块级缓存 → 每用例 vi.resetModules() + 动态 import 取新实例
// - process.platform 只读 → Object.defineProperty 切换，afterEach 还原
// - mock node:child_process（回调风格，promisify 兼容）与 node:fs（默认导入需带 default）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  regStdout: '',
  regError: null as unknown,
  regCalls: 0,
  machineIdFile: null as string | null, // null = 读文件抛错
  fsReadCalls: 0,
  reset() {
    this.regStdout = ''
    this.regError = null
    this.regCalls = 0
    this.machineIdFile = null
    this.fsReadCalls = 0
  }
}))

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: unknown, out: { stdout: string } | null) => void
  ) => {
    mocks.regCalls++
    if (mocks.regError) cb(mocks.regError, null)
    else cb(null, { stdout: mocks.regStdout })
  }
}))

vi.mock('node:fs', () => {
  const fs = {
    readFileSync: () => {
      mocks.fsReadCalls++
      if (mocks.machineIdFile === null) throw new Error('文件不存在')
      return mocks.machineIdFile
    }
  }
  return { ...fs, default: fs }
})

// ---------- platform 切换 ----------

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(v: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: v, configurable: true })
}

const HEX32 = /^[0-9a-f]{32}$/

async function freshModule(): Promise<typeof import('../src/main/steward/machine')> {
  vi.resetModules()
  return await import('../src/main/steward/machine')
}

beforeEach(() => mocks.reset())

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
})

// ---------- win32 ----------

describe('getMachineId win32 分支', () => {
  it('reg 输出正常：提取 MachineGuid 返回', async () => {
    setPlatform('win32')
    mocks.regStdout = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1a2b-3c4d-5e6f\r\n\r\n'
    const { getMachineId } = await freshModule()
    expect(await getMachineId()).toBe('1a2b-3c4d-5e6f')
  })

  it('reg 失败（reg 不存在/超时）：降级 fallback 指纹', async () => {
    setPlatform('win32')
    mocks.regError = new Error('reg 命令失败')
    const { getMachineId } = await freshModule()
    const id = await getMachineId()
    expect(id).toMatch(HEX32)
  })

  it('reg 输出无 MachineGuid 字段：降级 fallback 指纹', async () => {
    setPlatform('win32')
    mocks.regStdout = 'ERROR: The system was unable to find the specified registry key.'
    const { getMachineId } = await freshModule()
    expect(await getMachineId()).toMatch(HEX32)
  })
})

// ---------- linux ----------

describe('getMachineId linux 分支', () => {
  it('/etc/machine-id 合法（32 位 hex）：直接返回', async () => {
    setPlatform('linux')
    mocks.machineIdFile = '0123456789abcdef0123456789abcdef\n'
    const { getMachineId } = await freshModule()
    expect(await getMachineId()).toBe('0123456789abcdef0123456789abcdef')
  })

  it('machine-id 内容非法（非 32hex）：降级 fallback 指纹', async () => {
    setPlatform('linux')
    mocks.machineIdFile = 'not-a-machine-id'
    const { getMachineId } = await freshModule()
    expect(await getMachineId()).toMatch(HEX32)
  })

  it('machine-id 读取抛错：降级 fallback 指纹', async () => {
    setPlatform('linux')
    // machineIdFile=null → readFileSync 抛错
    const { getMachineId } = await freshModule()
    expect(await getMachineId()).toMatch(HEX32)
  })
})

// ---------- 其余平台 / 缓存 ----------

describe('getMachineId 其余平台与缓存', () => {
  it('darwin：不走 reg 也不读 machine-id，直接 fallback', async () => {
    setPlatform('darwin')
    const { getMachineId } = await freshModule()
    const id = await getMachineId()
    expect(id).toMatch(HEX32)
    expect(mocks.regCalls).toBe(0)
    expect(mocks.fsReadCalls).toBe(0)
  })

  it('同模块实例内缓存：二次调用返回同值且不重复读系统指纹', async () => {
    setPlatform('win32')
    mocks.regStdout = '    MachineGuid    REG_SZ    cached-guid'
    const { getMachineId } = await freshModule()
    const first = await getMachineId()
    const second = await getMachineId()
    expect(first).toBe('cached-guid')
    expect(second).toBe(first)
    expect(mocks.regCalls).toBe(1)
  })

  it('fallback 指纹稳定：同环境两次生成结果一致', async () => {
    setPlatform('darwin')
    const { getMachineId: a } = await freshModule()
    const id1 = await a()
    vi.resetModules()
    const { getMachineId: b } = await freshModule()
    const id2 = await b()
    expect(id1).toBe(id2)
  })
})
