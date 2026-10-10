// @vitest-environment jsdom
// 会话行「改归属助手」菜单：入口存在、点击带正确目标、当前归属打勾
//
// 这是本批唯一新上的用户可见操作（后端通道早就有，缺的就是这个入口），
// 所以按真实 DOM 点一遍：菜单项 key 前缀（'asst' / 'asst:<id>'）与 slice(5)
// 这类字符串切割只有组件用例能兜住。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import type { AssistantRecord, ConversationRecord } from '../src/shared/types'

const asst = (id: string, name: string): AssistantRecord => ({
  id,
  name,
  description: '',
  avatar: '🤖',
  systemPrompt: '',
  defaultProviderId: null,
  defaultModel: null,
  defaultParams: null,
  toolPermissions: [],
  skillIds: [],
  knowledgeBaseIds: [],
  welcomeMessage: '',
  isBuiltin: false,
  isPinned: false,
  createdAt: 1
})

const conv = (over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: 'c1',
  assistantId: 'a-1',
  title: '导入的对话',
  modelLabel: null,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  archived: false,
  titleDefault: false,
  ...over
})

function mount(onSetAssistant: (convId: string, assistantId: string | null) => void, c: ConversationRecord): void {
  stubPocketai({
    getDraft: () => '',
    setDraft: () => ({ ok: true }),
    deleteConversation: () => ({ ok: true })
  })
  mountWithProviders(
    <ConversationList
      conversations={[c]}
      currentId={c.id}
      onSelect={() => {}}
      onNew={() => {}}
      onDelete={() => {}}
      assistants={[asst('asst-default', '内置助手'), asst('a-1', '写作助手'), asst('a-2', '翻译助手')]}
      onSetAssistant={onSetAssistant}
    />
  )
  fireEvent.click(screen.getByLabelText('更多'))
}

describe('会话行改归属菜单', () => {
  it('列出自由会话与其它助手（默认助手不单列，它和自由会话同列表可见）', () => {
    mount(vi.fn(), conv())
    expect(screen.getByText('🚪 自由会话')).toBeTruthy()
    expect(screen.getByText('✓ 👤 写作助手')).toBeTruthy()
    expect(screen.getByText('👤 翻译助手')).toBeTruthy()
    expect(screen.queryByText(/内置助手/)).toBeNull()
  })

  it('点某个助手 → 用会话 id 与目标助手 id 回调', () => {
    const onSet = vi.fn()
    mount(onSet, conv())
    fireEvent.click(screen.getByText('👤 翻译助手'))
    expect(onSet).toHaveBeenCalledWith('c1', 'a-2')
  })

  it('点自由会话 → 目标为 null（写 NULL 而非 asst-default）', () => {
    const onSet = vi.fn()
    mount(onSet, conv())
    fireEvent.click(screen.getByText('🚪 自由会话'))
    expect(onSet).toHaveBeenCalledWith('c1', null)
  })

  it('assistant_id 为 asst-default 的老会话也归到「自由会话」打勾', () => {
    mount(vi.fn(), conv({ assistantId: 'asst-default' }))
    expect(screen.getByText('🚪 ✓ 自由会话')).toBeTruthy()
  })

  it('没给回调时不渲染这些项（父级未接线的视图不该出现无效菜单）', () => {
    stubPocketai({ getDraft: () => '', setDraft: () => ({ ok: true }), deleteConversation: () => ({ ok: true }) })
    mountWithProviders(
      <ConversationList
        conversations={[conv()]}
        currentId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
      />
    )
    // 一个菜单回调都没给时，⋯ 触发器本身就不该出现（空菜单点了没东西）
    expect(screen.queryByLabelText('更多')).toBeNull()
    expect(screen.queryByText(/自由会话/)).toBeNull()
  })
})
