// 「文本协议」开关的界面契约：两态文案、悬停说明、点下去传什么，以及零调用提示的互斥规则
// @vitest-environment jsdom
//
// 为什么要这条：B55 第①条写的是"未启用时徽标是灰的、点一下变高亮"，而灰/高亮这种词
// 在代码里其实是两串不同的文案 + 两个不同的 title。只靠真机肉眼看过一次，没人能回答
// "改坏文案会不会有人发现"。这里把**能由 DOM 断言的那一半**钉住；颜色与排版仍属真机。
// 另一条更关键：Iter-113 自己撞出来的死路——开关若只藏在零调用提示里，生效后提示不再出现
// 就关不掉了。所以「常驻在模型栏」与「两条为什么互斥」是同一份契约的两半，一起测。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentModelBar } from '../src/renderer/src/modules/agent/components/AgentModelBar'
import { zeroCallNoticeFlags } from '../src/renderer/src/modules/agent/agent-shared'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ProviderRecord } from '../src/shared/types'

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6']
} as unknown as ProviderRecord

function mountBar(opts: { providerId?: string; model?: string; forced?: boolean; onToggle?: (on: boolean) => void } = {}) {
  const onToggle = opts.onToggle ?? vi.fn()
  mountWithProviders(
    <AgentModelBar
      providers={[glm]}
      providerId={opts.providerId ?? 'glm'}
      model={opts.model ?? 'glm-4.6'}
      onProviderChange={() => {}}
      onModelChange={() => {}}
      selectedProvider={glm}
      fetchingModels={false}
      onFetchModels={() => {}}
      workspaceDir=""
      onPickWorkspace={() => {}}
      textProtocolForced={opts.forced ?? false}
      onToggleTextProtocol={onToggle}
    />
  )
  return onToggle
}

beforeEach(() => {
  stubPocketai({})
})

describe('模型栏上的「文本协议」徽标', () => {
  it('未启用：文案是「文本协议」，悬停说明讲的是"什么时候该用它"', () => {
    mountBar()
    const badge = screen.getByText(zh['agent.textProtocol'])
    expect(badge.getAttribute('title')).toBe(zh['agent.textProtocolHint'])
    // 反向对照：未启用时不能出现"已启用"那串，否则用户以为开关已经生效
    expect(screen.queryByText(zh['agent.textProtocolOn'])).toBeNull()
  })

  it('已启用：文案换成「文本协议已启用」，悬停说明换成"点击关闭"', () => {
    mountBar({ forced: true })
    const badge = screen.getByText(zh['agent.textProtocolOn'])
    expect(badge.getAttribute('title')).toBe(zh['agent.textProtocolOnHint'])
    expect(screen.queryByText(zh['agent.textProtocol'])).toBeNull()
  })

  it('点一下传的是「取反后的目标状态」：关着点 → true，开着点 → false', () => {
    const off = mountBar()
    fireEvent.click(screen.getByText(zh['agent.textProtocol']))
    expect(off).toHaveBeenCalledTimes(1)
    expect(off).toHaveBeenCalledWith(true)

    const on = mountBar({ forced: true })
    fireEvent.click(screen.getByText(zh['agent.textProtocolOn']))
    expect(on).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith(false)
  })

  it('窄窗口塌陷的防回归桩：这一栏必须能换行，两个下拉必须有最小宽度', () => {
    // jsdom 没有排版引擎，量不出像素，所以这里只能钉住**约束本身还在**：
    // 徽标与工作目录都是 shrink-0，一旦下拉丢掉 min-width 又允许压缩，
    // 窗口变窄时它们就会被压成 0 宽（2026-10-13 真机截图正是这个现象）。
    mountBar()
    const bar = screen.getByText(zh['agent.modelConfig']).parentElement!
    expect(bar.className).toContain('flex-wrap')
    for (const sel of Array.from(bar.querySelectorAll('select'))) {
      expect(sel.className).toMatch(/min-w-\[\d+px\]/)
    }
  })

  it('还没选到模型时不出现开关（作用域是 provider+model，没有目标就不该给一个能点的开关）', () => {
    mountBar({ model: '' })
    expect(screen.queryByText(zh['agent.textProtocol'])).toBeNull()
    expect(screen.queryByText(zh['agent.textProtocolOn'])).toBeNull()
  })
})

describe('零调用提示里两条「为什么」互斥', () => {
  const base = { mcpHeldBack: 0, providerId: 'glm', model: 'glm-4.6', textProtocolForced: false }

  it('有 MCP 工具被挡：只说被挡，不再劝改用文本协议', () => {
    const r = zeroCallNoticeFlags({ ...base, mcpHeldBack: 3 })
    expect(r).toEqual({ showHeldBack: true, showSuggest: false })
  })

  it('没有工具被挡、且开关还没开：才给"改用文本协议"的建议', () => {
    expect(zeroCallNoticeFlags(base)).toEqual({ showHeldBack: false, showSuggest: true })
  })

  it('开关已经打开时不重复建议（否则点不到关闭入口，正是 Iter-113 撞过的那条死路）', () => {
    expect(zeroCallNoticeFlags({ ...base, textProtocolForced: true }).showSuggest).toBe(false)
  })

  it('没选服务商/模型时不给建议（那时"零调用"的原因就是根本没有目标可发）', () => {
    expect(zeroCallNoticeFlags({ ...base, providerId: '' }).showSuggest).toBe(false)
    expect(zeroCallNoticeFlags({ ...base, model: '' }).showSuggest).toBe(false)
  })
})
