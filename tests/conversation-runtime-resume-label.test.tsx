// @vitest-environment jsdom
// v66 界面：中断判定要如实上屏。
//
// 改前侧栏只有一句「运行已中断」，与 v60 完全一样：用户看不出这一轮是"模型还没跑完、可以接着来"，
// 还是"工具已经动过文件、只能整轮重来"。重启对账现在会把判定写进 resumeState，
// 这里钉住界面按它分成两句，且老记录（没有判定）不被编造出一句。
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

describe('v66 中断判定上屏', () => {
  it('可继续 ⇒ 明说「可继续」，不说「需重新开始」', async () => {
    seed('resumable')
    mount()
    await waitFor(() =>
      expect(screen.getByTestId('conversation-runtime-resume').textContent).toBe(
        L('chat.runtime.interruptedResumable')
      )
    )
    expect(screen.queryByText(L('chat.runtime.interruptedRestart'))).toBeNull()
  })

  it('进过工具步 ⇒ 明说「需重新开始」，并点出原因（工具已执行）', async () => {
    seed('restart')
    mount()
    await waitFor(() =>
      expect(screen.getByTestId('conversation-runtime-resume').textContent).toBe(
        L('chat.runtime.interruptedRestart')
      )
    )
    expect(L('chat.runtime.interruptedRestart')).toContain('工具')
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
