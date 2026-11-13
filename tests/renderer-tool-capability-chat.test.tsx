// 对话区工具判定提示 + 首次选中自动探测（P0-4b 第二刀）
// @vitest-environment jsdom
//
// 这一屏的纪律：**只提示，不阻断**。四档都不许出现禁用发送/置灰入口的语义，
// 按钮上必须写清"3 次请求，计入你的额度"；「跳过」要真的落一条 user_skipped，
// 否则下次切回来还会再花用户的额度。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { ZeroToolCallNotice } from '../src/renderer/src/components/agent/ZeroToolCallNotice'
import { useToolCapabilityAutoProbe } from '../src/renderer/src/modules/chat/useToolCapabilityAutoProbe'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ToolCapabilityView } from '../src/shared/tool-capability'

const view = (over: Partial<ToolCapabilityView> = {}): ToolCapabilityView => ({
  key: 'p1::m1',
  providerId: 'p1',
  model: 'm1',
  tier: 'unknown',
  reason: '',
  samples: 0,
  nativeHits: 0,
  fenceHits: 0,
  digest: '',
  checkedAt: 1,
  stale: false,
  ...over
})

const noticeProps = (over: Partial<React.ComponentProps<typeof ZeroToolCallNotice>> = {}) => ({
  mcpHeldBack: 0,
  providerId: 'p1',
  model: 'm1',
  textProtocolForced: false,
  onClose: vi.fn(),
  onEnableTextProtocol: vi.fn(),
  ...over
})

describe('ZeroToolCallNotice：四档只提示、不阻断', () => {
  it('likely_unusable：给档位、计数据与费用口径；点「测一下」把回调传出去', () => {
    const onProbe = vi.fn()
    mountWithProviders(
      <ZeroToolCallNotice
        {...noticeProps({
          capability: view({ tier: 'likely_unusable', reason: 'partial_native_calls', samples: 3, nativeHits: 2 }),
          onProbe,
          onSkipProbe: vi.fn()
        })}
      />
    )
    expect(screen.getByText(zh['provider.toolCapLikely'])).toBeTruthy()
    expect(screen.getByText(/2\/3/)).toBeTruthy()
    expect(screen.getByText(zh['provider.toolCapFee'])).toBeTruthy()
    const probe = screen.getByText(zh['provider.toolCapProbe'])
    expect(probe.getAttribute('title')).toBe(zh['provider.toolCapFee'])
    fireEvent.click(probe)
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it('known_unusable：说"不会调工具"并交代端点拒绝的原因，但不出现任何禁用语义', () => {
    mountWithProviders(
      <ZeroToolCallNotice
        {...noticeProps({
          capability: view({ tier: 'known_unusable', reason: 'tools_rejected' }),
          onProbe: vi.fn(),
          onSkipProbe: vi.fn()
        })}
      />
    )
    expect(screen.getByText(zh['provider.toolCapKnown'])).toBeTruthy()
    expect(screen.getByText(zh['toolCap.reason.rejected'])).toBeTruthy()
    const section = screen.getByTestId('zero-tool-capability')
    expect(section.querySelector('button[disabled]')).toBeNull()
    expect(section.textContent).not.toContain('disabled')
  })

  it('usable：不在这里重复摆一段（零调用提示已经够长）', () => {
    mountWithProviders(
      <ZeroToolCallNotice {...noticeProps({ capability: view({ tier: 'usable', samples: 3, nativeHits: 3 }) })} />
    )
    expect(screen.queryByTestId('zero-tool-capability')).toBeNull()
  })

  it('探测中：显示测试中与「停止」，不摆「测一下」', () => {
    const onStopProbe = vi.fn()
    mountWithProviders(
      <ZeroToolCallNotice {...noticeProps({ capability: null, probing: true, onProbe: vi.fn(), onStopProbe })} />
    )
    expect(screen.getByText(zh['provider.toolCapProbing'])).toBeTruthy()
    fireEvent.click(screen.getByText(zh['provider.toolCapStop']))
    expect(onStopProbe).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(zh['provider.toolCapProbe'])).toBeNull()
  })

  it('user_skipped：说清"你跳过了"，不再摆「跳过」按钮，但保留重测入口', () => {
    mountWithProviders(
      <ZeroToolCallNotice
        {...noticeProps({
          capability: view({ tier: 'unknown', reason: 'user_skipped' }),
          onProbe: vi.fn(),
          onSkipProbe: vi.fn()
        })}
      />
    )
    expect(screen.getByText(zh['toolCap.reason.skipped'])).toBeTruthy()
    expect(screen.queryByText(zh['toolCap.skipProbe'])).toBeNull()
    expect(screen.getByText(zh['provider.toolCapProbe'])).toBeTruthy()
  })

  it('探测失败：把失败说清楚，档位保持未检测（失败不等于不会）', () => {
    mountWithProviders(
      <ZeroToolCallNotice
        {...noticeProps({
          capability: null,
          probeFailure: { code: 'network_failed' },
          onProbe: vi.fn()
        })}
      />
    )
    expect(screen.getByText(zh['toolCap.failNetwork'])).toBeTruthy()
    expect(screen.getByText(zh['provider.toolCapUnknown'])).toBeTruthy()
  })
})

/** 用一个小壳子驱动 hook：只暴露"结论 + 三个动作"，不掺界面 */
const Harness: React.FC<{ providerId: string; model: string }> = ({ providerId, model }) => {
  const h = useToolCapabilityAutoProbe(providerId, model)
  return (
    <div>
      <span data-testid="tier">{h.capability?.tier ?? 'none'}</span>
      <span data-testid="reason">{h.capability?.reason ?? ''}</span>
      <button onClick={h.probe}>probe</button>
      <button onClick={h.skip}>skip</button>
    </div>
  )
}

const probeCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'probeToolCapability').length

