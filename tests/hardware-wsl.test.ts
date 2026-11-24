// WSL 硬件探测：WSL2 的 /proc 与 df 看到的是虚拟机视图，宿主真值必须经 powershell.exe。
// 这里钉住识别、宿主路径映射、CPU/内存回执解析三个纯判定；真实 WSL 桥接由项目内调用点保证。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/portable', () => ({ APP_ROOT: '/mock/app/root' }))

import {
  isWslEnv,
  windowsDriveFromWslPath,
  wslPowerShellExe,
  parseHostSystemJson
} from '../src/main/steward/hardware'

const HOST_PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

describe('WSL 识别：只认内核/环境证据，不把原生 Linux 当 WSL', () => {
  it('/proc/version 或 os.release 带 microsoft/wsl 即命中', () => {
    expect(isWslEnv('Linux version 5.15.167.4-microsoft-standard-WSL2 (gcc)', '', {})).toBe(true)
    expect(isWslEnv('', '5.15.167.4-microsoft-standard-WSL2', {})).toBe(true)
  })

  it('WSL_DISTRO_NAME 也能命中（某些内核版本不带 microsoft 字样）', () => {
    expect(isWslEnv('', '', { WSL_DISTRO_NAME: 'Ubuntu-24.04' })).toBe(true)
  })

  it('原生 Linux/macOS 视图不命中', () => {
    expect(isWslEnv('Linux version 6.8.0-generic (buildd)', '6.8.0-generic', {})).toBe(false)
    expect(isWslEnv('', '', {})).toBe(false)
  })
})

describe('宿主路径映射', () => {
  it('wslpath -w 的 Windows 路径 → 盘符，绝不默认 C:', () => {
    expect(windowsDriveFromWslPath('E:\\PocketAI\\data')).toBe('E')
    expect(windowsDriveFromWslPath('C:/Users/CXL/AppData')).toBe('C')
    expect(windowsDriveFromWslPath('/home/cxl/.config/Moxia')).toBeNull()
    expect(windowsDriveFromWslPath(null)).toBeNull()
  })

  it('宿主 PowerShell：标准挂载点 + 环境变量覆盖', () => {
    const prev = process.env.POCKETAI_WSL_POWERSHELL
    delete process.env.POCKETAI_WSL_POWERSHELL
    try {
      expect(wslPowerShellExe((p) => p === HOST_PS)).toBe(HOST_PS)
      expect(wslPowerShellExe(() => false)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.POCKETAI_WSL_POWERSHELL
      else process.env.POCKETAI_WSL_POWERSHELL = prev
    }
  })
})

describe('宿主 CPU/内存回执解析', () => {
  it('剥离 CLIXML 噪声后读出真值', () => {
    const text = `#< CLIXML\r\n{"model":"Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz","cores":8,"total":"17093177344","free":"6710886400"}`
    expect(parseHostSystemJson(text)).toEqual({
      model: 'Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz',
      cores: 8,
      total: 17093177344,
      free: 6710886400
    })
  })

  it('缺字段/零内存 ⇒ 没测到，不填估算值', () => {
    expect(parseHostSystemJson(null)).toBeNull()
    expect(parseHostSystemJson('{"model":"","cores":8,"total":"17093177344"}')).toBeNull()
    expect(parseHostSystemJson('{"model":"X","total":"0"}')).toBeNull()
  })

  it('核心数解析不出来时留 null，模型名与内存仍然可用', () => {
    expect(parseHostSystemJson('{"model":"X","cores":"?","total":"8589934592","free":"?"}')).toEqual({
      model: 'X',
      cores: null,
      total: 8589934592,
      free: null
    })
  })
})
