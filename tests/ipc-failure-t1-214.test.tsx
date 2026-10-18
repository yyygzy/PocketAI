// V4-Iter-214：T1 崩溃族——safeHandle 的失败是 **resolve 的 {ok:false}**，
// 而这 16 个 await 点把那个对象当数据用：数组 state 被污染后 .map/.length 抛 TypeError ⇒ 整屏错误边界，
// 配置/记录 state 被污染后界面显示库里没有的东西并报"成功"。
// 这里两层证据：① 真挂载的行为用例（FilesModule／ConversationList／useAgentToolConfigs 三族，带正向对照）；
// ② 覆盖全部 16 点的源码形状闸门（判据必须排在写 state 之前），因为 UsagePanel/KnowledgeModule 的真挂载
// 需要几十个 IPC 桩，成本高到不值——这点在台账里如实写明"哪几处只有闸门、没有行为用例"。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { act, renderHook } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useAgentToolConfigs } from '../src/renderer/src/modules/agent/hooks/useAgentToolConfigs'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { FilesModule } from '../src/renderer/src/modules/files/FilesModule'
import type { ConversationRecord, MessageSearchResult } from '../src/shared/types'

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8')
/**
 * 闸门用的读取：**先剥掉整行注释**。
 * 第一版没剥，`getKbDocText` 上方我自己写的注释里正好含 `setText(r.text)` 这个锚点串，
 * 于是 indexOf 命中注释行、判据被排在"写点"之后 ⇒ 假红。锚点会撞注释这件事本身就是这类闸门的坑。
 */
const readCode = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
const toastTexts = (): string[] => screen.queryAllByRole('status').map((e) => e.textContent ?? '')

const asst = (id: string, name: string) => ({
  id,
  name,
  avatar: '🤖',
  description: '',
  systemPrompt: '',
  isBuiltin: false,
  enabled: true,
  toolPermissions: [],
  pinned: false,
  createdAt: 1,
  updatedAt: 1
}) as never

const conv = (over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: 'c1',
  assistantId: 'a-1',
  title: '一条会话',
  modelLabel: null,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  archived: false,
  titleDefault: false,
  ...over
} as ConversationRecord)

const hit = (over: Partial<MessageSearchResult> = {}): MessageSearchResult => ({
  messageId: 'm1',
  conversationId: 'c1',
  conversationTitle: '一条会话',
  role: 'user',
  snippet: '命中片段',
  createdAt: 1,
  ...over
} as MessageSearchResult)

