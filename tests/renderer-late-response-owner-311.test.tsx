// 切到别的选中项之后，迟到的响应不许画进当前屏（V4-Iter-309 同族第二簇，V4-Iter-311）
//
// §309 收了 Agent 面与 ChatModule 两处；本批按同一条判据（「这一发是不是还给当前选中项」）
// 把渲染层扫出来其余五处逐条回读源码后收口：
//   · `KnowledgeModule.tsx` KbDetail 的 `loadDocs`（切库不重挂——:175 渲染不带 key ⇒ 同一实例，
//     库 A 的清单后到就把 A 的文档画在库 B 屏上）；2s 轮询那一发同理（清理 effect 只 clearInterval，
//     拦不住已经飞出去的那一次）。
//   · `KbAskPanel.tsx` 的 `loadSession`：**最重的一处**——迟到响应会连 `sessionId` 一起写过去，
//     于是下一句追问 `persistSession(next, sessionId)` 直接**落库进另一条会话**（不只是画错屏）。
//   · `RemindersModal.tsx` 的 `reload(scope)`：来回点两个 tab ⇒ 历史 tab 摆着待发那批
//     （行内按钮与徽标按 tab 画 ⇒ 对着一张错表点「改期」）。
//   · `FilesModule.tsx` 的 `load(dir)`：进目录后马上点面包屑回上一级 ⇒ 旧目录的列表挂在新的路径标签下。
//   · `NotesModule.tsx` 的 `load(kw)`：搜索框每敲一个字符就发一发（effect 直接盯 `keyword`，无防抖），
//     前一行那一发后到就把上一次的结果整张换掉；那一发若是失败还会把当前关键词的结果清空＋报「读不到」。
//
// 时序不靠 sleep：每发 IPC 的 resolve 都握在用例手里（**按队列存**——§309 的教训：一次交互可能打出
// 两发同名通道，单槽位会被后到的顶掉 ⇒ 迟到响应演不出来、用例假绿）。
// 断言之前的 `settle()` 也是 §309 那条：`act(async …)` 只刷一层微任务，`.then → setState` 还要再排一次。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, HookProviders } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { FilesModule } from '../src/renderer/src/modules/files/FilesModule'
import { NotesModule } from '../src/renderer/src/modules/notes/NotesModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  FileEntry,
  KbAskSessionMeta,
  KbAskSessionRecord,
  KbDocument,
  KnowledgeBase,
  ProviderRecord,
  ReminderRecord
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

/** 在飞请求：`键 → 该键所有未兑现的 resolve`（队列，不是单槽位）。
 *  不写泛型箭头（`.tsx` 里 `<T>(...)` 会被 JSX 抢走解析）；桩返回什么由调用方自己收窄。 */
let q: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(q[key] ??= []).push(resolve)
  })
