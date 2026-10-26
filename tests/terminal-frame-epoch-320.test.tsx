// V4-Iter-320：终端那扇窗口里「帧属于哪一轮」与「命令到底送出去没」（真挂载 TerminalModule）
//
// 三条现场，逐条对着源码读出来才写的（file:line 是本批改前的形状）：
//  · ① `TerminalModule.tsx:80` 的 `sendInput` 对 `terminalInput` 的信封**一个判据都没有**，只挂 `.catch`。
//    主进程 `inputTerminal`（terminal-service.ts:76-92）两种拒绝——管道不可用／deny 名单拦下——都是
//    `safeHandle` 转成的 **resolve 值** `{ok:false}`（§196 那一族），`.catch` 天生接不到 ⇒
//    用户按回车：输入被清空、命令进历史、屏上零反应，看着就像"已经执行了"。
//  · ② 旧代码 `await startTerminal()` **之后**才 `onTerminalOutput(...)`：主进程在同一个同步 handler 里
//    spawn 完就回，而 shell 的首字节实测 11.7~27.7ms（本机 cmd.exe 三轮，data/tmp/probe-320-out.txt）——
//    预算只有十几毫秒，渲染端正在挂首屏或机器被压满时这一帧就没人听。
//    顺带一条同族的漏：订阅挂在 await 之后 ⇒ 卸载赶在它之前时 cleanup 里 `unsub` 还是 undefined，
//    摘不到东西；之后回复落地、监听器注册，而那一轮的 `mounted` 早就是 false ⇒ 每被打断一次
//    就漏一个永不摘掉的 ipcRenderer 监听器（§304 那一族在渲染端的形状）。先挂听众一并把这条关掉。
//  · ③ 载荷里的 `sessionId` 是 webContents id，**同一窗口重开时它不变**（重开有三个入口：切语言（effect
//    deps 是 `[t]`）、卸载再挂、dev 的 StrictMode 双跑），而 `startTerminal` 一进来就 `killTerminal(ownerId)`：
//    旧那台 shell 的 `'exit'` 是异步的，与新一轮的监听器注册赛跑。旧帧一旦落进新屏，
//    `setRunning(false)` ⇒ 输入框从此 disabled、回车无效，屏上还多出一个退出码。
//
// 修法＝① 判信封（失败那句走输出区那行红字、四语包装）② 听众挂在发起之前 ③ 主进程给每轮一个单调
// epoch、渲染端只收本轮的，轮次号还没落地时到达的帧先暂存（有界），落地后按 epoch 回放。
//
// 每条反面都配正向对照（成功路径照常清空输入并记历史、本轮的 exit 照常生效），挡"守卫写成恒不收下"。
// ② 那条把 startTerminal 挂住不 resolve，正是"先挂听众"唯一能被量到的方式。
// 不判 sessionId 是有意的：推送目标是 `startTerminal(e.sender)` 那一扇窗，跨窗帧到不了这里，
// 而 epoch 是全局单调的，两扇窗也不会撞号——加一道判据就是没人能走到的分支。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TerminalModule } from '../src/renderer/src/modules/terminal/TerminalModule'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const failedLine = (msg: string): string => L('terminal.sendFailed').replace('{msg}', msg)

interface Frame { sessionId: number; epoch: number; stream: 'stdout' | 'stderr' | 'exit'; data: string }

/** StrictMode 会「订阅→卸载→再订阅」⇒ 记全部订阅者；死掉那一次有组件自己的 `mounted` 吞掉 */
let subs: Array<(f: Frame) => void> = []
let killCalls = 0
/** startTerminal 的回复由用例自己放行（②③ 都要在"回复还没到"的时刻推帧） */
let pendingStarts: Array<(v: { ok: true; sessionId: number; epoch: number }) => void> = []
let nextEpoch = 1
/** terminalInput 的返回值由用例逐条换（① 要在同一次挂载里先成功、再被拦） */
let inputReply: unknown = { ok: true }

const input = (): HTMLInputElement => screen.getByRole('textbox') as HTMLInputElement
const screenText = (): string => (document.querySelector('pre')?.textContent ?? '')
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const typeAndEnter = async (text: string): Promise<void> => {
  fireEvent.change(input(), { target: { value: text } })
  fireEvent.keyDown(input(), { key: 'Enter' })
  await settle()
}

