// V4-Iter-326①②③④ 挂载用例：沙箱这一屏「三种到货」与「迟到那一发」。
//
// 为什么必须真挂载：这四张脸都在响应到货**之后**的那几行——
//  · 「设为应用」那发：改前 `await updateSandboxMeta(...)` 的返回值一个字都不看，失败对象与 null 都被咽掉，
//    照样弹「已设为迷你应用」，而紧跟其后的 load() 又把 ⭐ 翻回去（屏上自己证伪自己）；
//  · 保存元数据那发：改前直接 onSaved() ⇒ 关面板、重载，还弹一句「元数据已保存」，库里一个字没改
//    （常态触发面：名称框与描述框改前没有 maxLength，而闸门是 60／200 字符）；
//  · 删除那发：改前不判 `ok`，删没删成都先把预览卸了；
//  · 预览那发：左栏每颗行在读盘时都不置灰，连点两行就是两发同时在飞，迟到那份会把后点的盖掉。
// 桥层用例证得了主进程回了什么，证不了界面把哪一份、哪句话摆上了屏。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { SandboxModule } from '../src/renderer/src/modules/sandbox/SandboxModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SandboxFileMeta } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''

const NAME: Record<string, string> = { f1: '探针页.html', f2: '另一页.html' }
const mk = (id: string, isApp: boolean): SandboxFileMeta => ({
  id,
  name: NAME[id]!,
  icon: '📦',
  description: '',
  isApp,
  size: 8,
  createdAt: 1
})
const F1 = mk('f1', false)
const F2 = mk('f2', false)

type Impl = (...a: any[]) => unknown

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
/** 一次交互可能打两发同名通道 ⇒ resolve 必须存队列（单槽会被后到的顶掉，迟到响应演不出来） */
const makeQueue = <T,>(): {
  impl: Impl
  answer: (n: number, v: T) => void
  settle: (n: number) => Promise<void>
  count: () => number
} => {
  const inflight: Deferred<T>[] = []
  const impl = (..._a: unknown[]): Promise<T> => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    inflight.push({ promise, resolve })
    return promise
  }
  return {
    impl,
    answer: (n, v) => inflight[n]!.resolve(v),
    settle: async (n) => {
      await inflight[n]!.promise
      await new Promise((r) => setTimeout(r, 0))
    },
    count: () => inflight.length
  }
}

const mountSandbox = (over: Record<string, Impl> = {}): Promise<void> => {
  stubPocketai({
    listSandboxFiles: () => [F1, F2],
    getSandboxFile: (id: string) => ({ meta: { ...mk(String(id), false), name: NAME[String(id)]! }, html: `<p>${id}</p>` }),
    deleteSandboxFile: () => ({ ok: true }),
    updateSandboxMeta: (_id: string, patch: { isApp?: boolean }) => ({ ...F1, ...patch }),
    createSandboxFile: () => F1,
    ...over
  })
  mountWithProviders(<SandboxModule />)
  return waitFor(() => expect(screen.queryByText('探针页.html')).toBeTruthy())
}

/** 打开某一行左栏的编辑面板（「删除／设为应用／保存」都只在这一格里）
 *  两行各有一颗「编辑」⇒ 必须按行定位（同 §315 那颗行内「合并」的取法） */
