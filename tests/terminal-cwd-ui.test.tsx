// 终端工作目录 UI：回包带的 cwd 要显示出来；点它编辑、回车提交要用新目录重启 shell；
// 清空提交＝恢复默认（startTerminal 不传参）；无效目录由主进程退档，界面显示回包的真实落点。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TerminalModule } from '../src/renderer/src/modules/terminal/TerminalModule'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

let starts: Array<{ cwd?: string }> = []
let nextEpoch = 1
let cwdReply = '/default/workdir'

beforeEach(() => {
  starts = []
  nextEpoch = 1
  cwdReply = '/default/workdir'
  stubPocketai({
    startTerminal: (cwd?: string) => {
      starts.push({ cwd })
      return Promise.resolve({ ok: true, sessionId: 7, epoch: nextEpoch++, cwd: cwdReply })
    },
    onTerminalOutput: () => () => {},
    killTerminal: () => Promise.resolve({ ok: true }),
    terminalInput: () => Promise.resolve({ ok: true })
  })
})

afterEach(() => { cleanup() })

describe('终端工作目录 UI', () => {
  it('启动回包的 cwd 显示在界面上，默认启动不传参', async () => {
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(screen.getByTestId('terminal-cwd').textContent).toBe(cwdReply))
    expect(starts[0]?.cwd).toBeUndefined()
  })

  it('点击目录进入编辑，输入新路径回车后用该路径重启 shell', async () => {
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(screen.getByTestId('terminal-cwd').textContent).toBe(cwdReply))
    const startCount = starts.length
    fireEvent.click(screen.getByTestId('terminal-cwd'))
    const input = screen.getByTestId('terminal-cwd-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/custom/path' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(starts.length).toBeGreaterThan(startCount)
    expect(starts[starts.length - 1]?.cwd).toBe('/custom/path')
  })

  it('清空路径提交＝恢复默认（startTerminal 不再传 cwd）', async () => {
    cwdReply = '/custom/path'
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(screen.getByTestId('terminal-cwd').textContent).toBe('/custom/path'))
    fireEvent.click(screen.getByTestId('terminal-cwd'))
    const input = screen.getByTestId('terminal-cwd-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(starts[starts.length - 1]?.cwd).toBeUndefined()
    // 已经回到默认落点 ⇒ 不该再有「恢复默认」按钮
    expect(screen.queryByText(L('terminal.resetCwd'))).toBeNull()
  })

  it('主进程退档后界面显示回包的真实落点，不显示用户请求的无效路径', async () => {
    cwdReply = '/fallback/home'
    mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(screen.getByTestId('terminal-cwd').textContent).toBe('/fallback/home'))
    fireEvent.click(screen.getByTestId('terminal-cwd'))
    const input = screen.getByTestId('terminal-cwd-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/nonexistent' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await waitFor(() => expect(screen.getByTestId('terminal-cwd').textContent).toBe('/fallback/home'))
  })
})