describe('① 真挂载行为：失败不再污染 state、也不再白屏', () => {
  it('Agent 工具配置：setShellConfig 失败 ⇒ 开关仍是库里那份 ＋ toast 逐字给原因', async () => {
    stubPocketai({
      getAgentWorkspaceDir: () => '',
      getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
      getWebSearchConfig: () => ({ enabled: false, provider: 'tavily', apiKey: '', hasKey: false }),
      getCalendarConfig: () => ({ enabled: false, paths: [] }),
      setShellConfig: () => ({ ok: false, error: '参数校验没过' })
    })
    const { result } = renderHook(() => useAgentToolConfigs(), { wrapper: HookProviders })
    await act(async () => {
      await result.current.patchShellConfig({ enabled: true })
    })
    expect(result.current.shellConfig.enabled, '失败不许把开关点亮').toBe(false)
    await waitFor(() => expect(toastTexts().join('|')).toContain('参数校验没过'))
  })

  it('Agent 工具配置：反向对照——成功回写才更新开关（本批只该改失败那一半）', async () => {
    stubPocketai({
      getAgentWorkspaceDir: () => '',
      getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
      getWebSearchConfig: () => ({ enabled: false, provider: 'tavily', apiKey: '', hasKey: false }),
      getCalendarConfig: () => ({ enabled: false, paths: [] }),
      setShellConfig: () => ({ enabled: true, policy: 'auto-safe' })
    })
    const { result } = renderHook(() => useAgentToolConfigs(), { wrapper: HookProviders })
    await act(async () => {
      await result.current.patchShellConfig({ enabled: true })
    })
    expect(result.current.shellConfig.enabled).toBe(true)
    expect(toastTexts().join('|')).toBe('')
  })

  it('选工作目录失败 ⇒ workspaceDir 保持空串（今天会把 {ok:false} 写进去，消费方 .split 直接崩）', async () => {
    stubPocketai({
      getAgentWorkspaceDir: () => '',
      getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
      getWebSearchConfig: () => ({ enabled: false, provider: 'tavily', apiKey: '', hasKey: false }),
      getCalendarConfig: () => ({ enabled: false, paths: [] }),
      pickAgentWorkspaceDir: () => ({ ok: false, error: '对话框不可用' })
    })
    const { result } = renderHook(() => useAgentToolConfigs(), { wrapper: HookProviders })
    await act(async () => {
      await result.current.pickWorkspace()
    })
    expect(result.current.workspaceDir).toBe('')
    await waitFor(() => expect(toastTexts().join('|')).toContain('对话框不可用'))
  })

  it('会话页消息搜索失败 ⇒ 侧栏不崩、给提示、不渲染任何结果行', async () => {
    vi.useRealTimers()
    stubPocketai({
      getDraft: () => '',
      setDraft: () => ({ ok: true }),
      searchMessages: () => ({ ok: false, error: '搜索索引不可用' })
    })
    mountWithProviders(
      <ConversationList
        conversations={[conv()]}
        currentId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        assistants={[asst('a-1', '写作助手')]}
      />
    )
    fireEvent.change(document.querySelector('[data-chat-search-input]')!, { target: { value: '命中' } })
    await waitFor(() => expect(toastTexts().join('|')).toContain('搜索索引不可用'), { timeout: 3000 })
    // 崩没崩的判据：搜索框还在（改前 `for (const r of results)` 会在渲染期抛 TypeError，
    // 没有错误边界兜着 ⇒ testing-library 会把那次抛错直接报给用例）
    expect(document.querySelector('[data-chat-search-input]')).not.toBeNull()
    expect(screen.queryByText('命中片段')).toBeNull()
  })

  it('反向对照：搜索成功那一趟照常渲染命中行、不弹提示', async () => {
    stubPocketai({
      getDraft: () => '',
      setDraft: () => ({ ok: true }),
      searchMessages: () => [hit(), hit({ messageId: 'm2', snippet: '第二条命中' })]
    })
    mountWithProviders(
      <ConversationList
        conversations={[conv()]}
        currentId="c1"
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        assistants={[asst('a-1', '写作助手')]}
      />
    )
    fireEvent.change(document.querySelector('[data-chat-search-input]')!, { target: { value: '命中' } })
    await waitFor(() => expect(screen.getByText('第二条命中')).toBeTruthy(), { timeout: 3000 })
    expect(toastTexts().join('|')).toBe('')
  })

  it('文件管理器：listFiles 失败 ⇒ 停在空列表 ＋ 提示，而不是把失败对象喂给 entries.map', async () => {
    stubPocketai({
      listFiles: () => ({ ok: false, error: '路径不存在' }),
      getPaths: () => ({ dataDir: 'data' }),
      readFile: () => ({ ok: false, error: '读不了' })
    })
    mountWithProviders(<FilesModule />)
    await waitFor(() => expect(screen.getByText('操作失败：路径不存在')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('此文件夹为空')).toBeTruthy()
  })

  it('反向对照：listFiles 成功 ⇒ 表格里出现那一行文件', async () => {
    stubPocketai({
      listFiles: () => [
        { name: 'notes.md', relPath: 'notes.md', size: 12, mtime: 1, isDir: false, kind: 'text' }
      ],
      getPaths: () => ({ dataDir: 'data' }),
      readFile: () => ({ ok: false, error: '读不了' })
    })
    mountWithProviders(<FilesModule />)
    await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy(), { timeout: 3000 })
  })
})

