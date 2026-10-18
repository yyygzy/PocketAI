// 会话导出 PDF 的超时计时器（V4-Iter-200）：成功路径必须撤掉它，否则 60 秒后会拆掉池化窗口
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const TMP = path.resolve(__dirname, '../data/tmp/pdf-test')

const stub = vi.hoisted(() => ({
  mode: 'fast' as 'fast' | 'hang',
  created: 0,
  destroys: 0
}))

vi.mock('electron', () => ({
  app: { getPath: (kind: string) => (kind === 'temp' ? TMP : TMP) },
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      printToPDF: () =>
        stub.mode === 'hang'
          ? new Promise<Uint8Array>(() => undefined)
          : Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    }
    constructor() {
      stub.created++
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return false
    }
    destroy(): void {
      stub.destroys++
    }
  }
}))

import { htmlToPdf } from '../src/main/export/pdf'

/** 抽干微任务队列：桩里全是指向已 settle promise 的 await，不需要真时间 */
async function drain(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true })
  stub.mode = 'fast'
  stub.created = 0
  stub.destroys = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('导出 PDF 的超时计时器', () => {
  it('成功路径跑完后 60 秒：窗口还在（计时器已撤，不会事后把池化窗口拆掉）', async () => {
    const p = htmlToPdf('<html><body>hi</body></html>')
    await drain()
    const pdf = await p
    expect(pdf).toBeInstanceOf(Uint8Array)
    expect(stub.created).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stub.destroys).toBe(0)
  })

  it('反向对照：printToPDF 挂住时，60 秒到点确实销毁窗口并报超时（证明上面那条不是空真）', async () => {
    stub.mode = 'hang'
    const p = htmlToPdf('<html><body>x</body></html>')
    await drain()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(p).rejects.toThrow('PDF 转换超时（60s）')
    expect(stub.destroys).toBe(1)
  })

  it('两次成功导出复用同一扇窗口（串行队列的前提：池化窗口不能被自己拆掉）', async () => {
    await (async () => {
      const a = htmlToPdf('<html><body>1</body></html>')
      await drain()
      await a
      const b = htmlToPdf('<html><body>2</body></html>')
      await drain()
      await b
    })()
    expect(stub.created).toBe(1)
    expect(stub.destroys).toBe(0)
  })

  it('临时 HTML 用完即删（成功路径的 finally 里 unlinkSync 仍在）', async () => {
    const before = fs.readdirSync(TMP).length
    const p = htmlToPdf('<html><body>clean</body></html>')
    await drain()
    await p
    expect(fs.readdirSync(TMP).length).toBe(before)
  })

  it('形状扫描：那个超时计时器有句柄，且在 finally 里被撤', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main/export/pdf.ts'), 'utf-8')
    expect(src).toContain('timeoutTimer = setTimeout(')
    expect(src).toContain('clearTimeout(timeoutTimer)')
  })
})
