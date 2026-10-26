// 终端缓冲被裁时，界面上必须说出来（V4-Iter-160 B95 判定：`terminal.outputTruncated` 属提示缺失，接回）
//
// 判定依据：`TerminalModule.tsx` 的 MAX_OUTPUT=50000 会**静默**丢掉最旧的一段（保留最后 40000 字符），
// 而同类场景在文件模块里是有话的（`fm.truncated`，`FilesModule.tsx:328`）⇒ 这把键不是改名遗留、也不是冗余，
// 是当年写好文案没接线。这里把它接上并钉住：不裁不许出现，裁了必须出现。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, cleanup, act, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TerminalModule, appendOutput } from '../src/renderer/src/modules/terminal/TerminalModule'
import { zh } from '../src/renderer/src/i18n/zh'

// StrictMode 下组件会「订阅→卸载→再订阅」，只记最后一个回调会撞上"打到已卸载的那个"这种竞态
// ⇒ 记下所有订阅者，测试时全打一遍：活的会生效，死的那次有 `if (!mounted) return` 自己吞掉
// §320：帧现在带轮次号 epoch，桩回的 startTerminal 也带——两边对不上就会被归属判据丢掉（那条判据由
// tests/terminal-frame-epoch-320.test.tsx 专门演，这里只喂"同一轮"的帧，管的是截断那一句话）
type Frame = { sessionId: number; epoch: number; stream: string; data: string }
const EPOCH = 7
let subs: Array<(p: Frame) => void> = []
const push = async (p: Omit<Frame, 'sessionId' | 'epoch'>): Promise<void> => {
  const frame: Frame = { sessionId: 42, epoch: EPOCH, ...p }
  await act(async () => { subs.forEach((cb) => cb(frame)) })
}

beforeEach(() => {
  subs = []
  stubPocketai({
    startTerminal: async () => ({ ok: true, sessionId: 42, epoch: EPOCH }),
    onTerminalOutput: (cb: (p: Frame) => void) => {
      subs.push(cb)
      return () => { subs = subs.filter((x) => x !== cb) }
    },
    killTerminal: async () => ({ ok: true }),
    terminalInput: async () => ({ ok: true })
  })
})

afterEach(() => cleanup())

describe('终端截断提示', () => {
  it('纯函数：越线才 clipped，且裁完只剩尾部', () => {
    const small = appendOutput('aaa', 'bbb')
    expect(small).toEqual({ text: 'aaabbb', clipped: false })
    const big = appendOutput('x'.repeat(49_000), 'y'.repeat(5_000))
    expect(big.clipped).toBe(true)
    expect(big.text.length).toBe(40_000)
    expect(big.text.startsWith('x')).toBe(true) // 丢的是最旧的一段头部……
    expect(big.text.endsWith('y'.repeat(5_000))).toBe(true) // ……留的一定包含最新那段
  })

  it('没裁到时不许出现那句话（反向对照，防"永远挂在输出区"）', async () => {
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(subs.length).toBeGreaterThan(0))
    await push({ stream: 'stdout', data: 'echo hi\n' })
    const pre = document.querySelector('pre')
    expect(pre?.textContent).toContain('echo hi') // 先证明这条数据真的走到了渲染，否则下一条断言是空转
    expect(screen.queryByText(zh['terminal.outputTruncated'])).toBeNull()
  })

  it('真裁到了，那句话就出现在输出区里', async () => {
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(subs.length).toBeGreaterThan(0))
    await push({ stream: 'stdout', data: 'z'.repeat(60_000) })
    expect(await screen.findByText(zh['terminal.outputTruncated'])).toBeTruthy()
  })
})
