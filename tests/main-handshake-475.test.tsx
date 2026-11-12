// @vitest-environment jsdom
// V4-Iter-475：渲染层与主进程的版本握手。
//
// 三条定向面（对应需求里的验证清单）：
//  ① 对齐时不打扰用户：握手回同一份通道表 → 一个 alert 都不出现，模块内容照常渲染；
//  ② 不一致时出现统一提示，且应用仍可用：缺通道 → 一条能指导行动的 alert，正文同时列出缺失通道名；
//  ③ 握手本身不可用（旧主进程没有 handler）→ 失败面可见，不是空 catch。
// 刻意不用 await waitFor（改用 findBy*），避免再动 waitFor 闸门；
// 若以后改成 waitFor，必须同步在 tests/waitfor-gate-364.test.ts 的 AWAIT_CAP 登记精确颗数。
import { describe, it, expect } from 'vitest'
import { act, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { MainProcessHandshakeNotice } from '../src/renderer/src/components/MainProcessHandshakeNotice'
import { handshakeChannelList } from '../src/shared/ipc-handshake'

const reply = (channels: string[]) => ({ buildId: '1.2.8+test', startedAt: 1, channels })

/** 挂一块「模块内容」当对照组：提示出现时它必须还在（= 握手不阻断任何模块） */
const mountWithWorkspace = (): void => {
  mountWithProviders(
    <>
      <MainProcessHandshakeNotice />
      <div>WORKSPACE</div>
    </>
  )
}

describe('§475 主进程版本握手', () => {
  it('对齐：通道表一致时不打扰用户，模块照常渲染', async () => {
    stubPocketai({ mainHandshake: async () => reply(handshakeChannelList()) })
    mountWithWorkspace()
    // 等握手那一发落地（微任务）后再断言"没有 alert"，否则测的是"还没返回"
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('WORKSPACE')).toBeTruthy()
  })

  it('不一致：显示统一提示（含缺失数与通道名），应用仍可用', async () => {
    const all = handshakeChannelList()
    const missing = ['app:handshake', 'agent:get-tool-surface'].filter((c) => all.includes(c))
    expect(missing.length, '两个被摘掉的通道必须真在常量表里，否则这条用例是空的').toBe(2)
    stubPocketai({ mainHandshake: async () => reply(all.filter((c) => !missing.includes(c))) })
    mountWithWorkspace()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('主进程版本过旧')
    expect(alert.textContent).toContain('有 2 个通道')
    expect(alert.textContent).toContain('agent:get-tool-surface')
    expect(alert.textContent).toContain('app:handshake')
    // 只提示不阻断：模块仍在
    expect(screen.getByText('WORKSPACE')).toBeTruthy()
  })

  it('握手不可用：旧主进程没有 handler 时给出可见失败面（不是空 catch）', async () => {
    stubPocketai({
      mainHandshake: () => {
        throw new Error("No handler registered for 'app:handshake'")
      }
    })
    mountWithWorkspace()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("No handler registered for 'app:handshake'")
    expect(alert.textContent).toContain('重启')
    expect(screen.getByText('WORKSPACE')).toBeTruthy()
  })
})
