// V4-Iter-377（候选 #3）：介质探测失败时不许把盘"推断"成 SSD。
//
// 改前的形状（源码为证，`src/main/steward/hardware.ts`）：
//   win32 分支 `else if (raw.dtype === 3) info.type = 'ssd'`（注释写着"无法识别物理介质时沿用旧行为：本地盘按 SSD 展示"），
//   darwin 分支 `info.type = info.removable ? 'usb' : 'ssd'`（diskutil 那行只分得出可移动／固定，固定卷根本没探介质）。
// 于是 `Get-PhysicalDisk` 拿不到（服务没起、权限不足、返回 'Unspecified'）或 macOS 上一律机械盘被画成「SSD」，
// 管家屏与诊断报告、首启向导都跟着说谎——而**同文件的 GPU 段早就立了"不许填估算值"的纪律**。
//
// 判据分两半：
//   ① 本文件＝纯函数的真行为（deriveDiskTypeWin32／deriveDiskTypeDarwin 是导出的真函数，不桩、不 mock）；
//   ② `steward-dishonest-default-gate-377.test.ts`＝源码级闸门，钉"推断那一支不许回到调用点里"＋界面两张脸＋四语。
import { describe, it, expect, vi } from 'vitest'

// 与 hardware.test.ts 同法：挡掉 portable 的 APP_ROOT 初始化副作用（探测函数本身不读它）
vi.mock('../src/main/portable', () => ({ APP_ROOT: 'C:\\mock\\app\\root' }))

import { deriveDiskTypeWin32, deriveDiskTypeDarwin } from '../src/main/steward/hardware'

const win32 = (input: { dtype: number | null; mediumType: string | null; busType: string | null }): string =>
  deriveDiskTypeWin32(input)

describe('① win32：只有三类证据才给结论', () => {
  it('物理盘报了 SSD ⇒ ssd', () => {
    expect(win32({ dtype: 3, mediumType: 'SSD', busType: 'NVMe' })).toBe('ssd')
  })

  it('物理盘报了 HDD ⇒ hdd（这条本来就没病，留着当正向对照）', () => {
    expect(win32({ dtype: 3, mediumType: 'HDD', busType: 'SATA' })).toBe('hdd')
  })

  it('DriveType=2（可移动卷）⇒ usb', () => {
    expect(win32({ dtype: 2, mediumType: null, busType: null })).toBe('usb')
  })

  it('总线是 USB ⇒ usb（可移动的另一路证据）', () => {
    expect(win32({ dtype: 3, mediumType: null, busType: 'USB' })).toBe('usb')
  })

  it('**那颗谎**：本地盘（dtype=3）但物理介质没探测出来（Get-PhysicalDisk 拿不到 ⇒ mediumType=null）⇒ unknown', () => {
    expect(win32({ dtype: 3, mediumType: null, busType: null })).toBe('unknown')
  })

  it('**那颗谎的第二形**：Windows 回了 Unspecified（映射表里的 5 就是它）⇒ unknown，不许替它挑一档', () => {
    expect(win32({ dtype: 3, mediumType: 'Unspecified', busType: 'SATA' })).toBe('unknown')
  })

  it('DriveType 自己也没读到（PowerShell 半截失败）⇒ unknown', () => {
    expect(win32({ dtype: null, mediumType: null, busType: null })).toBe('unknown')
  })

  it('反向对照：dtype=3 与 mediumType=HDD 同时在场时，介质那一路赢（推断支不许反过来盖住实测）', () => {
    expect(win32({ dtype: 3, mediumType: 'HDD', busType: null })).toBe('hdd')
    expect(win32({ dtype: 3, mediumType: 'SSD', busType: null })).toBe('ssd')
  })

  it('结论只可能是四档之一（unknown 必须在值域里，否则"没探到"只能被塞进某一档）', () => {
    const domain = new Set(['ssd', 'hdd', 'usb', 'unknown'])
    for (const dtype of [null, 2, 3, 5]) {
      for (const mediumType of [null, 'SSD', 'HDD', 'Unspecified']) {
        for (const busType of [null, 'NVMe', 'SATA', 'USB']) {
          expect(domain.has(win32({ dtype, mediumType, busType })), `${dtype}/${mediumType}/${busType}`).toBe(true)
        }
      }
    }
    // 并且"没介质证据"的那一整片确实落在 unknown／usb 两档里，而不是 ssd／hdd
    const noMedium = [null, 'Unspecified']
    for (const mediumType of noMedium) {
      expect(['unknown', 'usb']).toContain(win32({ dtype: 3, mediumType, busType: 'SATA' }))
    }
  })
})

describe('② darwin：diskutil 只说得出可移动与否', () => {
  it('可移动卷 ⇒ usb（这是它真探测得到的那半）', () => {
    expect(deriveDiskTypeDarwin(true)).toBe('usb')
  })

  it('**那颗谎**：固定卷 ⇒ unknown，不是 ssd（SSD 还是 HDD 它没说，不许替它说）', () => {
    expect(deriveDiskTypeDarwin(false)).toBe('unknown')
  })
})
