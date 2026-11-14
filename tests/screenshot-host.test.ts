// 常驻截图宿主（Windows）的可测面
//
// 为什么要有这个宿主：真机实测每次拉起 powershell.exe 约 5.7–7.4s，Add-Type 编译 C# 还要
// 2.6–3.1s，热键到附件 13–27s 里大头就在这里。宿主只做一次性启动/编译，之后用 stdin/stdout
// 逐行 JSON 收发命令。这里钉的是协议里最容易回归的几处：
//  · 分帧：一次 chunk 可能只有半行，也可能混入 Add-Type 的噪音；
//  · 编码：-EncodedCommand 要 base64(UTF-16LE)，且命令行走 CreateProcess 的 32K 上限；
//  · 脚本语义：热键瞬间的 targetHwnd 优先、浮窗命中测试、兜底前先通知主进程藏浮窗。
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => require('node:os').tmpdir(),
    getAppPath: () => process.cwd()
  }
}))

import { buildHostScript, encodeHostScript, takeHostLines } from '../src/main/screenshot-host'

describe('宿主行协议', () => {
  it('只解析完整行；半行留到下一次；非 JSON 噪音丢弃', () => {
    const first = takeHostLines(
      'Add-Type warning: something\r\n{"event":"ready"}\n{"id":1,"ok":true,"width":64,"hei'
    )
    expect(first.messages).toEqual([{ event: 'ready' }])
    expect(first.rest).toBe('{"id":1,"ok":true,"width":64,"hei')

    const second = takeHostLines(first.rest + 'ght":32}\n')
    expect(second.messages).toEqual([{ id: 1, ok: true, width: 64, height: 32 }])
    expect(second.rest).toBe('')
  })

  it('单行坏 JSON 不拖垮同批其它消息', () => {
    const { messages } = takeHostLines('{"event":"ready"}\n{bad json}\n{"event":"fallback","id":2}\n')
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({ event: 'fallback', id: 2 })
  })

  it('空 chunk 不产生消息', () => {
    expect(takeHostLines('')).toEqual({ messages: [], rest: '' })
  })
})

describe('宿主启动脚本', () => {
  it('-EncodedCommand 是 base64(UTF-16LE)，解码后可还原脚本', () => {
    const script = buildHostScript()
    const encoded = encodeHostScript(script)
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script)
  })

  it('编码后长度在 CreateProcess 命令行 32K 上限内', () => {
    expect(encodeHostScript(buildHostScript()).length).toBeLessThan(30_000)
  })

  it('启动后先发 ready，再从 stdin 逐行读命令', () => {
    const script = buildHostScript()
    expect(script).toContain("@{ event = 'ready' }")
    expect(script).toContain('[Console]::In.ReadLine()')
    expect(script).toContain("$req.cmd -eq 'foreground'")
    expect(script).toContain("$req.cmd -eq 'capture'")
  })

  it('targetHwnd 优先于捕获时的前台（浮窗上屏不影响取源）', () => {
    const script = buildHostScript()
    expect(script).toContain('$req.targetHwnd')
    expect(script).toContain('$req.popupHwnd')
    expect(script).toContain('GetForegroundWindow')
    expect(script).toContain('WindowFromPoint')
    expect(script).toContain('GetAncestor')
    expect(script).toContain('IsWindowVisible')
  })

  it('兜底 CopyFromScreen 前先发 fallback，让主进程藏掉浮窗', () => {
    const script = buildHostScript()
    expect(script).toContain("event = 'fallback'")
    expect(script).toContain('Start-Sleep -Milliseconds 250')
    expect(script).toContain('CopyFromScreen')
  })

  it('PrintWindow 用 PW_RENDERFULLCONTENT=2，并按 DWM 可见边界裁边', () => {
    const script = buildHostScript()
    expect(script).toContain('PrintWindow($hwnd, $hdc, 2)')
    expect(script).toContain('DwmGetWindowAttribute($hwnd, 9')
    expect(script).toContain('SetProcessDpiAwarenessContext')
  })
})
