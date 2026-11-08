// P1（V4-Iter-457）：会话列表展示口径纯函数测试
// 钉住四件事：能力筛选只看 agentMode；标题搜索与筛选 AND；全选基于筛选后的可见集；归档跟随筛选。
import { describe, it, expect } from 'vitest'
import {
  filterVisibleConversations,
  isAllVisibleSelected,
  matchesToolsFilter,
  selectAllVisibleIds
} from '../src/renderer/src/modules/chat/conversation-filter'
import type { ConversationRecord } from '../src/shared/types'

const conv = (id: string, title: string, agentMode?: boolean): ConversationRecord =>
  ({ id, title, agentMode }) as unknown as ConversationRecord

const all = [
  conv('c1', '周报讨论', true),
  conv('c2', '普通问答', false),
  conv('c3', '历史记录'), // agentMode 缺省 → 普通对话
  conv('c4', '工具实验', true)
]

describe('matchesToolsFilter：唯一口径是 agentMode', () => {
  it('all 全通过；tools 只要 true；plain 要 false/缺省', () => {
    expect(all.map((c) => matchesToolsFilter(c, 'all'))).toEqual([true, true, true, true])
    expect(all.filter((c) => matchesToolsFilter(c, 'tools')).map((c) => c.id)).toEqual(['c1', 'c4'])
    expect(all.filter((c) => matchesToolsFilter(c, 'plain')).map((c) => c.id)).toEqual(['c2', 'c3'])
  })

  it('不因 modelLabel 前缀改变口径（前缀字段不参与判定）', () => {
    const legacy = { id: 'x', title: '旧前缀', agentMode: false, modelLabel: 'agent:prov:model' } as unknown as ConversationRecord
    expect(matchesToolsFilter(legacy, 'tools')).toBe(false)
    expect(matchesToolsFilter(legacy, 'plain')).toBe(true)
  })
})

describe('filterVisibleConversations：标题搜索与能力筛选是 AND', () => {
  it('空条件返回原数组（不做无谓拷贝）', () => {
    expect(filterVisibleConversations(all)).toBe(all)
  })

  it('只看标题（不区分大小写）', () => {
    expect(filterVisibleConversations(all, { titleQuery: '问答' }).map((c) => c.id)).toEqual(['c2'])
  })

  it('只看能力', () => {
    expect(filterVisibleConversations(all, { toolsFilter: 'tools' }).map((c) => c.id)).toEqual(['c1', 'c4'])
  })

  it('同时命中才保留（AND）', () => {
    expect(
      filterVisibleConversations(all, { titleQuery: '工具', toolsFilter: 'tools' }).map((c) => c.id)
    ).toEqual(['c4'])
    expect(filterVisibleConversations(all, { titleQuery: '工具', toolsFilter: 'plain' })).toEqual([])
  })
})

describe('全选与批量操作：只认筛选后的可见集', () => {
  it('空可见集不算全选', () => {
    expect(isAllVisibleSelected([], [])).toBe(false)
    expect(isAllVisibleSelected([], ['c1'])).toBe(false)
  })

  it('部分选中不是全选；全部选中才是', () => {
    const visible = filterVisibleConversations(all, { toolsFilter: 'tools' })
    expect(isAllVisibleSelected(visible, ['c1'])).toBe(false)
    expect(isAllVisibleSelected(visible, ['c1', 'c4'])).toBe(true)
  })

  it('未过滤列表里的 id 不影响可见集的全选判定', () => {
    const visible = filterVisibleConversations(all, { toolsFilter: 'plain' })
    // c1 是看不见的会话，选上它不能让「普通对话」的分组显示已全选
    expect(isAllVisibleSelected(visible, ['c1', 'c2'])).toBe(false)
    expect(isAllVisibleSelected(visible, ['c2', 'c3'])).toBe(true)
  })

  it('全选写入的 id 只来自可见集', () => {
    const visible = filterVisibleConversations(all, { toolsFilter: 'tools' })
    expect(selectAllVisibleIds(visible)).toEqual(['c1', 'c4'])
  })
})