/** 放行该键**所有**在飞请求（真实后端不会只答其中一发） */
const answer = (key: string, v: unknown): void => {
  const queue = q[key] ?? []
  q[key] = []
  queue.forEach((resolve) => resolve(v))
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const flush = async (fn: () => void): Promise<void> => {
  await act(async () => {
    fn()
    await settle()
  })
}

beforeEach(() => {
  q = {}
})

// ---------- ① 知识库详情：切库 ----------
const kb = (id: string): KnowledgeBase =>
  ({
    id, name: `库 ${id}`, description: '', embeddingProviderId: 'p1', embeddingModel: 'm1',
    embeddingDim: 3, chunkSize: 800, chunkOverlap: 200, topK: 20, topN: 5, minScore: 0,
    rerankProviderId: null, rerankModel: null, hydeProviderId: null, hydeModel: null,
    multiQueryProviderId: null, multiQueryModel: null, ocrProviderId: null, ocrModel: null,
    documentCount: 1, chunkCount: 0, createdAt: 0
  }) as unknown as KnowledgeBase

const docOf = (id: string, kbId: string): KbDocument =>
  ({
    id, kbId, source: `${id}.md`, sourceType: 'txt', title: `文档 ${id}`,
    chunkCount: 0, status: 'ready', error: null, contentHash: null, enabled: true, createdAt: 1
  }) as unknown as KbDocument

describe('§311 ① 知识库详情：切库后旧库那份文档清单不许画进新库', () => {
  beforeEach(() => {
    // 桩集抄 §282 那份（KbDetail 真挂载的现成夹具）
    stubPocketai({
      listKbDocuments: (kbId: string) => pend(`docs:${kbId}`),
      listKbChunks: () => [],
      deleteKbDocument: () => ({ ok: true }),
      setKbDocEnabled: () => ({ ok: true }),
      reindexKbDocs: () => ({ enqueued: 0 }),
      reindexKbDocument: () => ({ ok: true }),
      addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
      listProviders: () => [],
      listKbAskSessions: () => [],
      getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
      onKbAskChunk: () => () => {},
      onKbAskDone: () => () => {},
      onKbAskError: () => () => {},
      reportPerf: () => undefined,
      setAppLanguage: () => Promise.resolve()
    })
  })

  it('挂载库 A 后切到库 B ⇒ B 的屏只留 B，A 迟到的那份一行都不许出现', async () => {
    const view = render(
      <HookProviders><KbDetail kb={kb('kbA')} onChanged={() => {}} /></HookProviders>
    )
    await waitFor(() => expect(q['docs:kbA']?.length).toBeTruthy())
    // 切库：同一个实例（KbDetail 不带 key），新那一发也挂在飞
    view.rerender(
      <HookProviders><KbDetail kb={kb('kbB')} onChanged={() => {}} /></HookProviders>
    )
    await waitFor(() => expect(q['docs:kbB']?.length).toBeTruthy())

    await flush(() => answer('docs:kbB', [docOf('dB1', 'kbB')]))
    expect(screen.getByText('文档 dB1')).toBeTruthy()

    await flush(() => answer('docs:kbA', [docOf('dA1', 'kbA')]))
    expect(screen.queryByText('文档 dA1'), '迟到的旧库清单不许画进新库').toBeNull()
    expect(screen.getByText('文档 dB1'), '新库自己的内容也不许被顺手清掉').toBeTruthy()
  })
})

// ---------- ② 知识库问答：切历史会话（最重的一处：会写进另一条会话）----------
const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'P1', baseUrl: 'https://example.invalid/v1',
  apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as unknown as ProviderRecord

const meta = (id: string): KbAskSessionMeta =>
  ({ id, kbId: 'kb1', title: `会话 ${id}`, messageCount: 1, providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1 }) as unknown as KbAskSessionMeta

const record = (id: string, content: string): KbAskSessionRecord =>
  ({
    id, kbId: 'kb1', title: `会话 ${id}`, messages: [{ role: 'user', content }],
    providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1
  }) as unknown as KbAskSessionRecord

describe('§311 ② 问答历史：迟到的回放不许改当前会话（追问会落库进错会话）', () => {
  let saved: string[]
  let kbAskCalls: number
  const ASST_KB = { id: 'kb1', name: 'K', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase

  beforeEach(() => {
    saved = []
    kbAskCalls = 0
    stubPocketai({
      listProviders: () => [PROVIDER],
      listKbAskSessions: () => [meta('sA'), meta('sB')],
      searchKbAskSessions: () => [],
      getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
      getKbAskSession: (id: string) => pend(`sess:${id}`),
      saveKbAskSession: (rec: { id: string }) => {
        saved.push(rec.id)
        return { ok: true }
      },
      kbAsk: () => {
        kbAskCalls += 1
        return { requestId: 'r-1' }
      },
      kbAskAbort: () => ({ ok: true }),
      onKbAskChunk: () => () => {},
      onKbAskDone: () => () => {},
      onKbAskError: () => () => {},
      exportKbAskSession: () => ({ ok: true }),
      reportPerf: () => undefined
    })
  })

  it('点会话 A 再点 B ⇒ A 的迟到响应既不画进屏、也不许把 sessionId 带过去（追问落库进 B）', async () => {
    mountWithProviders(<KbAskPanel kb={ASST_KB} />)
    // 等 provider 那发落地（发问要有模型）
    await waitFor(() => expect(q['sess:sA']).toBeUndefined())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L('kb.askHistory')}`) }))
    await waitFor(() => expect(screen.getByText('会话 sA')).toBeTruthy())

    fireEvent.click(screen.getByText('会话 sA'))
    await waitFor(() => expect(q['sess:sA']?.length).toBeTruthy())
    fireEvent.click(screen.getByText('会话 sB'))
    await waitFor(() => expect(q['sess:sB']?.length).toBeTruthy())

    await flush(() => answer('sess:sB', record('sB', '乙的历史提问')))
    expect(screen.getByText('乙的历史提问')).toBeTruthy()

    // 现在才让 A 的迟到响应落地
    await flush(() => answer('sess:sA', record('sA', '甲的历史提问')))
    expect(screen.queryByText('甲的历史提问'), '迟到的 A 不许画进当前屏').toBeNull()
    expect(screen.getByText('乙的历史提问'), 'B 自己的消息不许被顶掉').toBeTruthy()

    // 判据取落库后果：追问必须写进 **B**（修前 sessionId 已被 A 的迟到响应改写 ⇒ saved[0]==='sA'）
    const box = document.querySelector('textarea')!
    fireEvent.change(box, { target: { value: '新一轮追问' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L('kb.askSend')}`) }))
    await flush(() => {})
    expect(kbAskCalls, '发问要真的打出去（否则这条判据是空转）').toBe(1)
    expect(saved, '追问必须落在当前那条会话上').toEqual(['sB'])
  })
})

// ---------- ③ 提醒中心：切 tab ----------
const reminder = (id: string, text: string, status: 'pending' | 'done'): ReminderRecord =>
  ({
    id, text, fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(), status,
    conversationId: null, createdAt: new Date(2026, 9, 10, 8, 0, 0).getTime()
  }) as unknown as ReminderRecord

