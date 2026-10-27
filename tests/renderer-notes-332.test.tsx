// §332：笔记屏的五张到货——改前这一屏**一个信封判据都没有**（只留痕），而 safeHandle 的失败是 **resolve 的值**
//
// 逐条对着源码的缺陷形状（`NotesModule.tsx`）：
//  · `:87` 列表那一读 `setNotes(list)`：失败对象被当数组用 ⇒ 渲染 `notes.map` 里 `n.content.slice(0,40)`
//    当场 TypeError＝**整块屏不见**（根层边界接住，用户看到笔记页什么都不剩）。
//  · `:201` 新建那一发 `setNotes(prev => [note, ...prev])` ＋ `setActiveId(note.id)`：同一张崩脸，
//    而 preload 早就把 `createNote` 的类型写成只有成功形状（`preload/index.ts:652-664` 七条同族）⇒ tsc 不逼判。
//  · `:152` 自动保存 `if (updated)`：失败对象是真值 ⇒ 走成功支，「上次保存」被写成 `fmtTime(undefined)`
//    ＝**NaN-NaN-NaN NaN:NaN**，列表里那条还是旧内容；最常触发的一张脸是正文超 100_000 字符被 zod 整条拒
//    （`schemas/notes.ts:6`，而这一屏的 textarea 没有任何限长提示）。
//  · `:152` 的第三种到货 `null`（笔记在别处被删）＝改前静默跳过：看着还在编辑，其实每 500ms 白写一发。
//  · `:214` 删除那一发 `{ok}` 从没被读 ⇒ 失败也撤行＝演成"删掉了"，库里那条还在、下次开机又回来。
//  · `:243` 置顶是"先改屏再落库"的乐观改动：失败必须把图钉退回，改前失败对象还会被当记录写进列表。
//  · `:118` 那条 effect 依赖 `active` 对象 ⇒ 自动保存写回会让它换身份，把用户正在敲的那几个字无条件吞掉。
//
// 时序不靠 sleep：每发 IPC 的 resolve 握在用例手里（队列，§309 的教训）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { NotesModule } from '../src/renderer/src/modules/notes/NotesModule'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

let q: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(q[key] ??= []).push(resolve)
  })
