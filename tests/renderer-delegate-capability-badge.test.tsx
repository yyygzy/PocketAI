// 委派能力徽标的界面契约（V4-Iter-142）——三态 + 未探 + 过期 + 探测中
// @vitest-environment jsdom
//
// 为什么值得挂：这一屏是"这台模型当不当得了管控者"唯一的用户可见出口，
// 而它的措辞纪律很具体 —— **fence_only 不能被写成"能用"**（决策①实测：放宽解析也只到 50%），
// unknown 不能被写成"这台不行"（那可能只是连不上）。两句都靠 DOM 断言钉住；颜色与排版仍归真机。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import React from 'react'
import { mountWithProviders } from './helpers/renderer'
import { DelegateCapabilityBadge } from '../src/renderer/src/modules/settings/DelegateCapabilityBadge'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DelegateCapabilityView } from '../src/shared/delegate-capability'

const entry = (over: Partial<DelegateCapabilityView>): DelegateCapabilityView => ({
  key: 'p1::m1',
  providerId: 'p1',
  model: 'm1',
  capability: 'native_tools_ok',
  samples: 3,
  nativeHits: 3,
  digest: '',
  checkedAt: 1,
  stale: false,
  delegationEnabled: false,
  ...over
})

function mountBadge(props: Partial<React.ComponentProps<typeof DelegateCapabilityBadge>> = {}) {
  const onProbe = props.onProbe ?? vi.fn()
  const onToggleDelegation = props.onToggleDelegation ?? vi.fn()
  mountWithProviders(
    <DelegateCapabilityBadge
      entry={'entry' in props ? props.entry : entry({})}
      probing={props.probing ?? false}
      onStopProbe={props.onStopProbe ?? (() => undefined)}
      onProbe={onProbe}
      onToggleDelegation={onToggleDelegation}
    />
  )
  return onProbe
}

/** 那个「允许顺序委派」勾选框（决策③：默认关，只有判定=可当管控者且未过期才允许点亮） */
function checkbox(): HTMLInputElement | null {
  return document.querySelector('input[type=checkbox]')
}

describe('委派开关（决策③）在徽标里的形状', () => {
  const box = () => {
    const el = checkbox()
    expect(el, '有判定的那一行应当出现开关').not.toBeNull()
    return el as HTMLInputElement
  }

  it('判定=可当管控者 ⇒ 开关可点；勾上把 true 交出去（取消交 false）', () => {
    const onToggle = vi.fn()
    mountBadge({ entry: entry({ capability: 'native_tools_ok', delegationEnabled: false }), onToggleDelegation: onToggle })
    const el = box()
    expect(el.disabled).toBe(false)
    expect(el.checked).toBe(false)
    fireEvent.click(el)
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('已开启时回显 checked=true（读的是 IPC 清单，不是本地乐观态）', () => {
    mountBadge({ entry: entry({ capability: 'native_tools_ok', delegationEnabled: true }) })
    expect(box().checked).toBe(true)
  })

  it('判定不是可当管控者 ⇒ 点不动，且说明写清"要先探测…"', () => {
    const onToggle = vi.fn()
    mountBadge({ entry: entry({ capability: 'fence_only', delegationEnabled: false, nativeHits: 0 }), onToggleDelegation: onToggle })
    const el = box()
    expect(el.disabled).toBe(true)
    fireEvent.click(el)
    expect(onToggle).not.toHaveBeenCalled()
    expect(el.closest('label')?.getAttribute('title')).toContain('要先探测')
  })

  it('结论已过期 ⇒ 同样点不动，提示改成"重探后再开"', () => {
    mountBadge({ entry: entry({ capability: 'native_tools_ok', stale: true }) })
    const el = box()
    expect(el.disabled).toBe(true)
    expect(el.closest('label')?.getAttribute('title')).toContain('模型已更新')
  })

  it('没探过 ⇒ 连开关都不出现（顺序由界面自己强制，不靠事后拒绝）', () => {
    mountBadge({ entry: null })
    expect(checkbox()).toBeNull()
  })
})

describe('DelegateCapabilityBadge', () => {
  it('native_tools_ok：文案与 3/3 同时在场，点「探测」把回调传出去', () => {
    const onProbe = mountBadge({ entry: entry({ capability: 'native_tools_ok' }) })
    expect(screen.getByText(zh['provider.capNative'])).toBeTruthy()
    expect(screen.getByText(/3\/3/)).toBeTruthy()
    fireEvent.click(screen.getByText(zh['provider.capProbe']))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it('fence_only：直说"当前用不了"，且不许出现"可当管控者"字样', () => {
    mountBadge({ entry: entry({ capability: 'fence_only', nativeHits: 0 }) })
    expect(screen.getByText(zh['provider.capFence'])).toBeTruthy()
    expect(screen.queryByText(zh['provider.capNative'])).toBeNull()
  })

  it('no_delegation：给出 0/3 的计数据，不写成"探测未完成"', () => {
    mountBadge({ entry: entry({ capability: 'no_delegation', nativeHits: 0 }) })
    expect(screen.getByText(zh['provider.capNone'])).toBeTruthy()
    expect(screen.getByText(/0\/3/)).toBeTruthy()
    expect(screen.queryByText(zh['provider.capUnknown'])).toBeNull()
  })

  it('unknown：不摆分数（没结论就别装作有数据），悬停说明讲清"未改写此前判定"', () => {
    mountBadge({ entry: entry({ capability: 'unknown', nativeHits: 2, samples: 3 }) })
    expect(screen.getByText(zh['provider.capUnknown'])).toBeTruthy()
    expect(screen.queryByText(/2\/3/)).toBeNull()
    expect(screen.getByText(zh['provider.capUnknown']).getAttribute('title')).toContain(zh['provider.capUnknownReason'])
  })

  it('stale：本地镜像换了摘要时追加"建议重探"', () => {
    mountBadge({ entry: entry({ stale: true }) })
    expect(screen.getByText(new RegExp(zh['provider.capStale'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()))).toBeTruthy()
  })

  it('没探过：只剩一个「探测」入口，不出任何判定文案', () => {
    const onProbe = mountBadge({ entry: null })
    for (const k of ['provider.capNative', 'provider.capFence', 'provider.capNone', 'provider.capUnknown'] as const) {
      expect(screen.queryByText(zh[k])).toBeNull()
    }
    fireEvent.click(screen.getByText(zh['provider.capProbe']))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it('探测中：按钮禁用、文案换成"探测中…"，连点不重复触发', () => {
    const onProbe = mountBadge({ probing: true })
    const btn = screen.getByText(zh['provider.capProbing']).closest('button')
    expect(btn?.disabled).toBe(true)
    fireEvent.click(btn!)
    expect(onProbe).not.toHaveBeenCalled()
  })

  // §246：那一发可能永远不回来（真机挂过 7 分钟）⇒ 探测中那一格必须有第二条路
  it('探测中那一格给一颗「停止」：文案取自字典，点它把中止权交出去', () => {
    const onStop = vi.fn()
    mountBadge({ probing: true, onStopProbe: onStop })
    const stop = screen.getByTestId('probe-stop')
    expect(stop.textContent).toBe(zh['provider.stopProbe'])
    expect(stop.getAttribute('title')).toBe(zh['provider.stopProbeHint'])
    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('反向对照：不在探测时那颗「停止」不存在（它不是常驻按钮）', () => {
    mountBadge({ entry: entry({ capability: 'native_tools_ok' }) })
    expect(screen.queryByTestId('probe-stop')).toBeNull()
  })
})