beforeEach(() => {
  subs = []
  killCalls = 0
  pendingStarts = []
  nextEpoch = 1
  inputReply = { ok: true }
  stubPocketai({
    startTerminal: () => new Promise((resolve) => { pendingStarts.push(resolve) }),
    onTerminalOutput: (cb: (f: Frame) => void) => {
      subs.push(cb)
      return () => { subs = subs.filter((x) => x !== cb) }
    },
    killTerminal: () => {
      killCalls += 1
      return Promise.resolve({ ok: true })
    },
    terminalInput: () => Promise.resolve(inputReply)
  })
})

afterEach(() => { cleanup() })

/** 放行挂着的 startTerminal（StrictMode 那一对共用同一个轮次号：死掉那次自己吞了） */
const releaseStart = async (sessionId = 42): Promise<number> => {
  const epoch = nextEpoch++
  await act(async () => {
    pendingStarts.forEach((resolve) => resolve({ ok: true, sessionId, epoch }))
    pendingStarts = []
  })
  return epoch
}

/** 把帧投给当前挂着的所有监听者（真 Electron 里这一步是 webContents.send） */
const deliver = async (epoch: number, stream: Frame['stream'], data: string): Promise<void> => {
  const frame: Frame = { sessionId: 42, epoch, stream, data }
  await act(async () => { subs.forEach((cb) => cb(frame)) })
}

describe('§320 ①：命令没送出去时，屏上要说、输入要留着、历史要干净', () => {
  it('先真发一条（清空＋进历史），再发一条被 deny 拦下的：红字出现、输入没被清空、也没混进历史', async () => {
    mountWithProviders(<TerminalModule />)
    await releaseStart()

    inputReply = { ok: true }
    await typeAndEnter('echo hi')
    expect(screenText(), '成功时不许冒那句红字').not.toContain(L('terminal.sendFailed').replace('{msg}', ''))
    expect(input().value, '成功送出去的才该清空输入框').toBe('')

    inputReply = { ok: false, error: '命令被安全策略拦截（BLOCKED_FORMAT）' }
    await typeAndEnter('format c:')
    expect(screenText()).toContain(failedLine('命令被安全策略拦截（BLOCKED_FORMAT）'))
    expect(input().value, '被拦下的那条要留在输入框里，用户能改能重试').toBe('format c:')

    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    await settle()
    expect(input().value, '↑ 取回的应是那条真发出去的，被拦的不该进历史').toBe('echo hi')

    // 红字不许赖屏：下一条真送出去了，那句就该撤掉
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    await settle()
    inputReply = { ok: true }
    await typeAndEnter('dir')
    expect(screenText()).not.toContain('命令没送出去')
  })

  it('同一条判据要认第二种拒绝「终端未运行」（不是只认 deny 那句）', async () => {
    mountWithProviders(<TerminalModule />)
    await releaseStart()
    inputReply = { ok: false, error: '终端未运行' }
    await typeAndEnter('dir')
    expect(screenText()).toContain(failedLine('终端未运行'))
    expect(input().value).toBe('dir')
  })

  it('启动那一支换了写法（`!r.ok`→判信封）但形状没变：失败仍写进那行红字、不挂 running', async () => {
    stubPocketai({
      startTerminal: () => new Promise((resolve) => { pendingStarts.push(resolve) }),
      onTerminalOutput: (cb: (f: Frame) => void) => {
        subs.push(cb)
        return () => { subs = subs.filter((x) => x !== cb) }
      },
      killTerminal: () => Promise.resolve({ ok: true }),
      terminalInput: () => Promise.resolve({ ok: true })
    })
    subs = []
    pendingStarts = []
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(subs.length).toBeGreaterThan(0))
    await act(async () => {
      pendingStarts.forEach((resolve) => resolve({ ok: false, error: 'PROBE-终端启动失败：spawn 挂了' } as never))
      pendingStarts = []
    })
    await settle()
    expect(screenText()).toContain('PROBE-终端启动失败：spawn 挂了')
    expect(input().disabled, '没起来就不该把 running 当真').toBe(true)
    // 没有回复里的轮次号 ⇒ 之后到达的帧一律不许进屏（屏上只有那句红字）
    await deliver(1, 'stdout', 'PROBE-AFTER-FAIL')
    expect(screenText()).not.toContain('PROBE-AFTER-FAIL')
  })

  it('反向对照：没注册通道那种真故障（reject）仍只留 console 痕，不变成红字（§224 的口径没被改动）', async () => {
    stubPocketai({
      startTerminal: () => new Promise((resolve) => { pendingStarts.push(resolve) }),
      onTerminalOutput: (cb: (f: Frame) => void) => {
        subs.push(cb)
        return () => { subs = subs.filter((x) => x !== cb) }
      },
      killTerminal: () => Promise.resolve({ ok: true }),
      terminalInput: () => Promise.reject(new Error('No handler registered'))
    })
    subs = []
    pendingStarts = []
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(String(a[0])) })
    mountWithProviders(<TerminalModule />)
    await releaseStart()
    await typeAndEnter('dir')
    expect(screenText(), 'reject 不该冒出"命令没送出去"那句').not.toContain('命令没送出去')
    expect(warns.join('\n')).toContain('terminal.terminalInput')
    spy.mockRestore()
  })
})