describe('§311 ③ 提醒中心：切 tab 后旧 tab 那份列表不许画进新 tab', () => {
  beforeEach(() => {
    stubPocketai({
      listReminders: (scope: string) => pend(`rem:${scope}`),
      onReminderFired: () => () => {},
      cancelReminder: () => ({ ok: true }),
      rescheduleNextReminder: () => ({ ok: true }),
      updateReminder: () => ({ ok: true })
    })
  })

  it('点「历史」后待发的迟到响应不许留在历史 tab 上', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(q['rem:pending']?.length).toBeTruthy())
    fireEvent.click(screen.getByText(L('reminder.center.tabHistory')))
    await waitFor(() => expect(q['rem:history']?.length).toBeTruthy())

    await flush(() => answer('rem:history', [reminder('h1', '历史那条', 'done')]))
    expect(screen.getByText('历史那条')).toBeTruthy()

    await flush(() => answer('rem:pending', [reminder('p1', '待发那条', 'pending')]))
    expect(screen.queryByText('待发那条'), '迟到的待发列表不许画进历史 tab').toBeNull()
    expect(screen.getByText('历史那条'), '历史那批也不许被顺手清掉').toBeTruthy()
  })
})

// ---------- ④ 文件管理页：切目录 ----------
const entry = (name: string, relPath: string, isDir = false): FileEntry =>
  ({ name, relPath, isDir, size: isDir ? 0 : 12, mtime: 1 }) as unknown as FileEntry

describe('§311 ④ 文件页：回上一级后旧目录那份列表不许挂在新路径下', () => {
  beforeEach(() => {
    stubPocketai({
      listFiles: (dir: string) => pend(`files:${dir}`),
      getPaths: () => ({ dataDir: 'data' }),
      readFile: () => ({ ok: false, error: '读不了' })
    })
  })

  it('进目录 A 再点面包屑回根目录 ⇒ A 的迟到列表不许画出来，也不许替新目录关掉「加载中」', async () => {
    mountWithProviders(<FilesModule />)
    await waitFor(() => expect(q['files:']?.length).toBeTruthy())
    await flush(() => answer('files:', [entry('A', 'A', true)]))
    expect(screen.getByText('A')).toBeTruthy()

    fireEvent.click(screen.getByText('A')) // 进 A：这一发挂着不放
    await waitFor(() => expect(q['files:A']?.length).toBeTruthy())
    fireEvent.click(screen.getByText('data')) // 面包屑回根目录
    await waitFor(() => expect(q['files:']?.length).toBeTruthy())

    await flush(() => answer('files:', [entry('B', 'B', true)]))
    expect(screen.getByText('B')).toBeTruthy()

    await flush(() => answer('files:A', [entry('迟到的文件.txt', 'A/迟到的文件.txt')]))
    expect(screen.queryByText('迟到的文件.txt'), '旧目录的内容不许挂在新路径标签下').toBeNull()
    expect(screen.getByText('B'), '当前目录的内容也不许被顺手清掉').toBeTruthy()
  })
})

// ---------- ⑤ 笔记：连着敲两个关键词 ----------
const noteOf = (id: string, title: string): unknown =>
  ({ id, title, content: `正文 ${title}`, tags: [], pinned: false, createdAt: 1, updatedAt: 1 })

describe('§311 ⑤ 笔记：前一个关键词那一发的迟到结果不许换掉当前搜索结果', () => {
  beforeEach(() => {
    stubPocketai({
      listNotes: () => pend('notes:'),
      searchNotes: (kw: string) => pend(`notes:${kw}`)
    })
  })

  it('敲 a 再敲 ab ⇒ a 那发迟到了也不许把 ab 的屏换掉（正向对照：当前那发照常画）', async () => {
    mountWithProviders(<NotesModule />)
    const box = screen.getByPlaceholderText(L('notes.searchPlaceholder'))
    await waitFor(() => expect(q['notes:']?.length).toBeTruthy())
    await flush(() => answer('notes:', [noteOf('n0', '全部笔记')]))
    expect(screen.getByText('全部笔记')).toBeTruthy()

    await flush(() => fireEvent.change(box, { target: { value: 'a' } }))
    await waitFor(() => expect(q['notes:a']?.length).toBeTruthy())
    await flush(() => fireEvent.change(box, { target: { value: 'ab' } }))
    await waitFor(() => expect(q['notes:ab']?.length).toBeTruthy())

    await flush(() => answer('notes:ab', [noteOf('n2', '甲乙笔记')]))
    expect(screen.getByText('甲乙笔记'), '当前关键词自己那一发必须照常画出来').toBeTruthy()

    // 现在才放行挂着的那一发：修前它会把整张列表换成 a 的结果
    await flush(() => answer('notes:a', [noteOf('n1', '甲笔记')]))
    expect(screen.queryByText('甲笔记'), '迟到那一发不许换掉当前搜索结果').toBeNull()
    expect(screen.getByText('甲乙笔记'), '当前关键词的结果也不许被顺手清掉').toBeTruthy()
  })
})

// 防"桩没被用上"的空转对照在各自用例里：每一发都要 `waitFor` 到它真的挂在飞，
// ②还额外数了 `kbAsk` 的调用次数（发问没打出去 ⇒ 落库判据就是空转）。
