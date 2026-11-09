// 批量导出那句进度，对话页侧栏有一格（V4-Iter-330）
//
// `buildBatchExportFiles` 的 `onProgress` 一直是死参数（调用方不传）⇒ 50 个 PDF 那趟约 50 秒，
// 屏上零话。现在 ChatModule 传 `batchExportProgress`，
// ConversationList 在**常驻那一格**渲染（多选那条底栏一点就退多选态，进度挂那儿等于没挂）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import { HookProviders, stubPocketai } from './helpers/renderer'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, ConversationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const read = (p: string): string => fs.readFileSync(p, 'utf8')

const conv = (id: string): ConversationRecord =>
  ({ id, title: `会话${id}`, assistantId: 'a1' }) as unknown as ConversationRecord
const asst = (): AssistantRecord[] =>
  [{ id: 'a1', name: '写作助手', avatar: '🤖', description: '', builtin: false } as unknown as AssistantRecord]

const PROGRESS_TEXT = (done: number, total: number): string =>
  L('chat.exportBatchProgress').replace('{done}', String(done)).replace('{total}', String(total))

beforeEach(() => {
  stubPocketai({
    listConversationGroups: () => [],
    searchMessages: () => [],
    setConversationPinned: () => ({ ok: true }),
    setConversationArchived: () => ({ ok: true })
  })
})

describe('① ConversationList（对话页侧栏）那一格', () => {
  const mount = (progress: { done: number; total: number } | null | undefined): void => {
    render(
      <HookProviders>
        <ConversationList
          conversations={[conv('c1'), conv('c2')]}
          currentId="c1"
          onSelect={() => {}}
          onNew={() => {}}
          onDelete={() => {}}
          assistants={asst()}
          batchExportProgress={progress}
        />
      </HookProviders>
    )
  }

  it('在飞 ⇒ 那格印「导出中 3/50」（逐会话推进的读数，不是「导出中…」的恒话）', () => {
    mount({ done: 3, total: 50 })
    const cell = screen.getByText(PROGRESS_TEXT(3, 50))
    expect(cell.closest('[data-export-batch-progress]')).not.toBeNull()
    // 同一份屏上只许出现一次这句（两屏各一格，不是同一屏两格）
    expect(screen.queryAllByText(PROGRESS_TEXT(3, 50))).toHaveLength(1)
  })

  it('不在飞（null／不传）⇒ 那格不存在，也不留一句过期的「导出中」', () => {
    mount(null)
    expect(document.querySelector('[data-export-batch-progress]')).toBeNull()
    mount(undefined)
    expect(document.querySelector('[data-export-batch-progress]')).toBeNull()
  })
})

describe('③ 这份读数真在传（不是组件里挂了个没人喂的格子）', () => {
  it('父级传一次 batchExportProgress、接一次 onProgress', () => {
    const CHAT = read('src/renderer/src/modules/chat/ChatModule.tsx')
    expect(CHAT.match(/batchExportProgress=\{batchProgress\}/g) ?? [], 'ChatModule 传进度').toHaveLength(1)
    expect(CHAT.match(/onProgress: \(done, total\) => setBatchProgress\(\{ done, total \}\)/g) ?? [], 'ChatModule 接 onProgress').toHaveLength(1)
  })

  it('反向钉：这句话在组件源码里只出现一次（不许同屏两格）', () => {
    const p = 'src/renderer/src/modules/chat/ConversationList.tsx'
    expect(read(p).match(/chat\.exportBatchProgress/g) ?? [], p).toHaveLength(1)
  })
})