const answer = (key: string, v: unknown): void => {
  const queue = q[key] ?? []
  q[key] = []
  queue.forEach((resolve) => resolve(v))
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const noteOf = (id: string, title: string, over: Record<string, unknown> = {}): unknown => ({
  id,
  title,
  content: `正文 ${title}`,
  tags: [],
  pinned: false,
  createdAt: 1,
  updatedAt: 2_000,
  ...over
})

/** safeHandle 的入参拒绝形状（`safe-handle.ts:131`）：回码＋`path=code=origin=bound`，多条以 `|` 相连 */
const argFail = (tail: string, spec: string): unknown => ({
  ok: false,
  error: tail,
  ipcCode: 'IPC_ARG_INVALID',
  ipcArgs: spec
})

const mount = (): ReturnType<typeof render> =>
  mountWithProviders(<NotesModule />)

const box = (): HTMLElement => screen.getByPlaceholderText(L('notes.contentPlaceholder'))

beforeEach(() => {
  q = {}
})

describe('332① 笔记列表那一读：失败对象不许当数组用（改＝整块屏不见）', () => {
  it('回 `{ok:false}` ⇒ 走"读不到＋重试"那一张脸，屏上元素还在（正向对照：成功那一发照常画条目）', async () => {
    stubPocketai({
      listNotes: () => pend('list'),
      searchNotes: () => pend('list')
    })
    mount()
    await waitFor(() => expect(q['list']?.length).toBeTruthy())
    await answer('list', { ok: false, error: 'database is locked' })
    await settle()

    expect(screen.getByText(L('notes.loadFail')), '读不到要说出来').toBeTruthy()
    expect(screen.getByText(L('notes.retry')), '那一屏的重试键必须在场（不是只留一句消失的 toast）').toBeTruthy()
    expect(screen.getByPlaceholderText(L('notes.searchPlaceholder'))).toBeTruthy()
    // 改前：`notes.map` 里 `n.content.slice` 对 undefined 抛错 ⇒ 到这一步整个 render 就炸了，上面三句都取不到
  })

  it('反向对照：成功那一发仍然照常规整张列表（判据不是恒拦）', async () => {
    stubPocketai({
      listNotes: () => pend('list'),
      searchNotes: () => pend('list')
    })
    mount()
    await waitFor(() => expect(q['list']?.length).toBeTruthy())
    await answer('list', [noteOf('n1', '甲笔记')])
    await settle()

    expect(screen.getByText('甲笔记')).toBeTruthy()
    expect(screen.queryByText(L('notes.loadFail')), '成功不许演成读不到').toBeNull()
  })
})

describe('332② 新建那一发：失败不许塞进列表、也不许把 undefined 当选中项', () => {
  it('回 `{ok:false}` ⇒ 列表不许多出条目、那句「新建失败」要上屏', async () => {
    stubPocketai({
      listNotes: () => [noteOf('n1', '甲笔记')],
      searchNotes: () => [],
      createNote: () => pend('create')
    })
    mount()
    await waitFor(() => expect(screen.getByText('甲笔记')).toBeTruthy())

    fireEvent.click(screen.getByText(`+ ${L('notes.new')}`))
    await waitFor(() => expect(q['create']?.length).toBeTruthy())
    await answer('create', { ok: false, error: '笔记数量已达上限' })
    await settle()

    expect(screen.getByText('甲笔记'), '原有那条还在').toBeTruthy()
    expect(screen.queryByText(L('notes.untitled')), '失败的那一条不许被塞进列表首位').toBeNull()
    expect(screen.getByText(/笔记数量已达上限/), '要说原因（原因来自信封，不是通用文案）').toBeTruthy()
    expect(screen.getByText(/新建失败/)).toBeTruthy()
  })
})

describe('332③ 自动保存那一发的三张到货', () => {
  const mountActive = async (): Promise<void> => {
    stubPocketai({
      listNotes: () => [noteOf('n1', '甲笔记')],
      searchNotes: () => [],
      updateNote: () => pend('upd'),
      deleteNote: () => pend('del'),
      createNote: () => noteOf('n9', '新笔记')
    })
    mount()
    await waitFor(() => expect(screen.getByText('甲笔记')).toBeTruthy())
    fireEvent.click(screen.getByText('甲笔记'))
    fireEvent.change(box(), { target: { value: '刚敲进去的一整段' } })
    await waitFor(() => expect(q['upd']?.length).toBeTruthy())
  }

  it('zod 整条拒（正文过长）⇒ 说原因，且「上次保存」不许变成 NaN-NaN-NaN', async () => {
    await mountActive()
    await answer('upd', argFail('String must contain at most 100000 character(s)', 'content=too_big=string=100000'))
    await settle()

    expect(screen.getByText(/自动保存失败/), '失败要说').toBeTruthy()
    expect(screen.getByText(/100000/), '原因要带那道闸的数字').toBeTruthy()
    expect(document.body.textContent ?? '', '时间戳不许被失败对象喂成 NaN').not.toMatch(/NaN/)
  })

  it('回 `null`（笔记在别处被删）⇒ 明说"已经不在了"，不是每 500ms 白写一发却零句', async () => {
    await mountActive()
    await answer('upd', null)
    await settle()
    expect(screen.getByText(L('notes.gone')), '第三种到货要单独一句').toBeTruthy()
  })

  it('成功回包不许吞掉在飞敲进去的字（改前那条 effect 盯的是 `active` 对象身份）', async () => {
    await mountActive()
    // 服务端回来的仍是旧正文；改前写回列表会让 `active` 换身份 ⇒ [active] 的 effect 把草稿重置成旧内容
    await answer('upd', noteOf('n1', '甲笔记', { content: '正文 甲笔记', updatedAt: 9_000 }))
    await settle()

    expect((box() as HTMLTextAreaElement).value, '用户敲的那段必须留在框里').toBe('刚敲进去的一整段')
    expect(document.body.textContent ?? '').not.toMatch(/NaN/)
  })
})

describe('332④ 删除那一发：`{ok}` 得读', () => {
  const removeFlow = async (reply: unknown): Promise<void> => {
    stubPocketai({
      listNotes: () => [noteOf('n1', '甲笔记')],
      searchNotes: () => [],
      updateNote: () => noteOf('n1', '甲笔记'),
      deleteNote: () => reply
    })
    mount()
    await waitFor(() => expect(screen.getByText('甲笔记')).toBeTruthy())
    fireEvent.click(screen.getByText('甲笔记'))
    fireEvent.click(screen.getByText(`🗑 ${L('common.delete')}`))
    await waitFor(() => expect(screen.getByText(L('common.confirm'))).toBeTruthy())
    fireEvent.click(screen.getByText(L('common.confirm')))
    await settle()
  }

  it('回 `{ok:false}` ⇒ 那一行不许消失，并说出原因（改前撤行＝演成"删掉了"，库里那条还在）', async () => {
    await removeFlow({ ok: false, error: 'busy' })
    expect(screen.getByText('甲笔记'), '失败不许把行撤掉').toBeTruthy()
    expect(screen.getByText(/删除失败/), '要说原因').toBeTruthy()
  })

  it('反向对照：回 `{ok:true}` 那一行才消失', async () => {
    await removeFlow({ ok: true })
    expect(screen.queryByText('甲笔记')).toBeNull()
  })
})

describe('332⑤ 置顶那一发：乐观改动失败要退回', () => {
  it('回 `{ok:false}` ⇒ 图钉退回原样并说一句（改前失败对象还会被当记录写进列表＝当场崩屏）', async () => {
    stubPocketai({
      listNotes: () => [noteOf('n1', '甲笔记')],
      searchNotes: () => [],
      updateNote: () => ({ ok: false, error: 'locked' }),
      deleteNote: () => ({ ok: true })
    })
    mount()
    await waitFor(() => expect(screen.getByText('甲笔记')).toBeTruthy())
    fireEvent.click(screen.getByText('甲笔记'))
    fireEvent.click(screen.getByTitle(L('notes.pin')))
    await settle()

    expect(screen.getByText(/置顶失败/), '要说原因').toBeTruthy()
    expect(document.body.textContent ?? '').not.toMatch(/NaN/)
    expect(screen.getByText('甲笔记'), '列表不许被失败对象污染').toBeTruthy()
  })
})
