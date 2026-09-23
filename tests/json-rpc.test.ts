// StdioJsonRpcClient 协议层测试
//
// 策略：mock node:child_process 的 spawn，返回用 PassThrough 三流构造的 fake 子进程，
// 客户端写 proc.stdin / 读 proc.stdout 都通过流往返；server 响应直接 stdout.write 注入。
// 不依赖真实子进程，纯协议契约验证：spawn/请求响应/错误转发/超时/通知分发/
// 进程 exit 拒绝 pending / 进程 error 拒绝 pending / 通道已关闭拒绝新请求 / stdin 写失败。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

// fake 子进程：三流均用 PassThrough，监听器用 Map 维护
class FakeChild {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 12345
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  kill = vi.fn()

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event)!.push(handler)
    return this
  }
  once(event: string, handler: (...args: unknown[]) => void): this {
    // 仅触发一次：调用后从 listeners 中移除
    const wrapped = (...args: unknown[]) => {
      handler(...args)
      const arr = this.listeners.get(event)
      if (arr) {
        const idx = arr.indexOf(wrapped)
        if (idx >= 0) arr.splice(idx, 1)
      }
    }
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event)!.push(wrapped)
    return this
  }
  emit(event: string, ...args: unknown[]): boolean {
    const arr = this.listeners.get(event) ?? []
    for (const h of arr) h(...args)
    return arr.length > 0
  }
}

const mocks = vi.hoisted(() => ({
  children: [] as FakeChild[],
  reset() { this.children = [] }
}))

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild()
    mocks.children.push(c)
    return c as unknown as ChildProcessWithoutNullStreams
  }
}))

import { StdioJsonRpcClient } from '../src/main/mcp/json-rpc'

let client: StdioJsonRpcClient

beforeEach(() => {
  mocks.reset()
  // 50ms 超时，便于测试快速触发
  client = new StdioJsonRpcClient({ command: 'fake', args: [], requestTimeout: 50 })
})

afterEach(async () => {
  // 强制清理，避免 pending timer 漏到后续用例
  await client.shutdown().catch(() => {})
})

function currentChild(): FakeChild {
  const c = mocks.children[mocks.children.length - 1]
  if (!c) throw new Error('no child spawned')
  return c
}

/** 模拟 server 从 stdout 回发一个 JSON 对象 */
function serverSends(obj: unknown): void {
  currentChild().stdout.write(JSON.stringify(obj) + '\n')
}

/** 读取 client 已写入 stdin 的所有 NDJSON 行（流式拉空） */
function readSentRequests(): unknown[] {
  const child = currentChild()
  const buf: Buffer[] = []
  // PassThrough 的 read() 返回 Buffer | null，循环拉空内部缓冲
  while (true) {
    const chunk = child.stdin.read() as Buffer | null
    if (!chunk) break
    buf.push(chunk)
  }
  if (buf.length === 0) return []
  return Buffer.concat(buf).toString().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

describe('StdioJsonRpcClient - spawn', () => {
  it('spawn 成功后 pid 可读、transportClosed 为 false', async () => {
    await client.spawn()
    expect(client.pid).toBe(12345)
    expect(client.transportClosed).toBe(false)
  })
})

describe('StdioJsonRpcClient - request', () => {
  it('request 写入 NDJSON 请求（jsonrpc/method/id 字段齐全）', async () => {
    await client.spawn()
    // 不 await：让 request 进入 pending，便于捕获 stdin 写入
    const p = client.request('tools/list', { cursor: 'x' }).catch(() => undefined)
    // 让 stdin 写入流转到可读侧（PassThrough 同步）
    await Promise.resolve()
    const sent = readSentRequests()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', method: 'tools/list', params: { cursor: 'x' } })
    expect(typeof (sent[0] as { id: number }).id).toBe('number')
    // 响应让 pending resolve，避免 timer 残留
    serverSends({ jsonrpc: '2.0', id: (sent[0] as { id: number }).id, result: { ok: 1 } })
    await p
  })

  it('收到 result 响应时 resolve(result)', async () => {
    await client.spawn()
    const p = client.request<{ tools: string[] }>('tools/list')
    await Promise.resolve()
    const sent = readSentRequests()[0] as { id: number }
    serverSends({ jsonrpc: '2.0', id: sent.id, result: { tools: ['t1', 't2'] } })
    await expect(p).resolves.toEqual({ tools: ['t1', 't2'] })
  })

  it('收到 error 响应时 reject 并携带 code 与 message', async () => {
    await client.spawn()
    const p = client.request('tools/call', { name: 'bad' })
    await Promise.resolve()
    const sent = readSentRequests()[0] as { id: number }
    serverSends({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32602, message: 'invalid params' }
    })
    await expect(p).rejects.toThrow(/invalid params.*code=-32602/)
  })

  it('超时后 reject 并携带 method 与 timeout 毫秒数', async () => {
    await client.spawn()
    const p = client.request('slow/method', undefined, 30)
    await expect(p).rejects.toThrow(/JSON-RPC 请求超时: slow\/method \(30ms\)/)
  })
})

describe('StdioJsonRpcClient - notify / onNotification', () => {
  it('notify 写入 NDJSON 通知（无 id 字段），不等响应', async () => {
    await client.spawn()
    client.notify('initialized', { x: 1 })
    await Promise.resolve()
    const sent = readSentRequests()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', method: 'initialized', params: { x: 1 } })
    expect('id' in (sent[0] as object)).toBe(false)
  })

  it('onNotification 接收 server 推送的通知（无 id 的消息）', async () => {
    await client.spawn()
    const received: unknown[] = []
    client.onNotification((n) => received.push(n))
    serverSends({ jsonrpc: '2.0', method: 'progress', params: { pct: 50 } })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ method: 'progress', params: { pct: 50 } })
  })
})

describe('StdioJsonRpcClient - 异常路径', () => {
  it('进程 exit 拒绝所有 pending 请求（携带 code/signal）', async () => {
    await client.spawn()
    const p1 = client.request('m1').catch((e: Error) => e)
    const p2 = client.request('m2').catch((e: Error) => e)
    await Promise.resolve()
    // 模拟进程退出
    currentChild().emit('exit', 1, 'SIGTERM')
    const [e1, e2] = await Promise.all([p1, p2])
    expect((e1 as Error).message).toMatch(/MCP 进程退出.*code=1.*signal=SIGTERM/)
    expect((e2 as Error).message).toMatch(/MCP 进程退出.*code=1.*signal=SIGTERM/)
    expect(client.transportClosed).toBe(true)
  })

  it('进程 error 拒绝所有 pending 请求（携带 err.message）', async () => {
    await client.spawn()
    const p1 = client.request('m1').catch((e: Error) => e)
    const p2 = client.request('m2').catch((e: Error) => e)
    await Promise.resolve()
    currentChild().emit('error', new Error('ENOENT spawn not found'))
    const [e1, e2] = await Promise.all([p1, p2])
    expect((e1 as Error).message).toBe('进程错误: ENOENT spawn not found')
    expect((e2 as Error).message).toBe('进程错误: ENOENT spawn not found')
    expect(client.transportClosed).toBe(true)
  })

  it('通道已关闭时新 request 立即 reject', async () => {
    await client.spawn()
    currentChild().emit('exit', 0, null)
    expect(client.transportClosed).toBe(true)
    await expect(client.request('any')).rejects.toThrow(/JSON-RPC 通道已关闭/)
  })
})
