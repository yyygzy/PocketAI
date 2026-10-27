// V4-Iter-332（F1／F2）：文件管理页那颗👁预览与四颗「在系统里打开」
//
// F2（`FilesModule.tsx` `handleOpenPreview`）：这一发改前既没有归属也没有代次（§311 的 `dirRef`
// 只守列表那两趟）。两张脸：
//  · 连点👁两个文件，先点那一发若**后到** ⇒ 面板挂着后点那份，内容被换成先点那一份；
//  · 关掉了面板，迟到的那一发 ⇒ 面板**自己弹回来**（用户明明已经关了）。
// 修法：代次 `previewReqRef` 在"开"与"关"两侧都推进（关窗＝作废在飞那一发）。
//
// F1（同屏四颗「打开」键 + 主进程）：调用点改前只挂 `.catch`——safeHandle 把失败转成 **resolve 的
// `{ok:false}`** ⇒ catch 永不响，那句是死代码；而 `files-service.ts` 把 `shell.openPath` 的返回错误串
// **丢了**（没消费返回值 → `{ok:true}`），于是"什么都没打开"回的是成功。
// 两处一起修：主进程消费 openPath 返回值、调用点 `await` 后判 `hasIpcFailed` 各说一句。
// 四颗键（工具栏📤、行内 ↗、行内 📍、面板内 ↗）各点一次，加 `{ok:true}` 与 reject 两面。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { FilesModule } from '../src/renderer/src/modules/files/FilesModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { FileEntry, FileReadResult } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

/** 在飞请求：`键 → 未兑现的 resolve 队列`（不是单槽位） */
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
const flush = async (fn: () => void): Promise<void> => {
  await act(async () => {
    fn()
    await settle()
  })
}

const entry = (name: string, relPath: string): FileEntry =>
  ({ name, relPath, isDir: false, size: 12, mtime: 1 }) as unknown as FileEntry

const read = (content: string): FileReadResult =>
  ({ ok: true, kind: 'text', content, size: content.length, truncated: false }) as unknown as FileReadResult

/** 预览读不到时回的形状（kind/size 只是让类型对上，判据只看 ok） */
const unread = (error: string): FileReadResult =>
  ({ ok: false, error, kind: 'binary', content: null, size: 0, truncated: false }) as unknown as FileReadResult

/** 那句是 2600ms 自动消失的 span（没有 role）⇒ 每次放行后**当场**读，不用 waitFor 等它 */
const dataDirBtn = (): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(L('fm.openDataDir')) })
/** `noUncheckedIndexedAccess` 开着：取第几颗就当场收窄，别在每个调用点补感叹号 */
const eye = (i: number): HTMLElement => screen.getAllByTitle(L('fm.preview'))[i] as HTMLElement
const externalAt = (i: number): HTMLElement => screen.getAllByTitle(L('fm.openExternal'))[i] as HTMLElement
const locationAt = (i: number): HTMLElement => screen.getAllByTitle(L('fm.openLocation'))[i] as HTMLElement
/** 面板内那颗 ↗ 没有 title（行内那两颗才有）⇒ 按整串可及名取，行内那颗的名只有 `↗` */
const panelExternalBtn = (): HTMLElement =>
  screen.getByRole('button', { name: `↗ ${L('fm.openExternal')}` })

beforeEach(() => {
  q = {}
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
  stubPocketai({
    listFiles: (dir: string) => (dir === '' ? [entry('甲.txt', '甲.txt'), entry('乙.txt', '乙.txt')] : []),
    getPaths: () => ({ dataDir: 'data' }),
    readFile: (relPath: string) => pend(`read:${relPath}`),
    openFileExternal: (relPath: string) => pend(`ext:${relPath}`),
    openFileLocation: (relPath: string) => pend(`loc:${relPath}`),
    saveFileAs: () => ({ ok: true }),
    deleteFile: () => ({ ok: true }),
    uploadFile: () => ({ ok: true })
  })
  mountWithProviders(<FilesModule />)
})