async function openEditor(name: string): Promise<void> {
  // 预览打开后文件名会同时出现在列表行与预览标题（后者是 div）⇒ 按角色取那一颗按钮才唯一
  const row = (screen.getByRole('button', { name }) as HTMLElement).closest('div') as HTMLElement
  fireEvent.click(within(row).getByText(L('miniapp.edit')))
  await waitFor(() => expect(bodyText()).toContain(L('miniapp.promote')))
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('§326②「设为应用」那发：三种到货要分开', () => {
  it('回失败对象 ⇒ 不许弹「已设为迷你应用」，原因要上屏', async () => {
    await mountSandbox({
      updateSandboxMeta: () => ({ ok: false, error: '沙箱通道断了' })
    })
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('miniapp.promote')))
    await waitFor(() => expect(bodyText()).toContain('沙箱通道断了'))
    expect(bodyText(), '没做成就不许说"已设为"').not.toContain(L('miniapp.promoted'))
  })

  it('回 null（库里已经没这条）⇒ 说那句"已经不在了"，既不报成功也不报失败原因', async () => {
    await mountSandbox({ updateSandboxMeta: () => null })
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('miniapp.promote')))
    await waitFor(() => expect(bodyText()).toContain(L('sandbox.gone')))
    expect(bodyText()).not.toContain(L('miniapp.promoted'))
  })

  it('反向对照：真的改成了 ⇒ 那句成功话术必须还在（判据不许把好的一发也挡掉）', async () => {
    await mountSandbox({ updateSandboxMeta: () => ({ ...F1, isApp: true }) })
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('miniapp.promote')))
    await waitFor(() => expect(bodyText()).toContain(L('miniapp.promoted')))
    expect(bodyText()).not.toContain(L('sandbox.gone'))
  })
})

describe('§326③ 保存元数据那一发：谎报「元数据已保存」那一张脸', () => {
  it('回失败对象 ⇒ 不许出现「元数据已保存」，编辑面板不许关（用户正写的字不能丢）', async () => {
    await mountSandbox({
      updateSandboxMeta: () => ({ ok: false, error: 'IPC_ARG_INVALID:名称不能大于 60 个字符' })
    })
    await openEditor('探针页.html')
    fireEvent.change(screen.getByDisplayValue('探针页.html'), { target: { value: '我改的名字' } })
    fireEvent.click(screen.getByText(L('common.save')))
    await waitFor(() => expect(bodyText()).toContain('IPC_ARG_INVALID:名称不能大于 60 个字符'))
    expect(bodyText(), '没改成功就不许说"已保存"').not.toContain(L('miniapp.metaSaved'))
    expect(screen.queryByText(L('common.save')), '面板不许被失败那一发关掉').toBeTruthy()
  })

  it('回 null ⇒ 那句"已经不在了"上屏，同样不许报成功', async () => {
    await mountSandbox({ updateSandboxMeta: () => null })
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('common.save')))
    await waitFor(() => expect(bodyText()).toContain(L('sandbox.gone')))
    expect(bodyText()).not.toContain(L('miniapp.metaSaved'))
  })

  it('反向对照：改成了 ⇒ 那句「元数据已保存」上屏、面板关掉', async () => {
    await mountSandbox({ updateSandboxMeta: () => ({ ...F1, name: '新名' }) })
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('common.save')))
    await waitFor(() => expect(bodyText()).toContain(L('miniapp.metaSaved')))
    expect(screen.queryByText(L('common.save'))).toBeNull()
  })
})

describe('§326④ 删除那一发：不判 ok 就先把预览卸了', () => {
  it('回 {ok:false} ⇒ 原因上屏，而正在预览的那一份不许被清掉', async () => {
    await mountSandbox({ deleteSandboxFile: () => ({ ok: false, error: '删除失败：文件正被占用' }) })
    fireEvent.click(screen.getByText('探针页.html'))
    await waitFor(() => expect(screen.queryByTitle('探针页.html')).toBeTruthy())
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('common.delete')))
    await waitFor(() => expect(bodyText()).toContain('删除失败：文件正被占用'))
    expect(
      screen.queryByTitle('探针页.html'),
      '没删掉却把预览清了＝把"删成了"演给用户看'
    ).toBeTruthy()
  })

  it('反向对照：真删掉了 ⇒ 预览退场', async () => {
    await mountSandbox({ deleteSandboxFile: () => ({ ok: true }) })
    fireEvent.click(screen.getByText('探针页.html'))
    await waitFor(() => expect(screen.queryByTitle('探针页.html')).toBeTruthy())
    await openEditor('探针页.html')
    fireEvent.click(screen.getByText(L('common.delete')))
    await waitFor(() => expect(screen.queryByTitle('探针页.html')).toBeNull())
  })
})

