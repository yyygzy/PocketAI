// @vitest-environment jsdom
// 助手编辑页「提示词」：一个入口两个页签（系统提示词 / 我的片段）。
// 两者写入各走各的表（assistants.system_prompt / prompt_snippets），本用例只钉入口与插入行为，不做迁移断言。
import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { AssistantEditor } from '../src/renderer/src/modules/chat/AssistantEditor'
import { zh } from '../src/renderer/src/i18n/zh'
import type { PromptSnippetRecord } from '../src/shared/types'
import { mountWithProviders, stubPocketai } from './helpers/renderer'

const L = (k: keyof typeof zh): string => zh[k]

const SNIPPET = {
  id: 's1',
  title: '周报模板',
  content: '本周进展：',
  createdAt: 0,
  updatedAt: 0
} as PromptSnippetRecord

describe('助手编辑页「提示词」：一个入口两个页签', () => {
  const mount = (): void => {
    stubPocketai({
      listKnowledgeBases: () => [],
      listTools: () => [],
      listAvailableTools: () => [],
      listSkills: () => [],
      listPromptSnippets: () => [SNIPPET]
    })
    mountWithProviders(
      <AssistantEditor
        initial={{ name: '助手' }}
        providers={[]}
        onCancel={() => { /* 本用例不判取消 */ }}
        onSaved={() => { /* 本用例不判保存 */ }}
      />
    )
  }

  it('默认落在系统提示词；切到我的片段能看到同一份片段，点一条会追加进系统提示词', async () => {
    mount()
    expect(screen.getByTestId('ae-prompt-tab-system').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByTestId('ae-prompt-tab-snippets'))
    await waitFor(() => expect(screen.getByText(SNIPPET.title)).toBeTruthy())
    fireEvent.click(screen.getByText(SNIPPET.title))

    // 插完自动回到系统提示词页，且正文末尾带上了片段内容
    await waitFor(() => expect(screen.getByTestId('ae-prompt-tab-system').getAttribute('aria-pressed')).toBe('true'))
    const ta = screen.getByPlaceholderText(L('ae.promptPh')) as HTMLTextAreaElement
    expect(ta.value).toContain(SNIPPET.content)
  })
})
