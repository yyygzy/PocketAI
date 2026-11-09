// @vitest-environment jsdom
// §437（P0-5 渲染端只读接档）：`annotateTraceReplay` 在主进程把三档判定塞进 trace 记录，但渲染端一个字没显示。
// 形态＝主行右端的**行内徽标**（不另起一行、不挤压工具名）：短标识（符号＋短词）常显，成因长句进 `title`。
// 本枚钉五件事：
//   ① 三档事实（replayable／expired／never_stored）各用独立 testid＋符号＋短词，**成因不同**（还留着／被清理／从没存过）；
//   ② `replay` 为 `undefined`（DB/fs 异常时主进程按约定不附这一颗）单独落「判定不可用」，
//      **不许默认成 expired 或 never_stored**——这是本批最重要的一条；
//   ③ 四态不是只靠颜色：短词与符号两两不同，悬停文案各说各的成因；
//   ④ 四态节点里没有按钮／没有任何执行入口（本批只读，不做回放/dry-run/续跑）；
//   ⑤ `AgentTraceList` 真把 `tr.replay` 递给这个组件，且挂在主行内（结构锚点，防"组件写了但没接上"）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { screen } from '@testing-library/react'
import { mountWithProviders } from './helpers/renderer'
import { TraceReplayStatus } from '../src/renderer/src/modules/agent/components/TraceReplayStatus'
import { zh } from '../src/renderer/src/i18n/zh'

const ROOT = path.resolve(__dirname, '..')
// P2 / V4-Iter-459：步骤流本体在 AgentTraceList；P4 批次 2 已删 Agent 壳。
const LIST = path.join(ROOT, 'src/renderer/src/modules/agent/components/AgentTraceList.tsx')
const COMPONENT = path.join(ROOT, 'src/renderer/src/modules/agent/components/TraceReplayStatus.tsx')

const LONG = {
  replayable: zh['agent.traceReplay.replayable'],
  expired: zh['agent.traceReplay.expired'],
  neverStored: zh['agent.traceReplay.neverStored'],
  unavailable: zh['agent.traceReplay.unavailable']
}
const SHORT = {
  replayable: zh['agent.traceReplay.short.replayable'],
  expired: zh['agent.traceReplay.short.expired'],
  neverStored: zh['agent.traceReplay.short.neverStored'],
  unavailable: zh['agent.traceReplay.short.unavailable']
}

describe('§437 回放状态：行内徽标（三档事实＋一档判定不可用）', () => {
  it('replayable：短词常显、悬停说清"还留着"，且不提供执行入口', () => {
    const { container } = mountWithProviders(<TraceReplayStatus replay="replayable" />)
    const node = screen.getByTestId('trace-replay-replayable')
    expect(node.textContent).toContain('↺')
    expect(node.textContent).toContain(SHORT.replayable)
    expect(node.getAttribute('title')).toBe(LONG.replayable)
    expect(LONG.replayable).toContain('缓存文件')
    expect(LONG.replayable).toContain('消息记录')
    expect(LONG.replayable).toContain('不提供执行入口')
    expect(screen.queryByTestId('trace-replay-expired')).toBeNull()
    expect(screen.queryByTestId('trace-replay-never-stored')).toBeNull()
    expect(screen.queryByTestId('trace-replay-unavailable')).toBeNull()
    expect(container.querySelectorAll('button').length).toBe(0)
  })

  it('expired：悬停写明是冷数据被清理导致，不含糊成"不可用"', () => {
    mountWithProviders(<TraceReplayStatus replay="expired" />)
    const node = screen.getByTestId('trace-replay-expired')
    expect(node.textContent).toContain('⧗')
    expect(node.textContent).toContain(SHORT.expired)
    expect(node.getAttribute('title')).toBe(LONG.expired)
    expect(LONG.expired).toContain('已过期')
    expect(LONG.expired).toContain('已被清理')
    expect(LONG.expired).not.toBe('不可回放')
  })

  it('never_stored：悬停写明"当时就没存"，与"被清理"分开', () => {
    mountWithProviders(<TraceReplayStatus replay="never_stored" />)
    const node = screen.getByTestId('trace-replay-never-stored')
    expect(node.textContent).toContain('∅')
    expect(node.textContent).toContain(SHORT.neverStored)
    expect(node.getAttribute('title')).toBe(LONG.neverStored)
    expect(LONG.neverStored).toContain('当时未存')
    expect(LONG.neverStored).toContain('从未留存')
    expect(LONG.neverStored).not.toContain('已被清理')
  })

  it('判定不可用：undefined 单独成一档，既不落 expired 也不落 never_stored', () => {
    mountWithProviders(<TraceReplayStatus />)
    const node = screen.getByTestId('trace-replay-unavailable')
    expect(node.textContent).toContain('!')
    expect(node.textContent).toContain(SHORT.unavailable)
    expect(node.getAttribute('title')).toBe(LONG.unavailable)
    expect(screen.queryByTestId('trace-replay-expired')).toBeNull()
    expect(screen.queryByTestId('trace-replay-never-stored')).toBeNull()
    expect(screen.queryByTestId('trace-replay-replayable')).toBeNull()
    // 悬停文案保留原意：这次读不出来，且把两种错误默认口径都点名否掉
    expect(LONG.unavailable).toContain('判定不可用')
    expect(LONG.unavailable).toContain('数据库或文件系统异常')
    expect(LONG.unavailable).toContain('不等于已清理')
    expect(LONG.unavailable).toContain('也不等于没存过')
  })

  it('四态互异：短词与符号两两不同，四句悬停文案成因各自成句', () => {
    const shortTexts = [SHORT.replayable, SHORT.expired, SHORT.neverStored, SHORT.unavailable]
    expect(new Set(shortTexts).size).toBe(4)
    const longs = [LONG.replayable, LONG.expired, LONG.neverStored, LONG.unavailable]
    expect(new Set(longs).size).toBe(4)
    expect(LONG.replayable).not.toContain('已被清理')
    expect(LONG.expired).not.toContain('当时未存')
    expect(LONG.neverStored).not.toContain('判定不可用')
    expect(LONG.unavailable).not.toContain('当时未存')
  })

  it('AgentTraceList 把 tr.replay 递给徽标并挂在主行内（不另起一行、不挤压工具名）', () => {
    const src = fs.readFileSync(LIST, 'utf-8')
    expect(src).toContain("import { TraceReplayStatus } from './TraceReplayStatus'")
    const statusIdx = src.indexOf('<TraceReplayStatus replay={tr.replay} />')
    expect(statusIdx).toBeGreaterThan(-1)
    // 位置身份：紧跟在主行的 tokens 之后（同一个 `line` 片段里），不是行外独立节点
    expect(statusIdx).toBeGreaterThan(src.indexOf('{stepTokens &&'))
    expect(src.split('<TraceReplayStatus replay={tr.replay} />').length - 1).toBe(1)
    // 布局身份：ml-auto＋shrink-0＋nowrap＝靠右、不压工具名、不换行加高
    const comp = fs.readFileSync(COMPONENT, 'utf-8')
    expect(comp).toContain('ml-auto shrink-0 whitespace-nowrap')
  })
})