describe('§320 ②：听众挂在发起之前，回复落地那刻补回暂存的首帧', () => {
  it('回复还没到的那段里到达的帧不丢：先不进屏，轮次号一落地就画出来', async () => {
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(subs.length).toBeGreaterThan(0))
    // 此刻 startTerminal 的回复仍被用例挂住——旧代码在这时还没订阅，这一帧必然没人听
    await deliver(1, 'stdout', 'Microsoft Windows [版本 10.0.26100]\r\n')
    expect(screenText(), '轮次号还没落地时先不进屏（分不清归属）').not.toContain('Microsoft Windows')
    await releaseStart()
    expect(screenText()).toContain('Microsoft Windows')
  })

  it('正向对照：轮次号落地之后的帧照常直接进屏', async () => {
    mountWithProviders(<TerminalModule />)
    await releaseStart()
    await deliver(1, 'stdout', 'PROBE-PROMPT>')
    expect(screenText()).toContain('PROBE-PROMPT>')
  })

  it('卸载打断在途的 startTerminal：不许留下没人摘的监听器（改前的形状里订阅发生在 await 之后）', async () => {
    const h = mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(subs.length).toBeGreaterThan(0))
    h.unmount() // 此刻 startTerminal 的回复仍被用例挂住——旧代码里 unsub 还是 undefined，cleanup 摘不到东西
    await settle()
    expect(subs.length, '订阅要挂上就得挂早、卸载就得摘干净').toBe(0)
    await releaseStart()
    await settle()
    expect(subs.length, '迟到的回复落地之后不许再冒出一个永远没人摘的监听器').toBe(0)
  })

  it('暂存有界：startTerminal 一直不回来时不许无限堆（越界丢最旧的）', async () => {
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(subs.length).toBeGreaterThan(0))
    for (let i = 0; i < 130; i++) await deliver(1, 'stdout', `f${i};`)
    await releaseStart()
    const text = screenText()
    expect(text, '回放的是最近那一截').toContain('f129;')
    expect(text.includes('f0;'), '最旧那几帧已被上限挤掉').toBe(false)
    expect(text.split(';').length - 1).toBeLessThanOrEqual(100)
  })
})

describe('§320 ③：重开时旧一轮的迟到帧不许写进新一轮的屏', () => {
  it('旧 shell 迟到的 exit 落不进新屏：running 不被误置、退出码不画进来、输入框照常能用', async () => {
    const first = mountWithProviders(<TerminalModule />)
    const oldEpoch = await releaseStart()
    first.unmount()
    await settle()
    expect(killCalls, '卸载时确实发了 kill（旧 shell 会被杀，它的 exit 帧随后才到）').toBeGreaterThan(0)

    mountWithProviders(<TerminalModule />)
    const newEpoch = await releaseStart()
    expect(newEpoch).not.toBe(oldEpoch)

    await deliver(oldEpoch, 'exit', 'STALE-EXIT-CODE')
    expect(input().disabled, '旧轮的 exit 把新一轮的 running 打下去了').toBe(false)
    expect(screenText()).not.toContain('STALE-EXIT-CODE')

    // 正向对照：本轮的 exit 照常生效（判据不是"恒不收下"）
    await deliver(newEpoch, 'exit', 'THIS-EXIT-CODE')
    await settle()
    expect(input().disabled, '本轮的退出必须被收下——徽标转成未运行、输入框禁用').toBe(true)
    expect(screenText()).toContain('THIS-EXIT-CODE')
  })
})
