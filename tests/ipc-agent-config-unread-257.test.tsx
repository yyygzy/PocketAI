// V4-Iter-257：Agent 工具配置 hook 上那几处「判了不接管」——四发工具配置读。
//
// 这一簇的谎法只有一种：**读失败 ⇒ 屏上摆的是各自的默认字面量**，看着就像读数。
//  · `workspaceDir` 空串 ⇒ 📁 那颗写「未设置」（还顺手把终端命令整块置灰，悬停教用户"你先没选目录"）；
//  · 三个开关的默认值全是 `enabled:false` ⇒ 三条都显示"关着"，而真实库里可能开着。
// 收口形状抄的是本仓既有那张脸：§226 的 `ShowingDefaultsNotice`（**必须点名是哪一发**，
// 因为一个面板里可能只有部分数据来自失败的那一发）。
// Agent 壳及输入区那几面的渲染落点随 P4 批次 2 删除退场；本枚留下 hook 级读数与重试出口。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, stubPocketai } from './helpers/renderer'
import { useAgentToolConfigs } from '../src/renderer/src/modules/chat/useAgentToolConfigs'
import type { CalendarConfig, ShellConfig, WebSearchConfig } from '../src/shared/types'

const SHELL_ON: ShellConfig = { enabled: true, policy: 'auto-safe' }
const WS_ON: WebSearchConfig = {
  enabled: true,
  provider: 'tavily',
  apiKey: '',
  hasKey: true,
  searxngBaseUrl: '',
  searxngAllowPrivate: false,
  depth: 'quick'
}
const CAL_ON: CalendarConfig = { enabled: true, paths: ['C:/cal.ics'] }

describe('① 接线计数：配置 hook 的落点逐条数得出', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../src/renderer/src', rel), 'utf-8').replace(/\r\n/g, '\n')
  const CFG = read('modules/chat/useAgentToolConfigs.ts')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('配置 hook：一发读三个落点（失败／清位／reject），加四处"当场改成功也清位"', () => {
    expect(count(CFG, /markUnread\(/g), '16 = 4 发 × (失败＋读到清位＋reject) 再加 4 个 handler 成功清位').toBe(16)
    expect(count(CFG, /if \(!hasIpcFailed\(v\)\) set/g), '旧写法归零').toBe(0)
    expect(count(CFG, /toolUnread/g), '状态定义＋return 里带出去').toBeGreaterThanOrEqual(2)
  })
})

describe('② §399②a：工作目录的重试出口真接回 hook（不是只把那颗键画在屏上）', () => {
  it('工作目录那一读失败过 ⇒ retryWorkspace() 真重问那一发，读到之后那句自己收回、目录也落进那一行', async () => {
    let n = 0
    stubPocketai({
      getAgentWorkspaceDir: () => {
        n += 1
        return n === 1 ? { ok: false, error: 'WS_DIR:库被占用' } : 'C:/ws'
      },
      getShellConfig: () => SHELL_ON,
      getWebSearchConfig: () => WS_ON,
      getCalendarConfig: () => CAL_ON
    })
    const { result } = renderHook(() => useAgentToolConfigs(), { wrapper: HookProviders })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.toolUnread.workspace).toBe('WS_DIR:库被占用'))
    expect(result.current.workspaceDir, '读不到时那格是空的，不是"未设置"的读数').toBe('')
    await act(async () => {
      result.current.retryWorkspace()
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.toolUnread.workspace, '当场读到 ⇒ 那句"读不到"到此作废').toBeNull())
    expect(result.current.workspaceDir).toBe('C:/ws')
    expect(n, '重试＝真重问那一发通道（把出口接成空函数就在这条红）').toBeGreaterThanOrEqual(2)
  })

  it('反向对照：挂载就读到 ⇒ 一次都不许多发（重试键不是常驻的第二发）', async () => {
    let n = 0
    stubPocketai({
      getAgentWorkspaceDir: () => {
        n += 1
        return 'C:/ws'
      },
      getShellConfig: () => SHELL_ON,
      getWebSearchConfig: () => WS_ON,
      getCalendarConfig: () => CAL_ON
    })
    const { result } = renderHook(() => useAgentToolConfigs(), { wrapper: HookProviders })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.toolUnread.workspace).toBeNull())
    expect(n, '本枚不该顺手把挂载读变成第二次').toBe(1)
  })
})