describe('② 形状闸门：16 个点逐个核对「判失败」排在「写 state」之前', () => {
  // [文件, await 锚点, 写 state 锚点, 这一路要求的可见反馈]
  const SITES: Array<[string, string, string, RegExp]> = [
    ['../src/renderer/src/modules/settings/UsagePanel.tsx', 'getUsageDetail(days, EXPORT_LIMIT, id)', 'setDetailItems(r.items)', /toast\.error/],
    ['../src/renderer/src/modules/settings/UsagePanel.tsx', 'getUsageDetail(days, EXPORT_LIMIT, undefined, assistantId)', 'setDetailItems(r.items)', /toast\.error/],
    ['../src/renderer/src/modules/settings/UsagePanel.tsx', 'setUsageBudget(daily, monthly, budgetHardBlockDraft', 'setBudget(next)', /toast\.error/],
    ['../src/renderer/src/modules/settings/UsagePanel.tsx', 'setUsagePricing({ currency, prices })', 'onSaved(next)', /onError/],
    ['../src/renderer/src/modules/agent/hooks/useAgentToolConfigs.ts', 'pickAgentWorkspaceDir()', 'setWorkspaceDir(dir)', /toast\.error/],
    ['../src/renderer/src/modules/agent/hooks/useAgentToolConfigs.ts', 'setShellConfig(patch)', 'setShellConfigState(next)', /toast\.error/],
    ['../src/renderer/src/modules/agent/hooks/useAgentToolConfigs.ts', 'setWebSearchConfig(patch)', 'setWsConfigState(next)', /toast\.error/],
    ['../src/renderer/src/modules/agent/hooks/useAgentToolConfigs.ts', 'setCalendarConfig(patch)', 'setCalConfigState(next)', /toast\.error/],
    ['../src/renderer/src/modules/files/FilesModule.tsx', 'listFiles(dir)', 'setEntries(list)', /showNotice/],
    ['../src/renderer/src/modules/knowledge/KnowledgeModule.tsx', 'saveKnowledgeBase({', 'onSaved(saved)', /setError/],
    ['../src/renderer/src/modules/knowledge/KnowledgeModule.tsx', 'listKbDocuments(kb.id).catch', 'setDocs(list)', /stopPolling/],
    ['../src/renderer/src/modules/knowledge/KnowledgeModule.tsx', 'getKbDocText(doc.id)', 'setText(r.text)', /setError/],
    ['../src/renderer/src/modules/chat/ConversationList.tsx', 'searchMessages(search.trim(), null, dateRange, 0)', 'setResults(r)', /toast\.error/],
    ['../src/renderer/src/modules/chat/ConversationList.tsx', 'searchMessages(search.trim(), null, dateRange, next)', 'setOffset(next)', /toast\.error/],
    ['../src/renderer/src/modules/agent/components/SessionRail.tsx', 'searchMessages(keyword, assistantId || undefined, undefined, 0)', 'setResults(r)', /toast\.error/],
    ['../src/renderer/src/modules/agent/components/SessionRail.tsx', 'searchMessages(keyword, assistantId || undefined, undefined, next)', 'setOffset(next)', /toast\.error/]
  ]

  it('正好 16 个点位，一个都没少（少一处就是有人把闸门当摆设）', () => {
    expect(SITES.length).toBe(16)
  })

  for (const [rel, from, until, feedback] of SITES) {
    it(`${rel.split('/').pop()} — ${from.slice(0, 34)}… 之后、${until.slice(0, 24)}… 之前必须判失败`, () => {
      const src = readCode(rel)
      const a = src.indexOf(from)
      expect(a, `锚点丢了：${from}`).toBeGreaterThanOrEqual(0)
      const b = src.indexOf(until, a)
      expect(b, `落点丢了：${until}`).toBeGreaterThan(a)
      const region = src.slice(a, b)
      expect(region, `${from} 的失败没判（判据不许排在写 state 之后）`).toContain('hasIpcFailed')
      // 判了还要有可见反馈：静默 return 等于把 196 那一族换个形态
      expect(region, `${from} 判了失败但没有反馈面`).toMatch(feedback)
      // 判完必须真的不再往下写：提前 return，或把写操作放进 else 分支（两种都算守住）
      expect(region, `${from} 判了失败却没守住写点（既没 return 也没 else）`).toMatch(/\breturn\b|\belse\b/)
    })
  }

  it('这四处失败提示的文案来源是 IPC 的 error 字段，不是写死的中文（四语面的入口在 ipcFailureText）', () => {
    expect(read('../src/renderer/src/modules/settings/UsagePanel.tsx')).toContain('ipcFailText(')
    expect(read('../src/renderer/src/modules/agent/hooks/useAgentToolConfigs.ts')).toContain('ipcFailText(')
    expect(read('../src/renderer/src/modules/files/FilesModule.tsx')).toContain('ipcFailText(')
    expect(read('../src/renderer/src/modules/knowledge/KnowledgeModule.tsx')).toContain('ipcFailText(')
  })
})