describe('§326⑤ 预览那发的归属：迟到那份不许盖掉后点的那一份', () => {
  it('连点两行、先发后到 ⇒ 屏上仍是后点那一行的内容', async () => {
    const q = makeQueue<{ meta: SandboxFileMeta; html: string }>()
    await mountSandbox({ getSandboxFile: q.impl })
    fireEvent.click(screen.getByText('探针页.html'))
    fireEvent.click(screen.getByText('另一页.html'))
    await waitFor(() => expect(q.count()).toBe(2))

    q.answer(1, { meta: { ...F2, name: '另一页.html' }, html: '<p>f2</p>' })
    await q.settle(1)
    expect(screen.queryByTitle('另一页.html')).toBeTruthy()

    q.answer(0, { meta: { ...F1, name: '探针页.html' }, html: '<p>f1</p>' })
    await q.settle(0)
    expect(screen.queryByTitle('探针页.html'), '旧那发迟到不许把预览改回探针页').toBeNull()
    expect(screen.queryByTitle('另一页.html')).toBeTruthy()
  })

  it('反向对照：单发预览自己必须能写屏', async () => {
    const q = makeQueue<{ meta: SandboxFileMeta; html: string }>()
    await mountSandbox({ getSandboxFile: q.impl })
    fireEvent.click(screen.getByText('另一页.html'))
    await waitFor(() => expect(q.count()).toBe(1))
    q.answer(0, { meta: { ...F2, name: '另一页.html' }, html: '<p>f2</p>' })
    await q.settle(0)
    expect(screen.queryByTitle('另一页.html')).toBeTruthy()
  })
})

describe('§326⑥ 闸门数字只有一份出处（输入框抄的是 schema 那两个常量）', () => {
  const read = (p: string): string =>
    fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

  it('沙箱这一屏与安装表单那两格都用标识符，不写字面量', () => {
    for (const p of [
      'src/renderer/src/modules/sandbox/SandboxModule.tsx',
      'src/renderer/src/modules/agent/components/HtmlBlockActions.tsx'
    ]) {
      const src = read(p)
      expect(src, p).toContain('import { SANDBOX_MAX_DESC_CHARS, SANDBOX_MAX_NAME_CHARS }')
      const nameGates = src.match(/maxLength=\{SANDBOX_MAX_NAME_CHARS\}/g) ?? []
      const descGates = src.match(/maxLength=\{SANDBOX_MAX_DESC_CHARS\}/g) ?? []
      expect(nameGates.length, `${p} 里名称框的 maxLength`).toBeGreaterThanOrEqual(1)
      expect(descGates.length, `${p} 里描述框的 maxLength`).toBeGreaterThanOrEqual(1)
      expect(src.match(/maxLength=\{(60|200)\}/g) ?? [], '不许在界面里抄第二份数字').toEqual([])
    }
  })

  it('接线闸门：三个消费点各有判据、预览那一发有代次（行为用例改不到源码时这里红）', () => {
    const src = read('src/renderer/src/modules/sandbox/SandboxModule.tsx')
    // 三处「设为应用／保存元数据」用 hasIpcFailed，删除那发成功侧也带 ok（形状不同、各数一次）
    expect((src.match(/if \(hasIpcFailed\(r\)\) \{/g) ?? []).length).toBe(3)
    expect((src.match(/if \(!r\.ok\) \{/g) ?? []).length, '删除那发要判 ok 并接管').toBe(1)
    expect((src.match(/const seq = \+\+previewSeqRef\.current/g) ?? []).length, '领号在 await 之前').toBe(1)
    expect((src.match(/if \(seq !== previewSeqRef\.current\) return/g) ?? []).length).toBe(1)
  })
})