describe('useToolCapabilityAutoProbe：首次选中自动探一次', () => {
  it('没有台账时自动探一次（不要用户先点）；结论落进状态', async () => {
    stubPocketai({
      listToolCapabilities: () => [],
      probeToolCapability: (providerId: string, model: string) => ({
        entry: view({ key: `${providerId}::${model}`, providerId, model, tier: 'usable', samples: 3, nativeHits: 3 }),
        error: null
      })
    })
    mountWithProviders(<Harness providerId="p1" model="auto-once-1" />)
    await waitFor(() => expect(screen.getByTestId('tier').textContent).toBe('usable'))
    expect(probeCalls()).toBe(1)
  })

  it('已有结论（含跳过）只读台账：一次探测请求都不发', async () => {
    stubPocketai({
      listToolCapabilities: () => [view({ key: 'p1::already', model: 'already', reason: 'user_skipped' })]
    })
    mountWithProviders(<Harness providerId="p1" model="already" />)
    await waitFor(() => expect(screen.getByTestId('tier').textContent).toBe('unknown'))
    expect(screen.getByTestId('reason').textContent).toBe('user_skipped')
    expect(probeCalls()).toBe(0)
  })

  it('同一台模型在本进程只自动问一次：切走再回来不再烧额度', async () => {
    stubPocketai({
      listToolCapabilities: () => [],
      probeToolCapability: (providerId: string, model: string) => ({
        entry: view({ key: `${providerId}::${model}`, providerId, model, tier: 'usable', samples: 3, nativeHits: 3 }),
        error: null
      })
    })
    const first = mountWithProviders(<Harness providerId="p1" model="auto-once-2" />)
    await waitFor(() => expect(screen.getByTestId('tier').textContent).toBe('usable'))
    first.unmount()
    mountWithProviders(<Harness providerId="p1" model="auto-once-2" />)
    await waitFor(() => expect(screen.getByTestId('tier').textContent).toBe('none'))
    expect(probeCalls()).toBe(1)
  })

  it('跳过：先停掉在飞的那一发，再写 user_skipped；状态立刻变成未检测+已跳过', async () => {
    stubPocketai({
      listToolCapabilities: () => [],
      probeToolCapability: () => new Promise(() => {}),
      abortToolProbe: () => ({ stopped: true }),
      skipToolProbe: (providerId: string, model: string) =>
        view({ key: `${providerId}::${model}`, providerId, model, reason: 'user_skipped' })
    })
    mountWithProviders(<Harness providerId="p1" model="skip-1" />)
    fireEvent.click(screen.getByText('skip'))
    await waitFor(() => expect(screen.getByTestId('reason').textContent).toBe('user_skipped'))
    const fns = pocketaiCalls().map((c) => c.fn)
    expect(fns).toContain('abortToolProbe')
    expect(fns).toContain('skipToolProbe')
    expect(screen.getByTestId('tier').textContent).toBe('unknown')
  })

  it('手动重测可以越过"本进程只自动问一次"，回来的新结论覆盖旧显示', async () => {
    let n = 0
    stubPocketai({
      listToolCapabilities: () => [view({ key: 'p1::manual', model: 'manual', tier: 'unknown', reason: 'user_skipped' })],
      probeToolCapability: (providerId: string, model: string) => {
        n++
        return {
          entry: view({ key: `${providerId}::${model}`, providerId, model, tier: 'usable', samples: 3, nativeHits: 3 }),
          error: null
        }
      }
    })
    mountWithProviders(<Harness providerId="p1" model="manual" />)
    await waitFor(() => expect(screen.getByTestId('reason').textContent).toBe('user_skipped'))
    fireEvent.click(screen.getByText('probe'))
    await waitFor(() => expect(screen.getByTestId('tier').textContent).toBe('usable'))
    expect(n).toBe(1)
  })
})