describe('§332 F2 预览那一发：迟到结果顶不掉后来点的那一份，也不许把已关的面板弹回来', () => {
  it('连点👁两个文件 ⇒ 先点那发迟到也不许换掉后点那一份', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(0)) // 甲
    await waitFor(() => expect(q['read:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(1)) // 乙
    await waitFor(() => expect(q['read:乙.txt']?.length).toBeTruthy(), MOUNT_BUDGET)

    await flush(() => answer('read:乙.txt', read('正文-乙乙')))
    expect(screen.getByText('正文-乙乙')).toBeTruthy()

    await flush(() => answer('read:甲.txt', read('正文-甲甲')))
    expect(screen.queryByText('正文-甲甲'), '先点那发的迟到结果不许顶掉后点那一份').toBeNull()
    expect(screen.getByText('正文-乙乙'), '后点那一份也不许被顺手清掉').toBeTruthy()
  })

  it('面板开着时点👁另一份再按× ⇒ 迟到的那一发不许把面板弹回来', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(0))
    await waitFor(() => expect(q['read:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('read:甲.txt', read('正文-甲甲')))
    expect(screen.getByText('正文-甲甲')).toBeTruthy()

    fireEvent.click(eye(1)) // 乙在飞，面板此刻仍挂着甲
    await waitFor(() => expect(q['read:乙.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(screen.getByText('×')) // 关窗
    expect(screen.queryByText('正文-甲甲')).toBeNull()

    await flush(() => answer('read:乙.txt', read('正文-乙乙')))
    expect(screen.queryByText('正文-乙乙'), '已经关掉的面板不许被迟到的那一发弹回来').toBeNull()
  })

  it('迟到那一发是失败 ⇒ 不许替当前那一次说「读不了」；当前那发自己失败要说话（正向对照）', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(0))
    await waitFor(() => expect(q['read:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(1))
    await waitFor(() => expect(q['read:乙.txt']?.length).toBeTruthy(), MOUNT_BUDGET)

    await flush(() => answer('read:甲.txt', unread('BOOM-迟到读不了')))
    expect(bodyText(), '当前那一发还没答复，那句不许由迟到那发代挂').not.toContain('BOOM-迟到读不了')

    await flush(() => answer('read:乙.txt', unread('BOOM-当前读不了')))
    expect(bodyText(), '代次判据不是"把响应全丢掉"：当前那发失败必须上屏').toContain('BOOM-当前读不了')
    expect(screen.queryByText('BOOM-迟到读不了'), '迟到的失败永远不该上屏').toBeNull()
  })

  it('reject 面的迟到那一发也不许替当前那一次说话（`.catch` 里那道守卫是独立一支）', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(0))
    await waitFor(() => expect(q['read:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(1))
    await waitFor(() => expect(q['read:乙.txt']?.length).toBeTruthy(), MOUNT_BUDGET)

    await flush(() => answer('read:甲.txt', Promise.reject(new Error('BOOM-迟到断了'))))
    expect(bodyText(), '当前那一发还在飞，那句不许由迟到那发的 reject 代挂').not.toContain('BOOM-迟到断了')

    await flush(() => answer('read:乙.txt', read('正文-乙乙')))
    expect(screen.getByText('正文-乙乙'), '迟到那发断了也不许吞掉当前结果').toBeTruthy()
  })
})

describe('§332 F1 四颗「在系统里打开」：失败回的是 resolve 的 {ok:false} ⇒ 必须各说一句', () => {
  it('工具栏📤：失败 ⇒ 那句上屏', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(dataDirBtn())
    await waitFor(() => expect(q['loc:.']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('loc:.', { ok: false, error: 'BOOM-位置打不开' }))
    expect(bodyText()).toContain('BOOM-位置打不开')
  })

  it('工具栏📤 读到 {ok:true} ⇒ 屏上零句（反向钉：判据写反就会挂「操作失败」）', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(dataDirBtn())
    await waitFor(() => expect(q['loc:.']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('loc:.', { ok: true }))
    expect(bodyText(), '成功不许顺手挂一句').not.toContain(L('fm.opFailed'))
  })

  it('行内 ↗ 那颗：失败有一句（改前只有 .catch＝safeHandle 的失败永远进不去）', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(externalAt(0))
    await waitFor(() => expect(q['ext:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('ext:甲.txt', { ok: false, error: 'BOOM-外部打不开' }))
    expect(bodyText()).toContain('BOOM-外部打不开')
  })

  it('行内 📍 那颗：失败有一句', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(locationAt(0))
    await waitFor(() => expect(q['loc:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('loc:甲.txt', { ok: false, error: 'BOOM-所在位置打不开' }))
    expect(bodyText()).toContain('BOOM-所在位置打不开')
  })

  it('面板内那颗 ↗：失败有一句（第四颗键）', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(eye(0))
    await waitFor(() => expect(q['read:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('read:甲.txt', read('正文-甲甲')))

    fireEvent.click(panelExternalBtn()) // 面板内那颗（无 title）
    await waitFor(() => expect(q['ext:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('ext:甲.txt', { ok: false, error: 'BOOM-面板里打不开' }))
    expect(bodyText()).toContain('BOOM-面板里打不开')
  })

  it('reject 面同一张脸（旧写法唯一活着的那半边不许被改坏）', async () => {
    await waitFor(() => expect(screen.getByText('甲.txt')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(locationAt(0))
    await waitFor(() => expect(q['loc:甲.txt']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('loc:甲.txt', Promise.reject(new Error('BOOM-通道断了'))))
    expect(bodyText()).toContain('BOOM-通道断了')
  })
})
