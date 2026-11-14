// @vitest-environment jsdom
// v66/v73 界面：中断判定要如实上屏。
//
// v66 起侧栏按 resumeState 分成「可继续 / 需重新开始」两句；P1-3a 落地后 resumable 终于有真入口，
// 文案才说“可继续”（止血批次里它曾被临时改成“需重新开始”）。这里钉住：
// resumable 说可继续、restart 说需重新开始、老记录（没有判定）不编造。
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { useConversationRuntimeStore } from '../src/renderer/src/store/conversation-runtime-store'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ChatRunResume } from '../src/shared/types'
import type { ConversationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const CONV = { id: 'c-resume', title: '会话', assistantId: 'a1' } as unknown as ConversationRecord

const mount = () => {
  stubPocketai({})
  return mountWithProviders(
    <ConversationList
      conversations={[CONV]}
      currentId={null}
      onSelect={() => {}}
      onNew={() => {}}
      onDelete={() => {}}
      assistants={[]}
    />
  )
}

/** 种一条已中断的运行态（resumeState 缺省＝v66 之前的老记录） */
const seed = (resumeState?: ChatRunResume) => {
  useConversationRuntimeStore.setState({
    byConversation: {
      'c-resume': {
        conversationId: 'c-resume',
        requestId: 'req-resume',
        mode: 'agent',
        state: 'interrupted',
        at: Date.now(),
        stage: 'model',
        stepsDone: 1,
        resumeState
      }
    },
    unreadByConversation: {}
  })
}

beforeEach(() => {
  useConversationRuntimeStore.getState().reset()
})

describe('v66/v73 中断判定上屏', () => {
  it('resumable ⇒ 说「可继续」（P1-3a 已有续跑入口）', async () => {
    seed('resumable')
    mount()
    await waitFor(() =>
      expect(screen.getByTestId('conversation-runtime-resume').textContent).toBe(
        L('chat.runtime.interruptedResumable')
      )
    )
    expect(L('chat.runtime.interruptedResumable')).toContain('可继续')
    expect(screen.queryByText(L('chat.runtime.interruptedRestart'))).toBeNull()
  })

  it('restart ⇒ 说「需重新开始」，不再承诺可继续', async () => {
    seed('restart')
    mount()
    await waitFor(() =>
      expect(screen.getByTestId('conversation-runtime-resume').textContent).toBe(
        L('chat.runtime.interruptedRestart')
      )
    )
    expect(L('chat.runtime.interruptedRestart')).toContain('重新开始')
    expect(L('chat.runtime.interruptedRestart')).not.toContain('可继续')
    expect(screen.queryByText(L('chat.runtime.interruptedResumable'))).toBeNull()
  })

  it('老记录没有判定 ⇒ 不编造"可继续/需重来"，只保留原有那句', async () => {
    seed(undefined)
    mount()
    await waitFor(() => expect(screen.getByText('会话')).toBeTruthy())
    expect(screen.queryByTestId('conversation-runtime-resume')).toBeNull()
    // 圆点的 aria-label 仍是 v60 那句，不冒充判定
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(L('chat.runtime.interrupted'))
  })
})
