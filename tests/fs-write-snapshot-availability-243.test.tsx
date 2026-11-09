// @vitest-environment jsdom
// P0-5 第三批②：快照"本机没有"时，结果卡**在点击前**就不提供还原入口。
//
// 这条是上一批留下的真实缺口：异机恢复后快照文件不在本机，按钮照旧在，点了才报 SNAPSHOT_NOT_FOUND。
// 判据 = 三个状态各看一次脸：
//  · false   → 没有按钮，role=status 的原话必须是"本机没有这份快照…"，且不许出现"加载中"字样；
//  · undefined（尚未确认）→ 也没有按钮（不给一个点了必然失败的入口）；
//  · true    → 按钮出现（反向对照，防止把入口恒关）。
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { FsWriteActions } from '../src/renderer/src/components/agent/FsWriteActions'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const content = JSON.stringify({ path: 'note.txt', bytes: 12, snapshotId: 'snap-1' })

describe('快照存在性决定还原入口（点击前生效）', () => {
  it('本机没有 ⇒ 没有按钮，文案说清事实且不暗示"还在加载"', () => {
    stubPocketai({})
    mountWithProviders(<FsWriteActions resultContent={content} snapshotAvailable={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toBe(L('agent.fsWrite.snapshotMissing'))
    // 事实口径：必须提到"另一台设备"这一种来源；不许写成"正在加载/稍后重试"
    expect(status).toContain('另一台设备')
    expect(status).not.toMatch(/加载|稍后|重试/)
  })

  it('尚未确认 ⇒ 也不出现按钮（宁可不出入口，也不给点了必然失败的按钮）', () => {
    stubPocketai({})
    mountWithProviders(<FsWriteActions resultContent={content} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('反向对照：确认存在 ⇒ 按钮在', () => {
    stubPocketai({})
    mountWithProviders(<FsWriteActions resultContent={content} snapshotAvailable />)
    expect(screen.getByRole('button').textContent).toBe(L('agent.fsWrite.restore'))
  })
})
